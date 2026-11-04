import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURB_MARK } from "../../brand.js";
import { login, logout, pkceChallenge } from "./auth.js";
import {
  credentialsPath,
  ensureCredentials,
  projectKeysPath,
  readCredentials,
  readProjectKeys,
  storeProjectKey,
  writeCredentials,
} from "./credentials.js";
import { type FakeCloud, fakeCredentials, startFakeCloud } from "./fake-cloud.test-support.js";

let cloud: FakeCloud;
let dir: string;
let path: string;

beforeEach(async () => {
  cloud = await startFakeCloud();
  dir = mkdtempSync(join(tmpdir(), "curb-auth-"));
  path = join(dir, "curb", "credentials.json");
});

afterEach(async () => {
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The token endpoint, holding the server half of PKCE: it accepts only the verifier whose S256 matches. */
function tokenRoute(challenge: () => string, extra: Record<string, unknown> = {}) {
  cloud.route("POST /api/cli/token", (request) => {
    const { code, code_verifier } = request.json() as { code: string; code_verifier: string };
    if (code !== "code-1" || pkceChallenge(code_verifier) !== challenge()) {
      return { status: 400, body: { error: "invalid code", error_code: "INVALID_GRANT" } };
    }
    return {
      body: {
        ...extra,
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 2_000_000_000,
        supabaseUrl: cloud.url,
        supabaseAnonKey: "anon-key",
        platformApiUrl: `${cloud.url}/`,
        webUrl: cloud.url,
        user: { id: "user-1", email: "dev@example.com" },
      },
    };
  });
}

describe("curb login", () => {
  it("runs the loopback PKCE flow, ignores a callback with the wrong state, and stores 0600 credentials", async () => {
    let signIn: URL | undefined;
    tokenRoute(() => signIn?.searchParams.get("code_challenge") ?? "");
    const lines: string[] = [];

    const { credentials, projectKey } = await login({
      webUrl: cloud.url,
      path,
      log: (line) => lines.push(line),
      open: (url) => {
        signIn = new URL(url);
        const port = signIn.searchParams.get("port");
        const state = signIn.searchParams.get("state");
        void (async () => {
          const forged = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=forged`);
          expect(forged.status).toBe(400);
          const real = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=${state}`, { redirect: "manual" });
          expect(real.status).toBe(302);
        })();
      },
    });

    expect(signIn?.pathname).toBe("/cli/login");
    expect(signIn?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Asked for no key: the sign-in page offers no project and the web creates none.
    expect(signIn?.searchParams.has("project_key")).toBe(false);
    expect(projectKey).toBeNull();
    expect(credentials.platformApiUrl).toBe(cloud.url);
    expect(readCredentials(path)?.user.email).toBe("dev@example.com");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lines.some((line) => line.includes(signIn?.href ?? "missing"))).toBe(true);
  });

  /** A login whose browser side allows at once, as the consent page's Allow does. */
  function allowAtOnce(seen: { url?: URL }) {
    return (url: string) => {
      seen.url = new URL(url);
      void fetch(`http://127.0.0.1:${seen.url.searchParams.get("port")}/callback?code=code-1&state=${seen.url.searchParams.get("state")}`, { redirect: "manual" });
    };
  }

  it("asks for a project API key with this computer's name and returns it with where it lives", async () => {
    const seen: { url?: URL } = {};
    tokenRoute(() => seen.url?.searchParams.get("code_challenge") ?? "", {
      api_key: "sk-kug-proj_lu_0000000000000001_secret",
      key_id: 100,
      org_id: "org_pub_acme",
      org_name: "Acme",
      project_id: "prj_pub_voice",
      project_name: "Voice",
    });

    const { projectKey } = await login({
      webUrl: cloud.url,
      path,
      log: () => {},
      open: allowAtOnce(seen),
      requestProjectKey: true,
      deviceName: "Studio Mac",
    });

    expect(seen.url?.searchParams.get("project_key")).toBe("1");
    expect(seen.url?.searchParams.get("device_name")).toBe("Studio Mac");
    expect(projectKey).toEqual({
      apiKey: "sk-kug-proj_lu_0000000000000001_secret",
      keyId: 100,
      orgId: "org_pub_acme",
      orgName: "Acme",
      projectId: "prj_pub_voice",
      projectName: "Voice",
    });
  });

  it("answers no key, without failing, from a web that does not issue one yet", async () => {
    const seen: { url?: URL } = {};
    tokenRoute(() => seen.url?.searchParams.get("code_challenge") ?? "");

    const { credentials, projectKey } = await login({ webUrl: cloud.url, path, log: () => {}, open: allowAtOnce(seen), requestProjectKey: true });

    expect(projectKey).toBeNull();
    expect(credentials.user.email).toBe("dev@example.com");
  });

  it("refuses a key that comes without where it lives, stores nothing and never prints the key", async () => {
    const seen: { url?: URL } = {};
    tokenRoute(() => seen.url?.searchParams.get("code_challenge") ?? "", { api_key: "sk-kug-proj_never-printed", key_id: 100 });

    const error = await login({ webUrl: cloud.url, path, log: () => {}, open: allowAtOnce(seen), requestProjectKey: true })
      .then(() => null, (caught: Error) => caught);

    expect(error?.message).toMatch(/answered an API key without org_id, org_name, project_id, project_name; the server and this CLI disagree/);
    expect(error?.message).not.toContain("never-printed");
    expect(readCredentials(path)).toBeNull();
  });

  it("fails with a clear message when the browser cancels", async () => {
    await expect(
      login({
        webUrl: cloud.url,
        path,
        log: () => {},
        open: (url) => {
          const signIn = new URL(url);
          void fetch(
            `http://127.0.0.1:${signIn.searchParams.get("port")}/callback?error=access_denied&state=${signIn.searchParams.get("state")}`,
            { redirect: "manual" },
          );
        },
      }),
    ).rejects.toThrow("Sign-in was cancelled in the browser.");
    expect(readCredentials(path)).toBeNull();
  });

  describe("where the browser ends", () => {
    interface BrowserAnswer {
      status: number;
      location: string | null;
      body: string;
    }

    /** One login whose browser sends one callback, and what that browser got. */
    async function browserAfter(query: (signIn: URL) => string, seen: { url?: URL } = {}) {
      let answer: Promise<BrowserAnswer> | undefined;
      const login_ = login({
        webUrl: cloud.url,
        path,
        log: () => {},
        timeoutMs: 500,
        exchangeTimeoutMs: 100,
        open: (url) => {
          seen.url = new URL(url);
          answer = fetch(`http://127.0.0.1:${seen.url.searchParams.get("port")}/callback?${query(seen.url)}`, { redirect: "manual" })
            .then(async (response) => ({ status: response.status, location: response.headers.get("location"), body: await response.text() }));
        },
      }).then(() => null, (error: Error) => error);
      const error = await login_;
      return { error, browser: await (answer as Promise<BrowserAnswer>) };
    }

    const stateOf = (signIn: URL) => signIn.searchParams.get("state");
    const allow = (signIn: URL) => `code=code-1&state=${stateOf(signIn)}`;
    const result = (outcome: string) => `${cloud.url}/cli/login/result?outcome=${outcome}`;

    it("holds the browser until the credentials are stored, then sends it to the hosted success page", async () => {
      const seen: { url?: URL } = {};
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let storedBeforeAnswer: boolean | undefined;
      let browserAnswered = false;
      cloud.route("POST /api/cli/token", async () => {
        await released;
        return {
          body: {
            accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 2_000_000_000, supabaseUrl: cloud.url,
            supabaseAnonKey: "anon-key", platformApiUrl: cloud.url, user: { id: "user-1", email: "dev@example.com" },
          },
        };
      });
      let answer: Promise<Response> | undefined;
      const running = login({
        webUrl: cloud.url,
        path,
        log: () => {},
        open: (url) => {
          seen.url = new URL(url);
          answer = fetch(`http://127.0.0.1:${seen.url.searchParams.get("port")}/callback?${allow(seen.url)}`, { redirect: "manual" });
          void answer.then(() => {
            browserAnswered = true;
            storedBeforeAnswer = readCredentials(path) !== null;
          });
        },
      });
      await expect.poll(() => cloud.requests.some((request) => request.path === "/api/cli/token")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(browserAnswered).toBe(false);

      release();
      await running;
      const response = await (answer as Promise<Response>);
      expect(storedBeforeAnswer).toBe(true);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(result("success"));
    });

    it("sends the browser to the failure page and the terminal gets the error when the exchange is refused", async () => {
      cloud.route("POST /api/cli/token", { status: 400, body: { error: "This sign-in code is invalid.", error_code: "INVALID_GRANT" } });

      const { error, browser } = await browserAfter(allow);

      expect(error?.message).toContain("This sign-in code is invalid.");
      expect(browser).toMatchObject({ status: 302, location: result("failed") });
      expect(readCredentials(path)).toBeNull();
    });

    it("sends the browser to the failure page when the answer breaks the login contract", async () => {
      cloud.route("POST /api/cli/token", { body: { accessToken: "access-1" } });

      const { error, browser } = await browserAfter(allow);

      expect(error?.message).toMatch(/disagree on the login contract/);
      expect(browser.location).toBe(result("failed"));
    });

    it("answers the browser when the exchange never returns", async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      cloud.route("POST /api/cli/token", async () => {
        await released;
        return { status: 500 };
      });

      const { error, browser } = await browserAfter(allow);
      release();

      expect(error?.message).toMatch(/Could not reach/);
      expect(browser.location).toBe(result("failed"));
    });

    it("still finishes when the browser has gone while it was held", async () => {
      const seen: { url?: URL } = {};
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const answer = {
        accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 2_000_000_000, supabaseUrl: cloud.url,
        supabaseAnonKey: "anon-key", platformApiUrl: cloud.url, user: { id: "user-1", email: "dev@example.com" },
      };
      cloud.route("POST /api/cli/token", async () => {
        await released;
        return { body: answer };
      });
      const leaving = new AbortController();
      const running = login({
        webUrl: cloud.url,
        path,
        log: () => {},
        open: (url) => {
          seen.url = new URL(url);
          void fetch(`http://127.0.0.1:${seen.url.searchParams.get("port")}/callback?${allow(seen.url)}`, { signal: leaving.signal }).catch(() => {});
        },
      });
      await expect.poll(() => cloud.requests.some((request) => request.path === "/api/cli/token")).toBe(true);

      leaving.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();

      expect((await running).credentials.user.email).toBe("dev@example.com");
    });

    it.each([
      ["access_denied", "cancelled"],
      ["server_error", "failed"],
    ])("sends a callback with error=%s to the %s page", async (error, outcome) => {
      const { browser } = await browserAfter((signIn) => `error=${error}&state=${stateOf(signIn)}`);

      expect(browser).toMatchObject({ status: 302, location: result(outcome) });
    });

    it("carries nothing from the callback in the redirect", async () => {
      const { browser } = await browserAfter((signIn) => `error=${encodeURIComponent("<b>x</b>")}&state=${stateOf(signIn)}`);

      expect(browser.location).toBe(result("failed"));
    });

    it.each([
      ["a callback that is not ours", () => "code=code-1&state=forged", "Sign-in link mismatch"],
      ["no code", (signIn: URL) => `state=${stateOf(signIn)}`, "Sign-in incomplete"],
    ])("answers %s from this server, redirecting nowhere, with no Curb mark", async (_name, query, title) => {
      const { browser } = await browserAfter(query);

      expect(browser.status).toBe(400);
      expect(browser.location).toBeNull();
      expect(browser.body).toContain(`<h1>${title}</h1>`);
      expect(browser.body).not.toContain(CURB_MARK);
      expect(browser.body).toContain("prefers-color-scheme: dark");
      expect(browser.body).toContain(`name="viewport"`);
      expect(browser.body).not.toMatch(/https?:|<script|<img|@import|url\(/);
      expect(browser.body).toContain(`<link rel="icon" href="data:,">`);
    });
  });

  it("gives up after the timeout", async () => {
    await expect(login({ webUrl: cloud.url, path, log: () => {}, open: () => {}, timeoutMs: 50 })).rejects.toThrow(/Timed out/);
  });

  it("refuses a plain-http web URL that is not loopback", async () => {
    await expect(login({ webUrl: "http://app.example.com", path, log: () => {}, open: () => {} })).rejects.toThrow(/must be https/);
  });
});

describe("credentials", () => {
  it("lives under XDG_CONFIG_HOME when it is set", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config/curb/credentials.json");
    expect(credentialsPath({})).toMatch(/\.config\/curb\/credentials\.json$/);
  });

  it("refreshes an expiring token through Supabase and saves the new one", async () => {
    writeCredentials(fakeCredentials(cloud.url, { expiresAt: 1000 }), path);
    cloud.route("POST /auth/v1/token", (request) => {
      expect(request.query.get("grant_type")).toBe("refresh_token");
      expect(request.headers.apikey).toBe("anon-key");
      expect(request.json()).toEqual({ refresh_token: "refresh-1" });
      return { body: { access_token: "access-2", refresh_token: "refresh-2", expires_at: 5000 } };
    });

    const fresh = await ensureCredentials(path, () => 2000);
    expect(fresh.accessToken).toBe("access-2");
    expect(readCredentials(path)?.refreshToken).toBe("refresh-2");
  });

  it("tells the user to log in when nobody is signed in", async () => {
    await expect(ensureCredentials(path)).rejects.toThrow("Run `npx curb login` first.");
  });

  it("rejects a credentials file missing a field instead of using half of it", () => {
    writeFileSync(join(dir, "partial.json"), JSON.stringify({ webUrl: "x" }));
    expect(() => readCredentials(join(dir, "partial.json"))).toThrow(/missing platformApiUrl/);
  });
});

describe("curb logout", () => {
  it("revokes only this session and deletes the file", async () => {
    writeCredentials(fakeCredentials(cloud.url), path);
    cloud.route("POST /auth/v1/logout", { status: 204 });
    const lines: string[] = [];
    await logout({ path, log: (line) => lines.push(line) });

    const revoke = cloud.requests.find((request) => request.path === "/auth/v1/logout");
    expect(revoke?.query.get("scope")).toBe("local");
    expect(revoke?.headers.authorization).toBe("Bearer access-1");
    expect(readCredentials(path)).toBeNull();
    expect(lines.at(-1)).toContain("Signed out");
  });

  it("also deletes the project keys curb login stored, and says they stay revocable on the dashboard", async () => {
    writeCredentials(fakeCredentials(cloud.url), path);
    const keys = projectKeysPath(path);
    storeProjectKey(
      {
        apiKey: "sk-never-printed",
        keyId: 100,
        orgId: "org_pub_acme",
        orgName: "Acme",
        projectId: "prj_pub_voice",
        projectName: "Voice",
        webUrl: cloud.url,
        email: "dev@example.com",
      },
      keys,
    );
    cloud.route("POST /auth/v1/logout", { status: 204 });
    const lines: string[] = [];
    await logout({ path, log: (line) => lines.push(line) });

    expect(existsSync(keys)).toBe(false);
    expect(readProjectKeys(keys)).toEqual({});
    expect(lines).toEqual([
      `Signed out. Removed ${path} and ${keys}.`,
      "The project keys your logins created stay revocable on the API keys page of the KugelAudio dashboard.",
    ]);
    expect(lines.join("\n")).not.toContain("sk-never-printed");
  });

  it("still deletes the file when the revoke fails, and says so", async () => {
    writeCredentials(fakeCredentials(cloud.url), path);
    cloud.route("POST /auth/v1/logout", { status: 500 });
    const lines: string[] = [];
    await logout({ path, log: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^Warning: could not revoke/);
    expect(readCredentials(path)).toBeNull();
  });
});
