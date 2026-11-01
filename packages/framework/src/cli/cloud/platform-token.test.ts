import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudClient } from "./client.js";
import { deployCommand } from "./commands.js";
import { deploy } from "./deploy.js";
import { type FakeCloud, sequence, startFakeCloud } from "./fake-cloud.test-support.js";
import {
  PLATFORM_TOKEN_FILE_ENV,
  platformTokenTarget,
  readPlatformToken,
  refuseUnderPlatformToken,
} from "./platform-token.js";

const NOW = new Date("2026-10-27T18:00:00Z");

let dir: string;
let cloud: FakeCloud;
const lines: string[] = [];
const log = (line: string) => lines.push(line);

function tokenFile(fields: Record<string, unknown>): string {
  const path = join(dir, "platform-token.json");
  writeFileSync(path, JSON.stringify(fields));
  return path;
}

function valid(): Record<string, unknown> {
  return {
    token: "kws_aaaaaaaa",
    expiresAt: "2026-10-27T19:00:00Z",
    platformApiUrl: `${cloud.url}/`,
    tenantId: "org-a",
    projectId: "pp-a",
    environmentId: "env-dev",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "curb-platform-token-"));
  cloud = await startFakeCloud();
  lines.length = 0;
});

afterEach(async () => {
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("readPlatformToken", () => {
  it("is null when no file is named, and reads the file the host keeps", () => {
    expect(readPlatformToken({}, NOW)).toBeNull();
    const token = readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: tokenFile(valid()) }, NOW);
    expect(token).toMatchObject({ token: "kws_aaaaaaaa", platformApiUrl: cloud.url, tenantId: "org-a", environmentId: "env-dev" });
  });

  it("names what is wrong with a file it cannot use", () => {
    const { environmentId: _, ...missing } = valid();
    expect(() => readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: tokenFile(missing) }, NOW)).toThrow('has no "environmentId"');
    expect(() => readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: tokenFile({ ...valid(), expiresAt: "2026-10-27T17:00:00Z" }) }, NOW)).toThrow(
      "expired at 2026-10-27T17:00:00.000Z. The host renews it on its own",
    );
    expect(() => readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: tokenFile({ ...valid(), expiresAt: "soon" }) }, NOW)).toThrow(
      "not a time",
    );
    writeFileSync(join(dir, "broken.json"), "{");
    expect(() => readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: join(dir, "broken.json") }, NOW)).toThrow("is not JSON");
    expect(() => readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: join(dir, "absent.json") }, NOW)).toThrow("cannot be read");
  });
});

describe("deploy with a platform token", () => {
  it("deploys to the token's environment with the token, and never calls the web app", async () => {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", {
      status: 201,
      body: { uploadObjectKey: "uploads/u1.tar.gz", url: `${cloud.url}/store/u1`, method: "PUT", headers: {} },
    });
    cloud.route("PUT /store/u1", { status: 200 });
    cloud.route("POST /v1/agents/projects/pp-a/revisions", { status: 201, body: { revisionId: "rev-1" } });
    cloud.route("POST /v1/agents/environments/env-dev/activations", { status: 202, body: { state: "pending", deploymentId: "dep-1" } });
    cloud.route(
      "GET /v1/agents/environments/env-dev/deployments",
      sequence(
        { body: { deployments: [] } },
        { body: { deployments: [{ deploymentId: "dep-1", revisionId: "rev-1", state: "active" }] } },
      ),
    );
    const root = join(dir, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent", dependencies: { curb: "*" } }));
    writeFileSync(join(root, "src", "agent.tsx"), "export default null;\n");

    const token = readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: tokenFile(valid()) }, NOW)!;
    const { access, target } = platformTokenTarget(token);
    const result = await deploy({
      client: new CloudClient(access), link: target, root, activate: true, log, pollIntervalMs: 1, sleep: async () => {},
    });

    expect(result).toEqual({ revisionId: "rev-1", deploymentId: "dep-1", state: "active" });
    const platformCalls = cloud.requests.filter((request) => request.path.startsWith("/v1/agents/"));
    expect(platformCalls.length).toBeGreaterThan(0);
    for (const request of platformCalls) {
      expect(request.headers.authorization).toBe("Bearer kws_aaaaaaaa");
      expect(request.headers["x-kugel-tenant"]).toBe("org-a");
    }
    expect(cloud.requests.some((request) => request.path.startsWith("/api/cli/"))).toBe(false);
    expect(lines.join("\n")).not.toMatch(/undefined/);
    expect(lines.at(-1)).toBe("Live. Try it from the agent's page in the KugelAudio dashboard.");
  });

  it("explains a refused token as the host's to renew, not as a login to redo", async () => {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", { status: 401, body: { code: "identity_workspace_token_unknown" } });
    const root = join(dir, "project");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent", dependencies: { curb: "*" } }));
    const { access, target } = platformTokenTarget(readPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: tokenFile(valid()) }, NOW)!);
    await expect(deploy({ client: new CloudClient(access), link: target, root, activate: true, log })).rejects.toThrow(
      "The platform refused this environment's token",
    );
  });
});

