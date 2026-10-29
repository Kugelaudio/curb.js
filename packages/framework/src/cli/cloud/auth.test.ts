import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
          const real = await fetch(`http://127.0.0.1:${port}/callback?code=code-1&state=${state}`);
          expect(real.status).toBe(200);
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
      void fetch(`http://127.0.0.1:${seen.url.searchParams.get("port")}/callback?code=code-1&state=${seen.url.searchParams.get("state")}`);
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
          );
        },
      }),
    ).rejects.toThrow("Sign-in was cancelled in the browser.");
    expect(readCredentials(path)).toBeNull();
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
