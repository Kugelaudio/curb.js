import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallenge, type LoginResult } from "./auth.js";
import { loginCommand } from "./commands.js";
import { projectKeysPath, readProjectKeys, storeProjectKey } from "./credentials.js";
import { type FakeCloud, fakeCredentials, startFakeCloud } from "./fake-cloud.test-support.js";
import { readLink, writeLink } from "./link.js";
import { envHasProjectKey, findCurbProject, finishLogin, useLoginKey } from "./project-key.js";

// `curb login` in a Curb project: the key the browser sign-in created goes into the CLI's own
// store, never into the project; the project is linked for the first deploy, every later curb
// command runs on the stored key, and the key is never printed. A KUGELAUDIO_API_KEY set in
// .env or the environment is the alternative, and wins.

const KEY = "sk-kug-proj_lu_0000000000000001_the-secret-part";
const TEMPLATE_ENV = "# KUGELAUDIO_API_KEY=   # optional: an API key instead of npx curb login (CI, servers)\n";

let dir: string;
let root: string;
let keys: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curb-project-key-"));
  root = join(dir, "my-agent");
  keys = join(dir, "config", "curb", "project-keys.json");
  mkdirSync(join(root, "src", "agent"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "my-agent", dependencies: { curb: "^0.1.0" } }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function result(projectKey: LoginResult["projectKey"], webUrl = "https://www.kugelaudio.com"): LoginResult {
  return { credentials: fakeCredentials(webUrl), projectKey };
}

const PROJECT_KEY = {
  apiKey: KEY,
  keyId: 100,
  orgId: "org_pub_acme",
  orgName: "Acme",
  projectId: "prj_pub_voice",
  projectName: "Voice",
};

const STORED = { ...PROJECT_KEY, webUrl: "https://www.kugelaudio.com", email: "dev@example.com" };

describe("findCurbProject", () => {
  it("finds the nearest directory up whose package.json depends on curb", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "workspace", devDependencies: { typescript: "5" } }));
    expect(findCurbProject(join(root, "src", "agent"))).toBe(root);
    expect(findCurbProject(root)).toBe(root);
  });

  it("is null outside a Curb project", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(findCurbProject(dir)).toBeNull();
  });

  it("says which package.json is broken instead of guessing", () => {
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(() => findCurbProject(root)).toThrow(`${join(root, "package.json")} is not valid JSON.`);
  });
});

describe("the project's .env", () => {
  it.each([
    ["no .env", null, false],
    ["the template's commented line", TEMPLATE_ENV, false],
    ["an empty line from an older template", "ANTHROPIC_API_KEY=a\nKUGELAUDIO_API_KEY=\n", false],
    ["a key", "KUGELAUDIO_API_KEY=sk-mine\n", true],
    ["an exported key", "export KUGELAUDIO_API_KEY=sk-mine\n", true],
  ])("reads %s", (_label, text, has) => {
    if (text !== null) writeFileSync(join(root, ".env"), text);
    expect(envHasProjectKey(root)).toBe(has);
  });
});