describe("refuseUnderPlatformToken", () => {
  it("refuses login and secrets only when a token file is named", () => {
    expect(() => refuseUnderPlatformToken({}, "login", "x")).not.toThrow();
    expect(() => refuseUnderPlatformToken({ [PLATFORM_TOKEN_FILE_ENV]: "/tmp/t.json" }, "login", "No sign-in is needed.")).toThrow(
      "`curb login` is not available here: this environment deploys with a platform token its host issues (CURB_PLATFORM_TOKEN_FILE). No sign-in is needed.",
    );
  });
});

describe("curb deploy --json", () => {
  it("prints the result as one JSON line on stdout and the progress on stderr", async () => {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", {
      status: 201,
      body: { uploadObjectKey: "uploads/u1.tar.gz", url: `${cloud.url}/store/u1`, method: "PUT", headers: {} },
    });
    cloud.route("PUT /store/u1", { status: 200 });
    cloud.route("POST /v1/agents/projects/pp-a/revisions", { status: 201, body: { revisionId: "rev-1" } });
    cloud.route("POST /v1/agents/environments/env-dev/activations", {
      status: 200, body: { state: "activated", deploymentId: "dep-1" },
    });
    cloud.route("GET /v1/agents/environments/env-dev/deployments", { body: { deployments: [] } });
    const root = join(dir, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent", dependencies: { curb: "*" } }));
    writeFileSync(join(root, "src", "agent.tsx"), "export default null;\n");
    const file = tokenFile({ ...valid(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const logged = vi.spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
    const errored = vi.spyOn(console, "error").mockImplementation((line) => stderr.push(String(line)));
    vi.stubEnv(PLATFORM_TOKEN_FILE_ENV, file);
    vi.stubEnv("AGENT_PROJECT_DIR", root);
    try {
      await deployCommand(["--json"]);
    } finally {
      write.mockRestore();
      logged.mockRestore();
      errored.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({ revisionId: "rev-1", deploymentId: "dep-1", state: "active" });
    expect(stderr.join("\n")).toContain("Revision rev-1");
  });
});

describe("curb deploy --message", () => {
  function routeDeploy() {
    cloud.route("POST /v1/agents/projects/pp-a/uploads", {
      status: 201,
      body: { uploadObjectKey: "uploads/u1.tar.gz", url: `${cloud.url}/store/u1`, method: "PUT", headers: {} },
    });
    cloud.route("PUT /store/u1", { status: 200 });
    cloud.route("POST /v1/agents/projects/pp-a/revisions", { status: 201, body: { revisionId: "rev-1" } });
    cloud.route("POST /v1/agents/environments/env-dev/activations", { status: 200, body: { state: "activated", deploymentId: "dep-1" } });
    cloud.route("GET /v1/agents/environments/env-dev/deployments", { body: { deployments: [] } });
  }

  async function run(args: string[]): Promise<void> {
    const root = join(dir, "project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent", dependencies: { curb: "*" } }));
    writeFileSync(join(root, "src", "agent.tsx"), "export default null;\n");
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv(PLATFORM_TOKEN_FILE_ENV, tokenFile({ ...valid(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    vi.stubEnv("AGENT_PROJECT_DIR", root);
    try {
      await deployCommand(args);
    } finally {
      logged.mockRestore();
      vi.unstubAllEnvs();
    }
  }

  const revision = () =>
    cloud.requests.find((request) => request.path === "/v1/agents/projects/pp-a/revisions")?.json() as Record<string, unknown>;

  it.each([
    ["-m", ["-m", "Greet callers in German"]],
    ["--message", ["--message", "Greet callers in German"]],
    ["--message=", ["--message=Greet callers in German"]],
    ["several lines", ["-m", "  Greet callers in German\n\nAnd more detail."]],
  ])("sends the summary from %s", async (_, args) => {
    routeDeploy();
    await run(args);
    expect(revision().description).toBe("Greet callers in German");
  });

  it("sends no description without the flag", async () => {
    routeDeploy();
    await run([]);
    expect(revision()).not.toHaveProperty("description");
  });

  it("refuses a message that is too long before it uploads anything", async () => {
    routeDeploy();
    await expect(run(["-m", "a".repeat(161)])).rejects.toThrow("[CURB_DEPLOY_MESSAGE_INVALID] The deploy message is 161 characters");
    expect(cloud.requests).toEqual([]);
  });

  it("refuses -m with nothing after it", async () => {
    await expect(run(["-m"])).rejects.toThrow("-m needs a value.");
    expect(cloud.requests).toEqual([]);
  });
});
