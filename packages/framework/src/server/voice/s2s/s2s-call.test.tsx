import { initializeLogger } from "@livekit/agents";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSession } from "../../../agent-session.js";
import { Agent, Skill, Skills, SystemPrompt, Tool } from "../../../components.js";
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
const routes: AgentRoute[] = [
  { path: "/report-claim", Component: ReportClaim, meta: { title: "Report a claim", description: "Reporting damage." } },
];
function App({ s2s }: { s2s: S2sDescriptor }) {
  return (
    <Agent s2s={s2s}>
      <SystemPrompt>You answer the phone at an insurer.</SystemPrompt>
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

async function call(options: { firstLine?: string; steps?: Step[]; greeting?: string; drops?: boolean } = {}) {
  const model = await startFakeLiveModel({ greeting: options.greeting, drops: options.drops });
  const s2s = openai.live({ baseURL: model.baseURL, voice: "marin" });
  open.push(async () => void (await model.close()));
  const parts = await callOn(s2s, options, () => model.start() !== undefined);
  return { model, ...parts };
}

async function callOn(s2s: S2sDescriptor, options: { firstLine?: string; steps?: Step[]; firstTurn?: "agent" }, started: () => boolean) {
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
  const handle = await startVoiceAgent({
    room,
    roomName: "call",
    bundle: { runtime, session } as never,
    client: { bind: () => {}, detach: () => {} } as never,
    env: { OPENAI_API_KEY: "test-key" } as never,
    onClosed: closed,
    ...(options.firstTurn ? { firstTurn: options.firstTurn } : {}),
  });
  await until(started, "the session started");
  // A live microphone: LiveKit ends a caller's line after 800 ms of it with no new words.
  const mic = setInterval(() => page.input?.push(Buffer.alloc(3200)), 100);
  const said = (role: "user" | "assistant") => session.messages.filter((m) => m.role === role && m.content).map((m) => m.content);
  open.push(async () => {
    clearInterval(mic);
    await handle.close();
  });
  return { session, runtime, handle, llm, said, closed };
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

  it("sends the caller's audio to the model and keeps a turn it answered alone, with no LLM call", async () => {
    const { model, said, llm } = await call();
    await until(() => model.appendedBytes() > 0, "audio reached the model");
    model.callerSays("Hello there.");
    await sleep(50);
    await model.say("Hi, how can I help?");
    model.callerSays("Just checking.");
    await until(() => said("user").length >= 1 && said("assistant").length >= 1, "the lines were recorded");
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

  it("gives every delegation an answer, even from an empty turn", async () => {
    const { model } = await call({ steps: [{ calls: [{ name: "skip_turn" }] }] });
    model.callerSays("Mhm.", { delegate: true });
    await until(() => model.commentary().length === 1, "the delegation was answered");
    expect(model.commentary()[0]?.content).toContain("Nothing to add");
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

  it("asks the model to open with a fixed first line", async () => {
    const { model, said } = await call({ firstLine: "Hello, this is the claims line." });
    expect(model.start().instructions).toContain('"Hello, this is the claims line."');
    expect(said("assistant")).toEqual(["Hello, this is the claims line."]);
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
    expect(toolOutputs(model).at(-1)).toContain("Say nothing until it reports");
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

    await model.toolCall(askBackOffice("The caller confirmed"));
    await until(() => toolOutputs(model).length === 2, "the tool call was answered");
    expect(toolOutputs(model).at(-1)).toContain("Say nothing until it reports");
    expect(ran).toEqual(["verify_policy P-1"]);

    await model.callerSays("Yes.");
    await until(() => ran.length === 2, "the caller's words released it");
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
