import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "../server/protocol.js";
import { createTestProject } from "./test-project.js";

const AGENT = `import { Agent, Skill, Skills, SystemPrompt, Text, defineAgent } from "curb";
import { greeting } from "../lib/greeting.js";

export function App() {
  return (
    <Agent>
      <SystemPrompt>{\`You are a test agent.\`}</SystemPrompt>
      <Text>{greeting()}</Text>
      <Skills>
        <Skill path="/notes" description="Use for notes.">Notes</Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
`;

const SKILL = `import { Text, type SkillMeta } from "curb";

export const meta: SkillMeta = { title: "Notes", description: "Use for notes." };

export default function Notes() {
  return <Text>No notes yet.</Text>;
}
`;

/**
 * One test's budget. Every reload is a fresh agent server process (Node, tsx, the curb server
 * graph), so its duration scales with the machine's load: ~2 s alone, ~10 s in CI, past 30 s
 * on a loaded runner. A wait therefore never has its own short deadline; every
 * wait of a test shares this budget, which ends just before vitest's own timeout so a
 * failure still names the frames that came and prints what curb dev said.
 */
const TEST_TIMEOUT_MS = 240_000;
const PAGE_BUDGET_MS = TEST_TIMEOUT_MS - 10_000;
/** The first start of `curb dev` (Vite and the agent server), the same way: ~23 s in CI. */
const BOOT_TIMEOUT_MS = 180_000;

/** The page's side of the agent socket, as the preview runs it: reconnects, and after a
 * reload asks to stay on the conversation the reload named. Keeps every frame. */
class Page {
  readonly frames: ServerMessage[] = [];
  private socket: WebSocket | null = null;
  private resume: number | null = null;
  private closed = false;
  /** Woken on every frame: what `next` waits on. */
  private wake: () => void = () => {};
  private readonly deadline = Date.now() + PAGE_BUDGET_MS;

  constructor(private readonly url: string) {
    this.open();
  }

  private open(): void {
    const socket = new WebSocket(this.resume === null ? this.url : `${this.url}?resume=${this.resume}`);
    this.socket = socket;
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerMessage;
      this.frames.push(frame);
      if (frame.type === "dev_reload" && frame.state === "reloading" && frame.resume !== undefined) {
        this.resume = frame.resume;
      }
      if (frame.type === "agents") this.resume = null;
      this.wake();
    });
    socket.on("close", () => {
      if (!this.closed) setTimeout(() => this.open(), 50);
    });
    socket.on("error", () => {});
  }

  send(message: object): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** The first frame after `from` (an index into `frames`) that `match` accepts. */
  async next<T extends ServerMessage["type"]>(
    type: T,
    from: number,
    match: (frame: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<{ frame: Extract<ServerMessage, { type: T }>; index: number }> {
    let index = from;
    for (;;) {
      for (; index < this.frames.length; index += 1) {
        const frame = this.frames[index];
        if (frame.type === type && match(frame as Extract<ServerMessage, { type: T }>)) {
          return { frame: frame as Extract<ServerMessage, { type: T }>, index };
        }
      }
      const left = this.deadline - Date.now();
      const woke = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(left, 0));
        this.wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      if (!woke) {
        throw new Error(`no ${type} frame after #${from}: ${JSON.stringify(this.frames.slice(from).map((frame) => frame.type))}`);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.terminate();
  }
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

/** `curb dev` on the project at `root`, as a project runs it; resolves once it is ready. */
async function startCurbDev(root: string, port: number): Promise<{ dev: ChildProcess; output: () => string }> {
  let output = "";
  const env: NodeJS.ProcessEnv = { ...process.env, KUGEL_CONVERSATIONS_DB: join(root, ".data", "conversations.jsonl") };
  delete env.AGENT_PROJECT_DIR;
  delete env.TSX_TSCONFIG_PATH;
  // The store is off under the test runner; this test needs it, in its own temp file.
  delete env.VITEST;
  // The keys come from the project's .env this test writes. The agent server loads it with
  // process.loadEnvFile, which never overrides a variable that is already set, even empty:
  // a CI runner that exports AZURE_SPEECH_KEY="" made the voice check stop at the speech
  // key instead of reaching LiveKit (PR #5041, framework unit on Linux).
  for (const name of ["ANTHROPIC_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "KUGELAUDIO_API_KEY", "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
    delete env[name];
  }
  const bin = fileURLToPath(new URL("../../bin/curb.js", import.meta.url));
  const dev = spawn(process.execPath, [bin, "dev", "--no-open", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`curb dev did not start:\n${output}`)), BOOT_TIMEOUT_MS - 10_000);
    const read = (chunk: Buffer) => {
      output += String(chunk);
      if (!output.includes("Ready in")) return;
      clearTimeout(timer);
      resolve();
    };
    dev.stdout!.on("data", read);
    dev.stderr!.on("data", read);
    dev.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`curb dev did not start:\n${output}`));
    });
  });
  return { dev, output: () => output };
}

