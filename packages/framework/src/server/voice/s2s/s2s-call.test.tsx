import { initializeLogger } from "@livekit/agents";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSession } from "../../../agent-session.js";
import { Agent, Instruction, Skill, Skills, SystemPrompt, Tool } from "../../../components.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import { openai, type S2sDescriptor } from "../../../providers.js";
import { agentAppElement, type AgentRoute } from "../../../routing.js";
import { AgentSiteRuntime } from "../../../runtime.js";
import { startFakeLiveModel } from "../../../test-fixtures/fake-live-model.js";
import { startFakeRealtimeModel } from "../../../test-fixtures/fake-realtime-model.js";
import type { VoiceCallRoom } from "../call-room.js";
import { startVoiceAgent } from "../livekit-host/host.js";
import { PageAudioInput, PageAudioOutput } from "../local-host/local-call-room.js";
import { createSynchronizer } from "../local-host/synchronizer.js";
import { commentaryPieces } from "./back-office.js";

/**
 * A call on `<Agent s2s>`, through the real voice host, LiveKit's `GPTLiveModel` and Curb's real
 * session, on the local call's audio sinks. Only the model, the page and `llm` are fakes.
 */

function fakePage() {
  let startedAt = 0;
  let bytes = 0;
  const box: { output: PageAudioOutput | null; input: PageAudioInput | null } = { output: null, input: null };
  const send = (message: unknown) => {
    if (Buffer.isBuffer(message)) {
      startedAt ||= Date.now();
      bytes += message.length;
      return;
    }
    const finish = (type: string, playedMs: number, delay: number) =>
      setTimeout(() => {
        startedAt = 0;
        bytes = 0;
        box.output?.report({ type, playedMs } as never);
      }, delay);
    const kind = (message as { type: string }).type;
    if (kind === "audio_flush") {
      const ms = bytes / 48;
      finish("playout_finished", ms, Math.max(0, ms - (Date.now() - startedAt)));
    }
    if (kind === "audio_clear") finish("playout_cleared", Date.now() - startedAt, 2);
  };
  box.output = new PageAudioOutput(send as never);
  return box;
}

const ran: string[] = [];

function ReportClaim() {
  const [verified, setVerified] = useState(false);
  return (
    <>
      {verified ? "The policy is verified." : "No policy is verified."}
      <Tool
        name="verify_policy"
        description="Check the policy."
        schema={z.object({ policy: z.string() })}
        onSubmit={({ policy }) => {
          ran.push(`verify_policy ${policy}`);
          setVerified(true);
          return { ok: true, message: "Verified." };
        }}
      />
      {verified ? (
        <Tool
          name="book_meeting"
          description="Book the slot."
          schema={z.object({ slot: z.string() })}
          confirm={({ slot }) => `Book ${slot}: is that right?`}
          onSubmit={({ slot }) => {
            ran.push(`book_meeting ${slot}`);
            return { ok: true, message: `Booked ${slot}.` };
          }}
        />
      ) : null}
    </>
  );
}
/** A step-by-step procedure: the back office runs it, so the model never reads it. */
const PROCEDURE = "First ask for the policy number, then verify it, then offer a meeting.";
const routes: AgentRoute[] = [
  { path: "/report-claim", Component: ReportClaim, meta: { title: "Report a claim", description: "Reporting damage." } },
];
function App({ s2s }: { s2s: S2sDescriptor }) {
  return (
    <Agent s2s={s2s}>
      <SystemPrompt>You answer the phone at an insurer.</SystemPrompt>
      <Instruction>{PROCEDURE}</Instruction>
      <Skills>
        {routes.map((route) => (
          <Skill key={route.path} path={route.path}>
            {route.meta?.title}
          </Skill>
        ))}
      </Skills>
    </Agent>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await sleep(10);
  }
}

type Step = { text?: string; calls?: Array<{ name: string; input?: Record<string, unknown> }> };
type CallOptions = { env?: Record<string, string>; firstLine?: string; steps?: Step[]; firstTurn?: "agent"; quietMs?: number };

