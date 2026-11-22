import { spawn } from "node:child_process";
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestProject } from "./test-project.js";
import { resolveNodeTypes } from "./typecheck.js";

/**
 * The examples of "Build your own tests" (docs/agent-guide/testing-foundation.md), taken from the
 * page as written: every code block that starts with a file path is written to that path in a
 * project of the default template, type-checked against the public API, and run as the page says
 * (`npx vitest run`, `npx curb run`, `npx curb review`, `npx curb test`). The agent's provider is an
 * OpenAI-compatible endpoint in this process that plays Juno, the team's models and Curb's judge,
 * so nothing leaves the machine.
 */

const page = fileURLToPath(new URL("../../docs/agent-guide/testing-foundation.md", import.meta.url));
const template = fileURLToPath(new URL("../../../create-curb.js/templates/default/", import.meta.url));
const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));
const vitest = fileURLToPath(new URL("../../../../node_modules/vitest/vitest.mjs", import.meta.url));

/** The page's files: each fenced block whose first line is `// <path>`, by that path. */
function examples(): Record<string, string> {
  const blocks = [...readFileSync(page, "utf8").matchAll(/```ts\n\/\/ ([\w./-]+)\n([\s\S]*?)```/g)];
  return Object.fromEntries(blocks.map(([, path, body]) => [path!, `// ${path}\n${body}`]));
}

type Message = { role: string; content?: unknown };

/** What the endpoint answers: Juno's replies and tool calls, the team's caller and rubric, the
 * simulated caller, and Curb's judge (no to every finding, yes to the goal). */
function answer(messages: Message[]): { content?: string; toolCall?: { name: string; arguments: string } } {
  const text = (message: Message | undefined) => (typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? ""));
  const system = text(messages.find((message) => message.role === "system"));
  const all = messages.map(text).join("\n");
  if (system.startsWith("You review one recorded phone call")) {
    const ids = [...system.matchAll(/^- ([a-z_0-9]+): /gm)].map((match) => match[1]!);
    return { content: JSON.stringify({ answers: ids.map((id) => ({ id, answer: id === "goal" ? "yes" : "no", turn: null, quote: "", reason: `${id} answered` })) }) };
  }
  if (system.startsWith("You sort findings")) return { content: JSON.stringify({ patterns: [] }) };
  if (all.includes("You are calling a planning assistant")) return { content: "bye" };
  if (all.includes("Did the agent confirm each task")) return { content: "yes, it said each one is on the list." };
  if (all.includes("Your goal for this call")) {
    if (all.includes("[still wanted")) return { content: "[hang up: met - both tasks are on the list]" };
    return { content: all.includes("on your list") ? "Great, thanks, bye! [hang up: met - both tasks are on the list]" : "Put buy milk and call the dentist on my list." };
  }
  // Juno.
  // The caller's last line: the turn's context comes after it, as a message of its own.
  const lines = messages.flatMap((message, index) => (message.role === "user" && !text(message).startsWith("<current_context>") ? [index] : []));
  const at = lines.at(-1) ?? -1;
  if (messages.slice(at).some((message) => message.role === "tool")) return { content: "Done, that's on your list." };
  const said = text(messages[at]);
  if (/voice call has just connected/.test(said)) return { content: "Hi, I'm Juno, an AI assistant. What's on for today?" };
  if (/bye/i.test(said)) return { toolCall: { name: "end_call", arguments: JSON.stringify({ goodbye: "Bye, have a good day." }) } };
  if (/milk/i.test(said)) return { toolCall: { name: "add_task", arguments: JSON.stringify({ title: "buy milk" }) } };
  if (/parcel/i.test(said)) return { toolCall: { name: "add_task", arguments: JSON.stringify({ title: "pick up the parcel" }) } };
  return { content: "Anything else for your list?" };
}

