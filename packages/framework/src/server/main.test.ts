import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createTestProject } from "../cli/test-project.js";
import type { ServerMessage } from "./protocol.js";

/** An agent that loads but throws when it renders. */
const NOT_RENDERING = `import { Agent, defineAgent } from "curb";

export function App() {
  if (Date.now() > 0) throw new Error("boom in render");
  return <Agent />;
}

export const agent = defineAgent({ app: App, initialPath: "/" });
`;

const SKILL = `import { Text, type SkillMeta } from "curb";

export const meta: SkillMeta = { title: "Home", description: "Start here." };

export default function Home() {
  return <Text>Welcome.</Text>;
}
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * `curb server` is a server for clients other than the preview: a client it cannot start a
 * conversation for gets an error frame and a closed socket, as before `curb dev` learned to
 * keep its page connected (`agent_unavailable`) until a save reloads the agent.
 */
/** An older curb's history, which the store refuses, at KUGEL_CONVERSATIONS_DB. */
describe("curb server on an SQLite conversation store", () => {
  const root = createTestProject({ "src/agent/agent.tsx": NOT_RENDERING, "src/agent/skill.tsx": SKILL });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stops at boot and says what to do, instead of failing every conversation", async () => {
    const path = join(root, "conversations.db");
    writeFileSync(path, "SQLite format 3\0");
    const env: NodeJS.ProcessEnv = { ...process.env, KUGEL_CONVERSATIONS_DB: path };
    delete env.AGENT_PROJECT_DIR;
    delete env.TSX_TSCONFIG_PATH;
    // The store is off under the test runner; this test needs it.
    delete env.VITEST;
    const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));
    const server = spawn(process.execPath, [bin, "server", "--port", String(await freePort())], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    server.stdout!.on("data", (chunk) => (output += String(chunk)));
    server.stderr!.on("data", (chunk) => (output += String(chunk)));

    const code = await new Promise((resolve) => server.once("exit", resolve));

    expect(code).not.toBe(0);
    expect(output).toMatch(/is an SQLite database from an older curb/);
    expect(output).toContain("[AGENT_CONVERSATION_STORE_SQLITE]");
    expect(output).toMatch(/Fix: Point KUGEL_CONVERSATIONS_DB at a new file/);
    expect(output).not.toContain("Ready in");
  }, 120_000);
});

describe("curb server when no conversation can start", () => {
  const root = createTestProject({ "src/agent/agent.tsx": NOT_RENDERING, "src/agent/skill.tsx": SKILL });
  let server: ChildProcess | undefined;
  let output = "";
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, KUGEL_CONVERSATIONS_DB: "off" };
    delete env.AGENT_PROJECT_DIR;
    delete env.TSX_TSCONFIG_PATH;
    const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));
    server = spawn(process.execPath, [bin, "server", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.on("data", (chunk) => (output += String(chunk)));
    server.stderr!.on("data", (chunk) => (output += String(chunk)));
    const deadline = Date.now() + 90_000;
    while (!output.includes("Ready in")) {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`curb server did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 120_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server!.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("answers with an error frame and closes the socket", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const frames: ServerMessage[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerMessage));
    const code = await new Promise<number>((resolve, reject) => {
      socket.on("close", (closeCode) => resolve(closeCode));
      socket.on("error", reject);
      setTimeout(() => reject(new Error(`the socket stayed open:\n${output}`)), 30_000).unref();
    });

    expect(frames).toEqual([{ type: "error", scope: "llm", message: expect.stringMatching(/^Failed to start session: .*boom in render/) }]);
    expect(code).toBe(1005);
  }, 60_000);
});