async function stopCurbDev(dev: ChildProcess | undefined): Promise<void> {
  if (!dev || dev.exitCode !== null) return;
  const exited = new Promise((resolve) => dev.once("exit", resolve));
  dev.kill("SIGTERM");
  await exited;
}

/**
 * An OpenAI-compatible model on 127.0.0.1: its first answer calls `tool`, every later one
 * says `reply`. Counts the requests it got.
 */
async function scriptedModel(tool: string, reply: string): Promise<{ url: string; requests(): number; close(): void }> {
  let requests = 0;
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      requests += 1;
      const callsTool = requests === 1;
      const toolCalls = [{ index: 0, id: `call_${requests}`, type: "function", function: { name: tool, arguments: "{}" } }];
      const finish = callsTool ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if ((JSON.parse(body) as { stream?: boolean }).stream !== true) {
        const message = callsTool ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: reply };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "stub", created: 0, model: "stub", choices: [{ index: 0, message, finish_reason: finish }], usage }));
        return;
      }
      const delta = callsTool ? { role: "assistant", tool_calls: toolCalls } : { role: "assistant", content: reply };
      const chunk = (choice: object, extra: object = {}) =>
        `data: ${JSON.stringify({ id: "stub", created: 0, model: "stub", choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ delta, finish_reason: null }));
      response.write(chunk({ delta: {}, finish_reason: finish }, { usage }));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests: () => requests, close: () => void server.close() };
}

/**
 * `curb dev` as a project runs it (the bin shim, tsx, a real agent server child process),
 * against a project in a temp directory, driven over the agent socket the way the preview
 * drives it. Hermetic: every socket is on 127.0.0.1, and no turn reaches a model. The tests
 * run in order on one `curb dev`, because each start costs as much as several reloads.
 */
describe("curb dev reloading the agent on save", () => {
  const root = createTestProject({
    "src/agent/agent.tsx": AGENT,
    "src/agent/notes/skill.tsx": SKILL,
    "src/lib/greeting.ts": 'export function greeting() {\n  return "Welcome.";\n}\n',
    // No LLM key yet: the first test saves one.
    ".env": "KUGELAUDIO_API_KEY=\n",
  });
  let dev: ChildProcess | undefined;
  let printed = () => "";
  let port = 0;

  beforeAll(async () => {
    port = await freePort();
    ({ dev, output: printed } = await startCurbDev(root, port));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stopCurbDev(dev);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Onboarding sweep 2026-10-25: a customer without an LLM key saw only "Your agent is not
   * running", with no Context column, so they could not see what had been built for them.
   */
  it("shows the agent with the missing key named, and clears it once .env has the key", async () => {
    const page = new Page(`ws://127.0.0.1:${port}/`);
    try {
      const missing = await page.next("missing_keys", 0);
      expect(missing.frame.agentId).toBe("agent");
      expect(missing.frame.diagnostics).toEqual([
        expect.objectContaining({ code: "AGENT_INVALID_AUTHORING_PROP", message: expect.stringContaining("needs KUGELAUDIO_API_KEY") }),
      ]);
      // Everything the Context column shows, from source, with no model.
      const agents = await page.next("agents", missing.index);
      expect(agents.frame.active.skills.map((skill) => skill.path)).toEqual(["/notes"]);
      const context = await page.next("context", missing.index);
      expect(context.frame.context.systemPrompt).toContain("You are a test agent.");
      expect(page.frames.some((frame) => frame.type === "agent_unavailable")).toBe(false);

      // Present so a conversation can start; nothing in these tests calls the model.
      writeFileSync(join(root, ".env"), "KUGELAUDIO_API_KEY=not-used-by-this-test\n");
      const reloading = await page.next("dev_reload", context.index, (frame) => frame.state === "reloading");
      const cleared = await page.next("missing_keys", reloading.index);
      expect(cleared.frame).toEqual({ type: "missing_keys", agentId: "agent", diagnostics: [] });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- curb dev output ---\n${printed()}`);
    } finally {
      page.close();
    }
  }, TEST_TIMEOUT_MS);

  it("serves the saved code on the same conversation, and survives an edit that does not compile", async () => {
    const page = new Page(`ws://127.0.0.1:${port}/`);
    try {
      const first = await page.next("context", 0);
      expect(first.frame.context.systemPrompt).toContain("You are a test agent.");

      // A conversation the store records, without a model call: the page opens a skill.
      page.send({ type: "read_skill", skill: "/notes" });
      const recorded = await page.next("messages", first.index, (frame) => frame.messages.length === 1);

      // Save a new prompt: the page reconnects to an agent running it, on the same conversation.
      const agentFile = join(root, "src", "agent", "agent.tsx");
      writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("You are a test agent.", "Always end with BANANA."));
      const reloading = await page.next("dev_reload", recorded.index, (frame) => frame.state === "reloading");
      expect(reloading.frame).toMatchObject({ files: ["src/agent/agent.tsx"], resume: expect.any(Number) });
      const stored = `stored-${(reloading.frame as { resume: number }).resume}`;
      const reloaded = await page.next("context", reloading.index);
      expect(reloaded.frame.context.systemPrompt).toContain("Always end with BANANA.");
      const resumed = await page.next("conversations", reloading.index);
      expect(resumed.frame.active).toBe(stored);
      expect(resumed.frame.conversations.map((conversation) => conversation.id)).toEqual([stored]);
      const restored = await page.next("messages", reloading.index);
      expect(restored.frame.messages.map((message) => (message.role === "user" ? message.kind : message.role))).toEqual([
        "context_event",
      ]);

      // A helper the agent imports stops compiling: curb dev stays up and says where.
      const helper = join(root, "src", "lib", "greeting.ts");
      writeFileSync(helper, 'export function greeting() {\n  return "Welcome." +;\n}\n');
      const broken = await page.next("agent_unavailable", restored.index);
      expect(broken.frame.diagnostics[0]).toMatchObject({
        message: 'The agent could not be loaded: its code does not compile: Unexpected ";"',
        location: { source: "src/lib/greeting.ts", line: 2, column: 22 },
      });
      expect(dev?.exitCode).toBeNull();

      // Fixed: back on the agent, the helper's new text in its context, still the same conversation.
      writeFileSync(helper, 'export function greeting() {\n  return "Welcome back.";\n}\n');
      const recovered = await page.next("context", broken.index, (frame) =>
        JSON.stringify(frame.context).includes("Welcome back."),
      );
      expect(recovered.frame.context.systemPrompt).toContain("Always end with BANANA.");
      const stillOn = await page.next("conversations", broken.index);
      expect(stillOn.frame.active).toBe(stored);

      // One line per reload in the terminal, naming the changed file.
      expect(printed()).toMatch(/dev +reloaded src\/agent\/agent\.tsx in \S+/);
      expect(printed()).toMatch(/dev +src\/lib\/greeting\.ts: The agent could not be loaded: its code does not compile/);
      expect(printed()).toMatch(/dev +reloaded src\/lib\/greeting\.ts in \S+/);
    } catch (error) {
      // What curb dev printed is what explains a failure here.
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- curb dev output ---\n${printed()}`);
    } finally {
      page.close();
    }
  }, TEST_TIMEOUT_MS);

  it("reloads on a saved .env, and asks curb dev itself for the call's LiveKit server", async () => {
    const page = new Page(`ws://127.0.0.1:${port}/`);
    try {
      const first = await page.next("agents", 0);
      // Voice keys (never used: the call fails before it reaches a provider) and a LiveKit
      // deployment that is missing its key, which curb dev refuses without a network call.
      writeFileSync(
        join(root, ".env"),
        [
          "AZURE_SPEECH_KEY=not-used-by-this-test",
          "KUGELAUDIO_API_KEY=not-used-by-this-test",
          "LIVEKIT_URL=ws://127.0.0.1:9",
          "",
        ].join("\n"),
      );
      const reloading = await page.next("dev_reload", first.index, (frame) => frame.state === "reloading");
      expect(reloading.frame.files).toEqual([".env"]);
      const reloaded = await page.next("agents", reloading.index);

      // The reloaded agent server opens its own rooms from the .env as it is now: half a
      // LiveKit configuration is refused, never quietly run as a local call.
      page.send({ type: "voice_start" });
      const refused = await page.next("error", reloaded.index, (frame) => frame.scope === "voice");
      expect(refused.frame.message).toMatch(/LIVEKIT_API_KEY, LIVEKIT_API_SECRET missing/);

      // The failed call is not live: the next save reloads at once instead of waiting for it.
      const agentFile = join(root, "src", "agent", "agent.tsx");
      writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace("Always end with BANANA.", "Always end with KIWI."));
      const next = await page.next("dev_reload", refused.index);
      expect(next.frame.state).toBe("reloading");
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- curb dev output ---\n${printed()}`);
    } finally {
      page.close();
    }
  }, TEST_TIMEOUT_MS);
});

/** An agent whose one tool has a side effect: it appends a line to a file under `src/`, so
 * each run also changes the agent's files. */
const BOOKING_AGENT = `import { appendFileSync, mkdirSync } from "node:fs";
import { Agent, GlobalTools, Skill, Skills, SystemPrompt, Tool, defineAgent } from "curb";
import { openaiCompatible } from "curb/providers";

const bookings = new URL("../data/bookings.txt", import.meta.url);

export function App() {
  return (
    <Agent llm={openaiCompatible({ baseURL: process.env.SCRIPTED_MODEL_URL ?? "", model: "scripted" })}>
      <SystemPrompt>{\`You book appointments.\`}</SystemPrompt>
      <Skills>
        <Skill path="/" description="Start here.">Home</Skill>
      </Skills>
      <GlobalTools>
        <Tool
          name="book"
          description="Book the appointment."
          onSubmit={() => {
            mkdirSync(new URL(".", bookings), { recursive: true });
            appendFileSync(bookings, "booked\\n");
            return { ok: true };
          }}
        />
      </GlobalTools>
    </Agent>
  );
}

export const agent = defineAgent({ app: App, initialPath: "/" });
`;

/**
 * A tool's side effect (a booking, an email) happens once. Reloading the agent used to replay
 * every tool call of the conversation onto the new server, so each save booked again, and a
 * tool that writes under `src/` reloaded the agent again and again, one booking per reload.
 */
describe("curb dev reloading a conversation whose tool has a side effect", () => {
  let root = "";
  let dev: ChildProcess | undefined;
  let printed = () => "";
  let port = 0;
  let model: Awaited<ReturnType<typeof scriptedModel>> | undefined;

  beforeAll(async () => {
    model = await scriptedModel("book", "Booked.");
    root = createTestProject({
      "src/agent/agent.tsx": BOOKING_AGENT,
      "src/agent/skill.tsx": SKILL,
      "src/lib/greeting.ts": 'export function greeting() {\n  return "Welcome.";\n}\n',
      ".env": `SCRIPTED_MODEL_URL=${model.url}\n`,
    });
    port = await freePort();
    ({ dev, output: printed } = await startCurbDev(root, port));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stopCurbDev(dev);
    model?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("runs the tool once, keeps the conversation across every reload, and never reloads on its own", async () => {
    const page = new Page(`ws://127.0.0.1:${port}/`);
    const bookings = join(root, "src", "data", "bookings.txt");
    const booked = () => (existsSync(bookings) ? readFileSync(bookings, "utf8").split("\n").filter(Boolean).length : 0);
    const agentFile = join(root, "src", "agent", "agent.tsx");
    try {
      const first = await page.next("agents", 0);
      page.send({ type: "user_text", text: "Book me in, please." });
      const answered = await page.next("messages", first.index, (frame) =>
        frame.messages.some((message) => message.role === "assistant" && message.content === "Booked."),
      );
      expect(booked()).toBe(1);

      // The booking wrote under src/, which reloads the agent once; the page stays on its conversation.
      const afterTool = await page.next("dev_reload", answered.index, (frame) => frame.state === "reloading");
      const resume = (afterTool.frame as { resume?: number }).resume;
      expect(resume).toEqual(expect.any(Number));
      let back = await page.next("conversations", afterTool.index, (frame) => frame.active === `stored-${resume}`);

      // Two saves of the agent: two reloads, each back on the same conversation.
      for (const prompt of ["You book appointments. Be brief.", "You book appointments. Be kind."]) {
        writeFileSync(agentFile, readFileSync(agentFile, "utf8").replace(/You book appointments\.[^`]*/, prompt));
        const reloading = await page.next("dev_reload", back.index, (frame) => frame.state === "reloading");
        expect((reloading.frame as { resume?: number }).resume).toBe(resume);
        back = await page.next("conversations", reloading.index, (frame) => frame.active === `stored-${resume}`);
        const context = await page.next("context", reloading.index);
        expect(context.frame.context.systemPrompt).toContain(prompt);
        await page.next("messages", reloading.index);
      }

      // Nothing reloads on its own: the last reload restored the conversation, and well past
      // the watcher's 200 ms debounce there are still three reloads and one booking.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const reloads = page.frames.filter((frame) => frame.type === "dev_reload" && frame.state === "reloading");
      expect(reloads).toHaveLength(3);
      expect(booked()).toBe(1);
      expect(model!.requests()).toBe(2);

      // The conversation came back whole: the caller's words, the call, its result, the reply.
      const transcript = page.frames.filter((frame) => frame.type === "messages").at(-1);
      expect(transcript?.type === "messages" && transcript.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- curb dev output ---\n${printed()}`);
    } finally {
      page.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe("curb dev with a realtime session URL", () => {
  it("refuses a LiveKit key beside it before anything starts", async () => {
    const root = createTestProject({
      ".env": "CURB_REALTIME_SESSION_URL=http://127.0.0.1:7682/realtime-session\nLIVEKIT_API_SECRET=from-the-env-file\n",
    });
    try {
      const { runDev } = await import("./dev.js");
      await expect(
        runDev({ projectRoot: root, baseEnv: { LIVEKIT_API_KEY: "from-the-shell" }, open: false }),
      ).rejects.toThrow(/CURB_REALTIME_SESSION_URL is set.*Remove LIVEKIT_API_KEY, LIVEKIT_API_SECRET from/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
