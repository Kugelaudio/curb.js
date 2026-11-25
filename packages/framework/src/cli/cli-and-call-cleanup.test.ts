import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { storeProjectKey } from "./cloud/credentials.js";
import type { ChildMessage } from "./dev-ipc.js";
import { createTestProject } from "./test-project.js";

const BIN = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));

/** The environment a project's `curb` runs in, without what this suite or its runner sets. */
function projectEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of [
    "AGENT_PROJECT_DIR",
    "TSX_TSCONFIG_PATH",
    "VITEST",
    "KUGELAUDIO_API_KEY",
    "CURB_PLATFORM_TOKEN_FILE",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "CURB_REALTIME_SESSION_URL",
  ]) {
    delete env[name];
  }
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once `read()` returns `expected`; rejects with what it last read after `ms`. */
async function until(read: () => string, expected: string, ms: number, context: () => string): Promise<void> {
  const deadline = Date.now() + ms;
  let last = read();
  while (last !== expected) {
    if (Date.now() > deadline) throw new Error(`expected "${expected}", last read "${last}"\n${context()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = read();
  }
}

describe("curb dev with a key from curb login", () => {
  // Every agent server start writes the key it runs on to a file, so the test sees which one
  // the restarted server got after .env changed.
  const AGENT = `import { writeFileSync } from "node:fs";
import { Agent, SystemPrompt, defineAgent } from "curb";

writeFileSync(process.env.SEEN_KEY_FILE!, process.env.KUGELAUDIO_API_KEY ?? "");

export function App() {
  return (
    <Agent>
      <SystemPrompt>{\`You are a test agent.\`}</SystemPrompt>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
`;

  it("sends a startup diagnostic when the dev child cannot read the project link", async () => {
    const root = createTestProject({ ".curb/link.json": "{" });
    const child = fork(fileURLToPath(new URL("./dev-child.ts", import.meta.url)), [
      JSON.stringify({ projectRoot: root, publicUrl: "http://127.0.0.1", quiet: true }),
    ], {
      cwd: root,
      env: projectEnv(),
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const messages: ChildMessage[] = [];
      child.on("message", (message: ChildMessage) => messages.push(message));
      const [code] = await once(child, "close");
      expect(code).toBe(1);
      expect(messages).toContainEqual(expect.objectContaining({
        type: "failed",
        diagnostic: expect.objectContaining({
          message: expect.stringContaining(".curb/link.json is not valid JSON"),
        }),
      }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("runs on the login key until .env sets KUGELAUDIO_API_KEY, then on .env's key after the reload", async () => {
    const config = mkdtempSync(join(tmpdir(), "curb-config-"));
    const seen = join(config, "seen-key");
    storeProjectKey(
      {
        apiKey: "login-key",
        keyId: 100,
        orgId: "org_pub_test",
        orgName: "Test",
        projectId: "prj_pub_voice",
        projectName: "Voice",
        webUrl: "https://example.com",
        email: "dev@example.com",
      },
      join(config, "curb", "project-keys.json"),
    );
    const root = createTestProject({
      "src/agent/agent.tsx": AGENT,
      ".curb/link.json": JSON.stringify({ webUrl: "https://example.com", orgId: "org_pub_test", projectId: "prj_pub_voice" }),
      ".env": "",
    });
    let output = "";
    const port = await freePort();
    const dev = spawn(process.execPath, [BIN, "dev", "--no-open", "--port", String(port)], {
      cwd: root,
      env: projectEnv({ XDG_CONFIG_HOME: config, SEEN_KEY_FILE: seen, KUGEL_CONVERSATIONS_DB: join(root, ".data", "conversations.jsonl") }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    dev.stdout.on("data", (chunk) => (output += String(chunk)));
    dev.stderr.on("data", (chunk) => (output += String(chunk)));
    const read = () => (existsSync(seen) ? readFileSync(seen, "utf8") : "");
    try {
      // The agent writes the key during import, before the supervisor receives "ready".
      await until(() => String(output.includes("Ready in")), "true", 45_000, () => output);
      expect(output).not.toContain("did not load");
      expect(read()).toBe("login-key");
      writeFileSync(join(root, ".env"), "KUGELAUDIO_API_KEY=env-key\n");
      await until(() => String(/reloaded \.env/.test(output)), "true", 45_000, () => output);
      expect(read()).toBe("env-key");
    } finally {
      if (dev.exitCode === null && dev.signalCode === null) {
        const exited = new Promise((resolve) => dev.once("exit", resolve));
        dev.kill("SIGTERM");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(config, { recursive: true, force: true });
    }
  }, 100_000);
});

describe("curb build --out", () => {
  const curbBuild = (cwd: string, args: string[]) =>
    spawnSync(process.execPath, [BIN, "build", ...args], { cwd, env: projectEnv(), encoding: "utf8", timeout: 120_000 });

  it.each([
    ["it is followed by another flag", ["--out", "--no-verify", "--no-trace"]],
    ["it is the last argument", ["--no-verify", "--no-trace", "--out"]],
  ])("needs a value when %s", (_, args) => {
    const root = createTestProject({
      "src/agent/agent.tsx": `import { Agent, SystemPrompt, defineAgent } from "curb";

export function App() {
  return (
    <Agent>
      <SystemPrompt>{\`You are a test agent.\`}</SystemPrompt>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
`,
    });
    try {
      const result = curbBuild(root, args);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("curb build: --out needs a value.");
      expect(existsSync(join(root, "--no-verify"))).toBe(false);
      expect(existsSync(join(root, ".curb", "standalone"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 130_000);
});