async function endpoint() {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Message[]; stream?: boolean };
      const { content, toolCall } = answer(body.messages);
      const tool_calls = toolCall ? [{ index: 0, id: "t1", type: "function", function: toolCall }] : undefined;
      const finish_reason = toolCall ? "tool_calls" : "stop";
      const head = { id: "c1", created: 0, model: "qwen3.8-27b" };
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        const message = { role: "assistant", content: content ?? null, ...(tool_calls ? { tool_calls: tool_calls.map(({ index: _index, ...call }) => call) } : {}) };
        res.end(JSON.stringify({ ...head, object: "chat.completion", choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      const delta = tool_calls ? { role: "assistant", tool_calls } : { role: "assistant", content };
      const chunks = [
        { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { ...head, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }] },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function run(cwd: string, program: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("VITEST") || name === "AGENT_PROJECT_DIR" || name === "TSX_TSCONFIG_PATH" || name === "GITHUB_STEP_SUMMARY") delete env[name];
  const child = spawn(process.execPath, [program, ...args], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

describe("the examples of Build your own tests", () => {
  const files = examples();
  let root = "";
  let server: Awaited<ReturnType<typeof endpoint>>;

  beforeAll(async () => {
    server = await endpoint();
    root = createTestProject({ ...files, ".env": `KUGELAUDIO_API_KEY=ka_test_0123456789\nKUGELAUDIO_API_BASE=${server.origin}\n` });
    for (const dir of ["src", "context"]) cpSync(join(template, dir), join(root, dir), { recursive: true });
    // The page's files win over the template's, where they share a path.
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
  });
  afterAll(async () => {
    await server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("are the four files the page shows", () => {
    expect(Object.keys(files)).toEqual(["test/tasks.test.ts", "scripts/harness.ts", "src/agent/naturalness.ts", "src/agent/natural-planning.scenario.ts"]);
  });

  it("type-check against the public API, in a project of the default template", () => {
    const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")), ts.sys, root);
    const paths = Object.keys(files).map((path) => join(root, path));
    const nodeTypes = resolveNodeTypes(ts, root, config.options);
    const program = ts.createProgram({ rootNames: [...paths, ...(nodeTypes ? [nodeTypes] : [])], options: config.options });
    const problems = paths.flatMap((path) =>
      ts.getPreEmitDiagnostics(program, program.getSourceFile(path)).map((diagnostic) => `${path.slice(root.length + 1)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`),
    );
    expect(problems).toEqual([]);
  }, 120_000);

  it("(a) runs in vitest, which startCall prepares the project for", async () => {
    const result = await run(root, vitest, ["run", "--root", root, "test/"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("1 passed");
  }, 180_000);

  it("(b) runs with npx curb run, saves a run that npx curb review reads", async () => {
    const harness = await run(root, bin, ["run", "scripts/harness.ts"]);
    expect(harness.status, harness.stderr).toBe(0);
    expect(harness.stdout).toContain("--- a busy morning\n  pass  confirms each task: yes, it said each one is on the list.\nPASS a busy morning\n");
    expect(harness.stdout).toContain("2 of 2 passed.");
    expect(readdirSync(join(root, ".curb/test-runs"))).toHaveLength(1);

    const review = await run(root, bin, ["review", ".curb/test-runs", "--json"]);
    expect(review.status, review.stderr).toBe(0);
    expect(JSON.parse(review.stdout)).toMatchObject({ calls: { reviewed: 2, withoutFindings: 2, notJudged: 0 } });
  }, 240_000);

  it("(c) runs with npx curb test: the findings, the note and the check across runs", async () => {
    const result = await run(root, bin, ["test", "natural", "--json"]);
    const report = JSON.parse(result.stdout) as { scenarios: Array<{ findings: Array<{ id: string }>; checks: Array<{ name: string; pass: boolean; reportOnly?: true }>; checkStats: Array<{ name: string; reportOnly?: true }> }> };
    const [scenario] = report.scenarios;
    expect(scenario!.findings.map((finding) => finding.id).slice(-2)).toEqual(["canned_closing", "missed_mood"]);
    expect(scenario!.checkStats.find((check) => check.name.startsWith("The agent sounds like a person"))).toMatchObject({ reportOnly: true });
    // Juno says the same goodbye on every run here, so the check across runs fails the scenario.
    expect(scenario!.checks.find((check) => check.name.startsWith("across runs: "))).toMatchObject({ name: "across runs: the goodbye is not the same in every run", pass: false });
    expect(result.status).toBe(1);
  }, 240_000);
});
