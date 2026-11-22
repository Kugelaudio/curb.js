import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestProject } from "./test-project.js";

/**
 * `curb run` in a project of its own, as a project runs it: the bin shim, tsx, the project's
 * .env. The agent's LLM is an OpenAI-compatible endpoint in this process that answers every
 * request "Hello there.", so nothing leaves the machine.
 */

const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));

/** An endpoint that answers "Hello there.", or, asked to book, calls `book` for Alex and then
 * says "Booked." */
async function helloEndpoint() {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests += 1;
      const messages = (JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> }).messages;
      const booking = JSON.stringify(messages).includes("Book Alex");
      const ran = messages.some((message) => message.role === "tool");
      const head = { id: "c1", created: 0, model: "qwen3.8-27b", object: "chat.completion.chunk" };
      const call = { role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "book", arguments: '{"who":"Alex"}' } }] };
      const delta = booking && !ran ? call : { role: "assistant", content: booking ? "Booked." : "Hello there." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        { ...head, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...head, choices: [{ index: 0, delta: {}, finish_reason: booking && !ran ? "tool_calls" : "stop" }] },
      ];
      res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests: () => requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const AGENT = `import { Agent, SystemPrompt, defineAgent } from "curb";

export const agent = defineAgent({
  app: () => (
    <Agent>
      <SystemPrompt>You are a friendly receptionist.</SystemPrompt>
    </Agent>
  ),
});
`;

/** A script with JSX of its own outside src/, that drives a call and reports on it. */
const SCRIPT = `import { checksOf, report, startCall } from "curb/testing";

const Note = ({ text }: { text: string }) => <>{text}</>;
const call = await startCall();
const turn = await call.say("Hi");
console.log(JSON.stringify({ reply: turn.reply, argv: process.argv.slice(2), note: Note({ text: "jsx" }).props.children }));
process.exitCode = report([{ name: "greets", checks: [checksOf(call.record()).said("hello there")] }]) + Number(process.argv[2] ?? 0);
`;

/** An agent with a store a tool changes. */
const DESK = `import { Agent, GlobalTools, SystemPrompt, Tool, createAgentStore, defineAgent, z } from "curb";

export const useDesk = createAgentStore<{ booked: string[]; book: (who: string) => void }>("desk", (set) => ({
  booked: [],
  book: (who) => set((state) => ({ booked: [...state.booked, who] })),
}));

function Desk() {
  const book = useDesk((state) => state.book);
  return (
    <Agent>
      <SystemPrompt>You are a receptionist.</SystemPrompt>
      <GlobalTools>
        <Tool name="book" description="Book someone in." schema={z.object({ who: z.string() })} onSubmit={(input) => { book(input.who); return { ok: true }; }} />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({ app: Desk });
`;

function curb(cwd: string, args: string[], env: Record<string, string>, program = bin): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of Object.keys(childEnv)) if (name.startsWith("VITEST") || name === "AGENT_PROJECT_DIR" || name === "TSX_TSCONFIG_PATH") delete childEnv[name];
  const child = spawn(process.execPath, [program, ...args], { cwd, env: childEnv });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

describe("curb run", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("runs a script with the project loaded: TypeScript and JSX, the .env, its arguments, its exit code", async () => {
    const endpoint = await helloEndpoint();
    try {
      const root = createTestProject({
        "src/agent/agent.tsx": AGENT,
        "scripts/greets.tsx": SCRIPT,
        ".env": `KUGELAUDIO_API_KEY=ka_test_0123456789\nKUGELAUDIO_API_BASE=${endpoint.origin}\n`,
      });
      roots.push(root);

      const passed = await curb(root, ["run", "scripts/greets.tsx", "0", "--help"], {});
      expect(passed.status, passed.stderr).toBe(0);
      const [first, ...rest] = passed.stdout.split("\n");
      expect(JSON.parse(first!)).toEqual({ reply: "Hello there.", argv: ["0", "--help"], note: "jsx" });
      expect(rest.join("\n")).toBe('--- greets\n  pass  said "hello there": turn 1\nPASS greets\n1 of 1 passed.\n');
      expect(endpoint.requests()).toBeGreaterThan(0);

      // The script's exit code is the command's.
      const failed = await curb(root, ["run", "scripts/greets.tsx", "3"], {});
      expect(failed.status).toBe(3);
    } finally {
      await endpoint.close();
    }
  }, 120_000);

  it("lets a vitest test of a project drive a call with startCall, which prepares the project itself", async () => {
    const endpoint = await helloEndpoint();
    try {
      const root = createTestProject({
        "src/agent/agent.tsx": DESK,
        "src/agent/desk.test.ts": `import { startCall } from "curb/testing";
import { expect, it } from "vitest";

it("books through a call", async () => {
  const call = await startCall();
  const turn = await call.say("Book Alex, please.");
  expect(turn.reply).toBe("Booked.");
  expect(call.state("desk")).toEqual({ booked: ["Alex"] });
});
`,
        ".env": `KUGELAUDIO_API_KEY=ka_test_0123456789\nKUGELAUDIO_API_BASE=${endpoint.origin}\n`,
      });
      roots.push(root);
      const vitest = fileURLToPath(new URL("../../../../node_modules/vitest/vitest.mjs", import.meta.url));

      const result = await curb(root, ["run", "--root", root], {}, vitest);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("1 passed");
    } finally {
      await endpoint.close();
    }
  }, 120_000);

  it("prints what a script throws and exits 1, and refuses a script that is not there", async () => {
    const root = createTestProject({ "src/agent/agent.tsx": AGENT, "boom.ts": `throw new Error("the harness broke");\n` });
    roots.push(root);

    const thrown = await curb(root, ["run", "boom.ts"], {});
    expect(thrown.status).toBe(1);
    expect(thrown.stderr).toContain("Error: the harness broke");

    const missing = await curb(root, ["run", "nope.ts"], {});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("[CURB_RUN_NOT_FOUND] No script at nope.ts.");

    const usage = await curb(root, ["run", "--help"], {});
    expect(usage.stdout).toContain("Usage: curb run <script> [args...]");
  }, 120_000);
});