async function call(options: CallOptions & { greeting?: string; drops?: boolean } = {}) {
  const model = await startFakeLiveModel({ greeting: options.greeting, drops: options.drops });
  const s2s = openai.live({ baseURL: model.baseURL, voice: "marin" });
  open.push(async () => void (await model.close()));
  const parts = await callOn(s2s, options, () => model.start() !== undefined);
  return { model, ...parts };
}

/** The call's record, as a host reads it. */
function fakeRecord() {
  const turns: Array<{ speaker: "caller" | "agent"; text: string; final: boolean }> = [];
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const reporter: CallReporter = {
    turn: (turn) => void turns.push(turn),
    event: (name, payload) => void events.push({ name, payload }),
    finish: async () => {},
    undelivered: 0,
  };
  return { reporter, turns, events, tools: () => events.filter((event) => event.name === "tool").map((event) => event.payload) };
}

/** 100 ms of a caller speaking at a normal level, at the page's 16 kHz. */
const SPEECH = Buffer.from(new Int16Array(1600).fill(4000).buffer);

async function callOn(s2s: S2sDescriptor, options: CallOptions, started: () => boolean) {
  const Site = () => <App s2s={s2s} />;
  const runtime = new AgentSiteRuntime(({ path, loadedPaths }) => agentAppElement(Site, { path, loadedPaths, routes }), {
    maxLoadedSkills: 2,
  });
  const steps = options.steps ?? [];
  const llm = vi.fn(async () => {
    const step = steps.shift() ?? { text: "Done." };
    return {
      text: step.text ?? "",
      toolCalls: (step.calls ?? []).map((tool, index) => ({ id: `c${index}`, name: tool.name, input: tool.input ?? {} })),
    };
  });
  const session = new AgentSession(runtime, llm, {
    ...(options.firstLine ? { opening: () => options.firstLine! } : {}),
  });
  const page = fakePage();
  const room: VoiceCallRoom = {
    name: "call",
    participants: () => [{ identity: "browser" }],
    onParticipantConnected: () => {},
    onParticipantDisconnected: () => {},
    onDisconnected: () => {},
    startSession: async ({ session: live, agent }) => {
      page.input = new PageAudioInput();
      const sync = await createSynchronizer(page.output!, {
        captureText: async () => {},
        flush: () => {},
        onAttached: () => undefined,
        onDetached: () => undefined,
      } as never);
      live.input.audio = page.input;
      live.output.audio = sync.audioOutput;
      live.output.transcription = sync.textOutput;
      await live.start({ agent });
    },
    publishTransferTrack: () => Promise.reject(new Error("no phone line")),
    disconnect: async () => {},
  };
  const closed = vi.fn();
  const record = fakeRecord();
  const spoken: string[] = [];
  const handle = await startVoiceAgent({
    room,
    roomName: "call",
    bundle: { runtime, session } as never,
    client: { bind: () => {}, detach: () => {} } as never,
    env: { ...(options.env ?? { OPENAI_API_KEY: "test-key" }), ...(options.quietMs ? { VOICE_SILENCE_FOLLOWUP_MS: String(options.quietMs) } : {}) } as never,
    onClosed: closed,
    reporter: record.reporter,
    // What the model said, as LiveKit hands it to the call: kept or not, every line is here.
    pipeline: {
      onSession: ({ session: live, events }) =>
        void live.on(events.ConversationItemAdded, ({ item }) => {
          if (item.type === "message" && item.role === "assistant") spoken.push(item.textContent ?? "");
        }),
    },
    ...(options.firstTurn ? { firstTurn: options.firstTurn } : {}),
  });
  await until(started, "the session started");
  // A live microphone: LiveKit ends a caller's line after 800 ms of it with no new words.
  // `speaking` puts the caller's voice on it, with no transcript: OpenAI Live allows a session to
  // send the caller's transcript only once their line is done, and to send no speech-start event.
  const mic = { speaking: false };
  const microphone = setInterval(() => page.input?.push(mic.speaking ? SPEECH : Buffer.alloc(3200)), 100);
  const said = (role: "user" | "assistant") => session.messages.filter((m) => m.role === role && m.content && !("kind" in m && m.kind)).map((m) => m.content);
  open.push(async () => {
    clearInterval(microphone);
    await handle.close();
  });
  return { session, runtime, handle, llm, said, closed, record, mic, spoken };
}
const open: Array<() => Promise<void>> = [];
/** session.start holds these and nothing else. */
const LIVE_SESSION_FIELDS = ["audio", "delegation", "instructions", "model"];

beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));
afterEach(async () => {
  ran.length = 0;
  // Newest first: the call hangs up before its model goes away.
  for (const cleanup of open.splice(0).reverse()) await cleanup();
});

describe("a call on <Agent s2s>", { timeout: 12_000 }, () => {
  it("starts the model with the agent's prompt and what it can hand over, and no speech providers", async () => {
    const { model } = await call();
    const start = model.start();
    expect(model.authorization).toEqual(["Bearer test-key"]);
    expect(Object.keys(start).sort()).toEqual(LIVE_SESSION_FIELDS);
    expect(start.delegation).toEqual({ type: "client" });
    expect(start.audio.output.voice).toBe("marin");
    expect(start.instructions).toContain("You answer the phone at an insurer.");
    expect(start.instructions).toContain("A back office works behind you");
    expect(start.instructions).toContain("Report a claim");
    expect(start.instructions).not.toContain("read_skill");
  });

  it("keeps the agent's <Instruction> procedure for llm, out of what the model reads", async () => {
    const { model, llm } = await call({ steps: [{ text: "Policy noted." }] });
    expect(model.start().instructions).not.toContain(PROCEDURE);
    model.callerSays("My policy is P-1.", { delegate: true });
    await until(() => model.commentary().length === 1, "the delegation was answered");
    expect(JSON.stringify(llm.mock.calls[0])).toContain(PROCEDURE);
  });

  it("reports the back office's tool calls to the call's record, in the shape a cascaded call does", async () => {
    const { model, record, session } = await call({
      steps: [
        { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
        { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
        { text: "Policy P-1 is verified." },
      ],
    });
    model.callerSays("My policy is P-1.", { delegate: true });
    await until(() => model.commentary().length === 1, "the result went back");
    expect(record.tools()).toEqual([
      { name: "read_skill", arguments: { skill: "/report-claim" }, ok: true },
      { name: "verify_policy", arguments: { policy: "P-1" }, ok: true, skillPath: "/report-claim" },
    ]);
    // The conversation keeps them too, which is what the preview shows.
    expect(session.messages.flatMap((message) => ("toolCalls" in message ? (message.toolCalls ?? []) : [])).map((tool) => tool.name)).toEqual(["read_skill", "verify_policy"]);
  });

  it("reports a call held for the caller's yes as held, with its read-back", async () => {
    const { model, session, record } = await call({
      steps: [
        { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
        { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
        { calls: [{ name: "book_meeting", input: { slot: "Tuesday" } }] },
      ],
    });
    model.callerSays("Book Tuesday.", { delegate: true });
    await until(() => session.pendingConfirmation !== null && model.commentary().length === 1, "the action was held");
    expect(record.tools().at(-1)).toEqual({
      name: "book_meeting",
      arguments: { slot: "Tuesday" },
      ok: false,
      skillPath: "/report-claim",
      heldFor: "Book Tuesday: is that right?",
    });
  });

  it("keeps one caller line, and one in the record, when the model sends the line again as it grows", async () => {
    const { model, said, record } = await call();
    model.callerSays("A table for four");
    await sleep(2100);
    model.callerSays("A table for four at eight");
    await sleep(2100);
    model.callerSays("A table for four at eight thirty");
    await sleep(1200);
    await model.say("Thanks, one moment.");
    await until(() => said("assistant").includes("Thanks, one moment."), "the model answered");
    expect(said("user")).toEqual(["A table for four at eight thirty"]);
    expect(record.turns).toEqual([
      { speaker: "caller", text: "A table for four at eight thirty", final: true },
      { speaker: "agent", text: "Thanks, one moment.", final: true },
    ]);
  });

  it("reports a caller's turn the model heard in parts as one line, once the turn is over", async () => {
    const { model, said, record } = await call();
    model.callerSays("A table for four");
    await sleep(2100);
    model.callerSays("at eight thirty.");
    await sleep(1200);
    expect(record.turns).toEqual([]);
    await model.say("Thanks.");
    await until(() => said("assistant").includes("Thanks."), "the model answered");
    expect(record.turns.map((turn) => turn.text)).toEqual(["A table for four at eight thirty.", "Thanks."]);
  });

  it("sends the caller's audio to the model and keeps a turn it answered alone, with no LLM call", async () => {
    const { model, said, llm } = await call();
    await until(() => model.appendedBytes() > 0, "audio reached the model");
    model.callerSays("Hello there.");
    await sleep(50);
    await model.say("Hi, how can I help?");
    await until(() => said("user").length >= 1 && said("assistant").length >= 1, "the lines were recorded");
    model.callerSays("Just checking.");
    expect(said("user")[0]).toBe("Hello there.");
    expect(said("assistant")[0]).toContain("Hi, how can I help?");
    expect(llm).not.toHaveBeenCalled();
  });

  it("runs a delegated turn on llm through skills and tools, and answers that delegation", async () => {
    const { model, said, llm } = await call({
      steps: [
        { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
        { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
        { text: "Policy P-1 is verified." },
      ],
    });
    model.callerSays("My policy is P-1.", { delegate: true });
    await until(() => model.commentary().length === 1, "the result went back");
    expect(model.commentary()[0]).toMatchObject({ content: "Policy P-1 is verified.", delegation_id: expect.stringMatching(/^del_/) });
    expect(ran).toEqual(["verify_policy P-1"]);
    expect(llm).toHaveBeenCalledTimes(3);
    await until(() => said("assistant").some((line) => line.includes("Policy P-1 is verified.")), "the model said it");
    expect(said("user").filter((line) => line === "My policy is P-1.")).toHaveLength(1);
  });

  it("holds a confirm tool, sends its read-back, and runs it on the caller's yes without a delegation", async () => {
    const { model, session, said } = await call({
      steps: [
        { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
        { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
        { calls: [{ name: "book_meeting", input: { slot: "Tuesday" } }] },
        { text: "yes" },
        { text: "You are booked for Tuesday." },
      ],
    });
    model.callerSays("Book Tuesday.", { delegate: true });
    await until(() => session.pendingConfirmation !== null && model.commentary().length === 1, "the action was held");
    expect(model.commentary()[0]?.content).toContain("Book Tuesday: is that right?");
    expect(ran).toEqual(["verify_policy P-1"]);
    await until(() => said("assistant").some((line) => line.includes("is that right?")), "the model asked");

    model.callerSays("Yes, that's right.");
    await model.say("One moment.");
    await until(() => ran.length === 2, "the action ran");
    expect(ran).toEqual(["verify_policy P-1", "book_meeting Tuesday"]);
    await until(() => model.commentary().length === 2, "the result went back");
  });

  it("offers llm no tool that ends a handed-over job with nothing", async () => {
    const { model, llm } = await call({ steps: [{ text: "What is your account number?" }] });
    model.callerSays("Uh.", { delegate: true });
    await until(() => model.commentary().length === 1, "the delegation was answered");
    const [request] = llm.mock.calls[0] as unknown as [{ tools: Array<{ name: string }> }];
    expect(request.tools.map((tool) => tool.name)).not.toContain("skip_turn");
    expect(JSON.stringify(request)).toContain("never with nothing");
    expect(model.start().instructions).not.toContain("never with nothing");
  });

  it("gives every delegation an answer, even from an empty turn", async () => {
    const { model } = await call({ steps: [{ text: "[pauses]" }, { text: "[pauses]" }] });
    model.callerSays("Mhm.", { delegate: true });
    await until(() => model.commentary().length === 1, "the delegation was answered");
    expect(model.commentary()[0]?.content).toContain("Nothing to add");
  });

  it("records the model's words, not the back office's, when it answers a delegation", async () => {
    const { model, said } = await call({ steps: [{ text: "Back office wording." }] });
    model.callerSays("A question.", { delegate: true });
    await until(() => model.commentary().length === 1, "the result went back");
    await until(() => said("assistant").includes("Back office wording."), "the model said it");
    expect(said("assistant")).toEqual(["Back office wording."]);
  });

  it("joins a line a pause cut in two", async () => {
    const { model, said } = await call();
    model.callerSays("My number is P");
    await sleep(1000);
    model.callerSays("1234.");
    await until(() => said("user").join(" ").includes("1234."), "the second part was recorded", 3000);
    expect(said("user")).toEqual(["My number is P 1234."]);
  });

  it("asks llm after a quiet spell, so a goodbye the model answered alone still ends the call", async () => {
    const { model, closed, llm, said } = await call({ steps: [{ calls: [{ name: "end_call", input: { goodbye: "Thanks, bye." } }] }] });
    model.callerSays("That's all, bye.");
    await sleep(50);
    await model.say("Goodbye!");
    await until(() => said("assistant").includes("Goodbye!"), "the model answered alone");
    expect(llm).not.toHaveBeenCalled();
    await until(() => closed.mock.calls.length === 1, "the call ended", 10_000);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("stays on the call and says nothing when llm finds it is not over", async () => {
    const { model, closed, llm, said } = await call({ steps: [{ text: "Waiting." }] });
    model.callerSays("Let me think.");
    await sleep(50);
    await model.say("Take your time.");
    await until(() => said("assistant").includes("Take your time."), "the model answered alone");
    await until(() => llm.mock.calls.length === 1, "llm was asked", 8000);
    await sleep(300);
    expect(closed).not.toHaveBeenCalled();
    expect(model.commentary()).toEqual([]);
  });

  it("never checks in while the caller is speaking, though the model sent no transcript yet", async () => {
    const { model, llm, said, mic } = await call({ quietMs: 400, steps: [{ text: "How many people is the table for?" }] });
    model.callerSays("Let me find it.");
    await sleep(50);
    await model.say("Sure, take your time.");
    await until(() => said("assistant").includes("Sure, take your time."), "the model answered alone");
    mic.speaking = true;
    await sleep(1500);
    mic.speaking = false;
    await sleep(1000);
    // The caller spoke after that line: the model answers them, so nothing checks in for it.
    expect(llm).not.toHaveBeenCalled();
    expect(model.commentary()).toEqual([]);

    await model.say("Are you still there?");
    await until(() => llm.mock.calls.length === 1, "llm was asked after a real quiet");
  });

  it("checks in once per line of the model's, however long the quiet lasts", async () => {
    const { model, llm, said } = await call({ quietMs: 300, steps: [{ text: "Waiting." }] });
    model.callerSays("Let me think.");
    await sleep(50);
    await model.say("Take your time.");
    await until(() => said("assistant").includes("Take your time."), "the model answered alone");
    await until(() => llm.mock.calls.length === 1, "llm was asked");
    await sleep(1200);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("gives the model nothing to say from a check-in that did not end the call", async () => {
    const { model, llm, said, closed, record } = await call({ quietMs: 300, steps: [{ text: "How many people is the table for?" }] });
    model.callerSays("Let me think.");
    await sleep(50);
    await model.say("Take your time.");
    await until(() => said("assistant").includes("Take your time."), "the model answered alone");
    await until(() => llm.mock.calls.length === 1, "llm was asked");
    await sleep(500);
    expect(model.commentary()).toEqual([]);
    expect(closed).not.toHaveBeenCalled();
    expect(said("assistant")).toEqual(["Take your time."]);
    expect(record.turns.map((turn) => turn.text)).toEqual(["Let me think.", "Take your time."]);
  });

  it("tells the model to hand over the end of the call, since only the back office can hang up", async () => {
    const { model } = await call();
    expect(model.start().instructions).toContain("You cannot hang up.");
  });

  it("hangs up after the model said the goodbye", async () => {
    const { model, closed } = await call({
      steps: [{ calls: [{ name: "end_call", input: { goodbye: "Thanks for calling." } }] }],
    });
    model.callerSays("That's all, bye.", { delegate: true });
    await until(() => model.commentary().length === 1, "the goodbye went to the model");
    expect(model.commentary()[0]?.content).toContain("Thanks for calling.");
    expect(closed).not.toHaveBeenCalled();
    await until(() => closed.mock.calls.length === 1, "the call closed", 8000);
    expect(model.received.some((event) => event.type === "session.close")).toBe(true);
  });

  it("ends the call when the model keeps dropping it, instead of reconnecting for ever", async () => {
    const { model, closed } = await call({ drops: true });
    await until(() => closed.mock.calls.length === 1, "the call ended");
    const starts = model.received.filter((event) => event.type === "session.start").length;
    expect(starts).toBeLessThanOrEqual(6);
    await sleep(300);
    expect(model.received.filter((event) => event.type === "session.start").length).toBe(starts);
  });

  it("has the model say a fixed first line once, and records it once, as a cascaded call does", async () => {
    const { model, said, record, spoken } = await call({ firstLine: "Hello, this is the claims line." });
    await until(() => model.commentary().length === 1, "the model was asked to open");
    expect(model.commentary()[0]?.content).toContain('"Hello, this is the claims line."');
    expect(model.start().instructions).not.toContain("Hello, this is the claims line.");
    // The fake model says the whole commentary: that is its opening line.
    await sleep(1500);
    model.callerSays("Hi.");
    await until(() => spoken.length === 1, "the model's opening was transcribed");
    await sleep(100);
    expect(said("assistant")).toEqual(["Hello, this is the claims line."]);
    expect(record.turns.filter((turn) => turn.speaker === "agent").map((turn) => turn.text)).toEqual(["Hello, this is the claims line."]);
    expect(model.commentary()).toHaveLength(1);
  });

  it("answers typed words through the back office, which the model cannot hear", async () => {
    const { model, handle } = await call({ steps: [{ text: "Typed answer." }] });
    await handle.sendText("Typed question.");
    await until(() => model.commentary().length === 1, "the answer went back");
    expect(model.commentary()[0]).toMatchObject({ content: "Typed answer.", delegation_id: null });
  });
});

describe("a call on openai.live()", { timeout: 12_000 }, () => {
  it("is the same call, and the model is asked to open it", async () => {
    const model = await startFakeLiveModel();
    open.push(async () => void (await model.close()));
    const { said } = await callOn(openai.live({ baseURL: model.baseURL, voice: "marin" }), { firstTurn: "agent", steps: [{ text: "Done for you." }] }, () => model.start() !== undefined);
    expect(model.start().model).toBe("gpt-live-1");
    expect(Object.keys(model.start()).sort()).toEqual(LIVE_SESSION_FIELDS);
    expect(model.start().instructions).toContain("Report a claim");
    await until(() => model.commentary().length === 1, "the model was asked to open");
    expect(model.commentary()[0]?.content).toContain("Open the call now.");
    model.callerSays("Do it.", { delegate: true });
    await until(() => model.commentary().some((event) => event.content === "Done for you."), "the delegation was answered");
    await until(() => said("user").includes("Do it."), "the line was recorded");
  });

  it("connects with the key apiKeyEnv names, read from the call's environment", async () => {
    const model = await startFakeLiveModel();
    open.push(async () => void (await model.close()));
    const s2s = openai.live({ baseURL: model.baseURL, voice: "marin", apiKeyEnv: "ENDPOINT_KEY" });
    await callOn(s2s, { env: { ENDPOINT_KEY: "endpoint-key" } }, () => model.start() !== undefined);
    expect(model.authorization).toEqual(["Bearer endpoint-key"]);
  });
});

describe("a call on openai.realtime()", { timeout: 12_000 }, () => {
  const askBackOffice = (request: string) => ({ calls: [{ name: "ask_back_office", args: { request } }] });

  async function realtimeCall(steps: Step[]) {
    const model = await startFakeRealtimeModel();
    open.push(async () => model.close());
    const sent = () => (model.state.wire as Wire[]).find((event) => event.type === "session.update" && event.session?.instructions);
    const parts = await callOn(openai.realtime({ baseURL: model.baseURL, model: "fake" }), { steps }, () => sent() !== undefined);
    return { model, sent, ...parts };
  }
  type Wire = { type: string; item?: { type: string; output: string }; session?: { instructions?: string; tools?: Array<{ name: string }> } };
  const toolOutputs = (model: { state: { wire: Wire[] } }) =>
    model.state.wire.filter((event) => event.type === "conversation.item.create" && event.item?.type === "function_call_output").map((event) => event.item!.output);

  it("gives the model one tool and the agent's prompt, and none of the agent's tools", async () => {
    const { sent, model } = await realtimeCall([]);
    const wire = model.state.wire as Wire[];
    await until(() => wire.some((event) => event.type === "session.update" && event.session?.tools), "the tool was sent");
    const update = wire.find((event) => event.type === "session.update" && event.session?.tools);
    expect(update?.session?.tools?.map((tool) => tool.name)).toEqual(["ask_back_office"]);
    expect(sent()?.session?.instructions).toContain("You answer the phone at an insurer.");
    expect(model.state.authorization).toBe("Bearer test-key");
  });

  it("runs the turn on llm when the model calls it, and returns the outcome as the tool's result", async () => {
    const { model, said } = await realtimeCall([
      { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
      { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
      { text: "Policy P-1 is verified." },
    ]);
    model.state.script.push({ text: "Your policy checks out." });
    await model.callerSays("My policy is P-1.", { reply: askBackOffice("Verify policy P-1") });
    await until(() => toolOutputs(model).length === 1, "the result went back");
    expect(toolOutputs(model)[0]).toContain("Policy P-1 is verified.");
    expect(ran).toEqual(["verify_policy P-1"]);
    await until(() => said("assistant").some((line) => line.includes("Your policy checks out.")), "the model said it");
    await until(() => said("user").includes("My policy is P-1."), "the caller's line was recorded");
  });

  it("releases a held action only on the caller's own words, whatever the model calls", async () => {
    const { model, session, llm } = await realtimeCall([
      { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
      { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
      { calls: [{ name: "book_meeting", input: { slot: "Tuesday" } }] },
      { text: "yes" },
      { text: "You are booked." },
    ]);
    model.state.script.push({ text: "Book Tuesday, is that right?" });
    await model.callerSays("Book Tuesday.", { reply: askBackOffice("Book Tuesday") });
    await until(() => session.pendingConfirmation !== null, "the action was held");
    expect(ran).toEqual(["verify_policy P-1"]);

    await model.callerSays("Yes.", { reply: askBackOffice("The caller confirmed") });
    await until(() => ran.length === 2 && toolOutputs(model).length === 2, "the action ran and the call got its result");
    expect(ran).toEqual(["verify_policy P-1", "book_meeting Tuesday"]);
    expect(toolOutputs(model).at(-1)).toContain("reported this already");
    expect(llm).toHaveBeenCalledTimes(5);
    await until(() => model.responses().some((event: unknown) => JSON.stringify(event).includes("You are booked.")), "the model was told");
  });

  it("waits for the caller's own words when the model's tool call comes first", async () => {
    const { model, session, said } = await realtimeCall([
      { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
      { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
      { calls: [{ name: "book_meeting", input: { slot: "Tuesday" } }] },
      { text: "yes" },
      { text: "You are booked." },
    ]);
    model.state.script.push({ text: "Book Tuesday, is that right?" });
    await model.callerSays("Book Tuesday.", { reply: askBackOffice("Book Tuesday") });
    await until(() => session.pendingConfirmation !== null && toolOutputs(model).length === 1, "the action was held");
    await until(() => said("assistant").some((line) => line.includes("is that right?")), "the model asked");
    await sleep(1500);

    void model.toolCall(askBackOffice("The caller confirmed"));
    await sleep(300);
    expect(toolOutputs(model)).toHaveLength(1);
    expect(ran).toEqual(["verify_policy P-1"]);

    await model.callerSays("Yes.");
    await until(() => ran.length === 2, "the caller's words released it");
    await until(() => toolOutputs(model).length === 2, "the waiting tool call got the outcome");
    expect(toolOutputs(model).at(-1)).toContain("You are booked.");
    expect(said("user").filter((line) => line === "Yes.")).toHaveLength(1);
  });

  it("does not take a late transcript of what the caller said before the question as the answer", async () => {
    const { model, session, llm, said } = await realtimeCall([
      { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
      { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
      { calls: [{ name: "book_meeting", input: { slot: "Tuesday" } }] },
      { text: "no" },
      { text: "Nothing was booked." },
    ]);
    const request = model.callerStarts();
    model.state.script.push({ text: "Book Tuesday, is that right?" });
    await model.toolCall(askBackOffice("Book Tuesday"));
    await until(() => session.pendingConfirmation !== null && toolOutputs(model).length === 1, "the action was held");
    const asked = llm.mock.calls.length;

    const answer = model.callerStarts();
    request("Please book Tuesday for me.");
    await until(() => said("user").includes("Please book Tuesday for me."), "the late line was recorded");
    await sleep(300);
    expect(llm).toHaveBeenCalledTimes(asked);
    expect(session.pendingConfirmation).not.toBeNull();

    answer("No, don't.");
    await until(() => session.pendingConfirmation === null, "the caller's real answer was taken");
    expect(ran).toEqual(["verify_policy P-1"]);
  });

  it("tells the model no answer came when the caller stays silent, and runs nothing", async () => {
    const { model, session, said } = await realtimeCall([
      { calls: [{ name: "read_skill", input: { skill: "/report-claim" } }] },
      { calls: [{ name: "verify_policy", input: { policy: "P-1" } }] },
      { calls: [{ name: "book_meeting", input: { slot: "Tuesday" } }] },
    ]);
    model.state.script.push({ text: "Book Tuesday, is that right?" });
    await model.callerSays("Book Tuesday.", { reply: askBackOffice("Book Tuesday") });
    await until(() => session.pendingConfirmation !== null && toolOutputs(model).length === 1, "the action was held");
    await until(() => said("assistant").some((line) => line.includes("is that right?")), "the model asked");
    await sleep(1500);
    await model.toolCall(askBackOffice("The caller confirmed"));
    await until(() => toolOutputs(model).length === 2, "the tool call was answered", 6000);
    expect(toolOutputs(model).at(-1)).toContain("has not answered yet");
    expect(ran).toEqual(["verify_policy P-1"]);
  });

  it("keeps the model's request and the back office's words out of what the call said", async () => {
    const { model, said, session } = await realtimeCall([{ text: "Back office wording." }]);
    model.state.script.push({ text: "Spoken wording." });
    await model.callerSays("Caller wording.", { reply: askBackOffice("Model wording") });
    await until(() => said("assistant").includes("Spoken wording."), "the model spoke");
    await until(() => said("user").includes("Caller wording."), "the caller's line was recorded");
    expect(said("user")).toEqual(["Caller wording."]);
    expect(said("assistant")).toEqual(["Spoken wording."]);
    const request = session.messages.find((m) => m.content === "Model wording");
    expect(request).toMatchObject({ role: "user", kind: "synthetic" });
  });
});

describe("commentaryPieces", () => {
  it("fits a long result into appends, cut at sentences", () => {
    const pieces = commentaryPieces("A sentence goes here. ".repeat(200));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 1400 && piece.endsWith("."))).toBe(true);
    expect(commentaryPieces("Short.")).toEqual(["Short."]);
    expect(commentaryPieces("  ")).toEqual([]);
  });
});