describe("finishLogin", () => {
  it("stores the key beside the credentials (0600) and links the project, leaving .env untouched", () => {
    writeFileSync(join(root, ".env"), TEMPLATE_ENV);

    const lines = finishLogin(root, true, result(PROJECT_KEY), keys);

    expect(lines).toEqual(["Signed in as dev@example.com for Acme / Voice. This project runs on your login; there is no key to copy."]);
    expect(readProjectKeys(keys)).toEqual({ prj_pub_voice: STORED });
    expect(statSync(keys).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(TEMPLATE_ENV);
    expect(readLink(root)).toEqual({ webUrl: "https://www.kugelaudio.com", orgId: "org_pub_acme", projectId: "prj_pub_voice" });
  });

  it("creates no .env in a project without one", () => {
    finishLogin(root, true, result(PROJECT_KEY), keys);
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("keeps a link to an agent in the same project", () => {
    const agentLink = {
      webUrl: "https://www.kugelaudio.com",
      orgId: "org_pub_acme",
      projectId: "prj_pub_voice",
      agentId: "agent-a",
      platformProjectId: "pp-a",
      environmentId: "env-a",
      dashboardUrl: "https://www.kugelaudio.com/dashboard/acme/voice/agents/juno",
    };
    writeLink(root, agentLink);

    finishLogin(root, true, result(PROJECT_KEY), keys);

    expect(readLink(root)).toEqual(agentLink);
  });

  it("says so when the link names another project, and keeps that link", () => {
    writeLink(root, { webUrl: "https://www.kugelaudio.com", orgId: "org_pub_other", projectId: "prj_pub_other" });

    const lines = finishLogin(root, true, result(PROJECT_KEY), keys);

    expect(lines).toEqual([
      "Signed in as dev@example.com for Acme / Voice, but .curb/link.json links this project to another KugelAudio project, " +
        "so it does not run on that login. Delete .curb/link.json and run `npx curb login` again to switch.",
    ]);
    expect(readLink(root)?.projectId).toBe("prj_pub_other");
  });

  it("leaves a key set in .env, which wins, and says so in one line", () => {
    writeFileSync(join(root, ".env"), "KUGELAUDIO_API_KEY=sk-mine\n");

    const lines = finishLogin(root, false, result(null), keys);

    expect(lines).toEqual([
      "Signed in as dev@example.com (https://www.kugelaudio.com). .env sets KUGELAUDIO_API_KEY, so this project runs on " +
        "that key, not on your login (remove the line and run `npx curb login` again to use your login).",
    ]);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("KUGELAUDIO_API_KEY=sk-mine\n");
    expect(existsSync(keys)).toBe(false);
    expect(existsSync(join(root, ".curb", "link.json"))).toBe(false);
  });

  it("changes nothing when the web sent no key, and says to sign in again later", () => {
    const lines = finishLogin(root, true, result(null), keys);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Signed in as dev@example\.com \(https:\/\/www\.kugelaudio\.com\), but no API key came with the sign-in/);
    expect(lines[0]).toMatch(/Run `npx curb login` again later\.$/);
    expect(existsSync(keys)).toBe(false);
    expect(existsSync(join(root, ".curb", "link.json"))).toBe(false);
  });

  it("outside a project only says where to run it", () => {
    expect(finishLogin(null, false, result(null), keys)).toEqual([
      "Signed in as dev@example.com (https://www.kugelaudio.com). Run `npx curb login` in a Curb project to run it on your login.",
    ]);
  });
});

describe("useLoginKey", () => {
  beforeEach(() => {
    storeProjectKey(STORED, keys);
    writeLink(root, { webUrl: "https://www.kugelaudio.com", orgId: "org_pub_acme", projectId: "prj_pub_voice" });
  });

  it("sets KUGELAUDIO_API_KEY from the store for the linked project, and returns where it came from", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(useLoginKey(root, env, keys)).toEqual(STORED);
    expect(env.KUGELAUDIO_API_KEY).toBe(KEY);
  });

  it("counts an empty value as unset", () => {
    const env: NodeJS.ProcessEnv = { KUGELAUDIO_API_KEY: " " };
    expect(useLoginKey(root, env, keys)?.projectId).toBe("prj_pub_voice");
    expect(env.KUGELAUDIO_API_KEY).toBe(KEY);
  });

  it("leaves a key from .env or the environment alone: it wins", () => {
    const env: NodeJS.ProcessEnv = { KUGELAUDIO_API_KEY: "sk-mine" };
    expect(useLoginKey(root, env, keys)).toBeNull();
    expect(env.KUGELAUDIO_API_KEY).toBe("sk-mine");
  });

  it("uses nothing for a project with no link, or one linked to a project the login has no key for", () => {
    const env: NodeJS.ProcessEnv = {};
    writeLink(root, { webUrl: "https://www.kugelaudio.com", orgId: "org_pub_other", projectId: "prj_pub_other" });
    expect(useLoginKey(root, env, keys)).toBeNull();
    rmSync(join(root, ".curb"), { recursive: true });
    expect(useLoginKey(root, env, keys)).toBeNull();
    expect(env).toEqual({});
  });
});

describe("npx curb login in a project, against a stub web", () => {
  let cloud: FakeCloud;
  let printed: string[];

  beforeEach(async () => {
    cloud = await startFakeCloud();
    printed = [];
    writeFileSync(join(root, ".env"), TEMPLATE_ENV);
    vi.stubEnv("AGENT_PROJECT_DIR", join(root, "src"));
    vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
    vi.stubEnv("CURB_NO_OPEN", "1");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await cloud.close();
  });

  /** The browser: it reads the sign-in URL the CLI prints and allows, as the consent page's Allow does. */
  function browserAllowsWhenAsked(): { signIn: () => URL | undefined } {
    let signIn: URL | undefined;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      printed.push(line);
      const opening = /^Opening (\S+)$/.exec(line);
      if (!opening) return;
      signIn = new URL(opening[1]);
      void fetch(`http://127.0.0.1:${signIn.searchParams.get("port")}/callback?code=code-1&state=${signIn.searchParams.get("state")}`);
    });
    return { signIn: () => signIn };
  }

  const session = (url: string) => ({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 2_000_000_000,
    supabaseUrl: url,
    supabaseAnonKey: "anon-key",
    platformApiUrl: url,
    webUrl: url,
    user: { id: "user-1", email: "dev@example.com" },
  });

  it("stores the key, links the project and leaves .env as it was; a later command runs on the key, and none is printed", async () => {
    const browser = browserAllowsWhenAsked();
    cloud.route("POST /api/cli/token", (request) => {
      const { code, code_verifier } = request.json() as { code: string; code_verifier: string };
      const signIn = browser.signIn();
      // The web issues a key only to a login that asked for one, as /cli/login does.
      if (code !== "code-1" || pkceChallenge(code_verifier) !== signIn?.searchParams.get("code_challenge")) {
        return { status: 400, body: { error: "invalid code", error_code: "invalid_grant" } };
      }
      const key = signIn.searchParams.get("project_key") === "1"
        ? { api_key: KEY, key_id: 100, org_id: "org_pub_acme", org_name: "Acme", project_id: "prj_pub_voice", project_name: "Voice" }
        : {};
      return { body: { ...session(cloud.url), ...key } };
    });
    cloud.route("GET /api/cli/agents", { body: { orgs: [] } });

    await loginCommand(["--url", cloud.url]);

    expect(browser.signIn()?.searchParams.get("project_key")).toBe("1");
    expect(browser.signIn()?.searchParams.get("device_name")).toBeTruthy();
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(TEMPLATE_ENV);
    expect(readLink(root)).toEqual({ webUrl: cloud.url, orgId: "org_pub_acme", projectId: "prj_pub_voice" });
    const stored = projectKeysPath(join(dir, "config", "curb", "credentials.json"));
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(printed.at(-1)).toBe("Signed in as dev@example.com for Acme / Voice. This project runs on your login; there is no key to copy.");
    expect(printed.join("\n")).not.toContain("the-secret-part");
    expect(existsSync(join(dir, "config", "curb", "credentials.json"))).toBe(true);

    // A later `curb say` or `curb dev`: the CLI loads .env, then runs on the login's key.
    const env: NodeJS.ProcessEnv = { ...parseEnv(readFileSync(join(root, ".env"), "utf8")) };
    expect(useLoginKey(root, env)?.email).toBe("dev@example.com");
    expect(env.KUGELAUDIO_API_KEY).toBe(KEY);
  });

  it("asks for no key when .env sets one, and leaves it", async () => {
    writeFileSync(join(root, ".env"), "KUGELAUDIO_API_KEY=sk-mine\n");
    const browser = browserAllowsWhenAsked();
    cloud.route("POST /api/cli/token", { body: session(cloud.url) });
    cloud.route("GET /api/cli/agents", { body: { orgs: [] } });

    await loginCommand(["--url", cloud.url]);

    expect(browser.signIn()?.searchParams.has("project_key")).toBe(false);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("KUGELAUDIO_API_KEY=sk-mine\n");
    expect(existsSync(join(dir, "config", "curb", "project-keys.json"))).toBe(false);
    expect(printed.at(-1)).toMatch(/\.env sets KUGELAUDIO_API_KEY, so this project runs on that key, not on your login/);
  });
});
