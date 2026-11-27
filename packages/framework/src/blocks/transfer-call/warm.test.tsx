import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, TransferCallTool } from "../../index.js";
import type { CallTrace, ConsultTraceEvent } from "../../call-trace.js";
import type { AgentRunRequest, AgentRunResponse } from "../../llm/types.js";
import type { OutgoingHostMessage } from "../../messages.js";
import { CONSULT_DECISION_TOOL, isConsultDecisionRequest } from "./consult-decision.js";
import { transferToolResult } from "./index.js";
import { CALL_TRANSFER_DECIDE_MESSAGE, CALL_TRANSFER_RESULT_MESSAGE, CALL_TRANSFER_WARM_MESSAGE } from "./protocol.js";
import {
  attachWarmTransferHost,
  warmTransfer,
  type ConsultLeg,
  type ConsultTargetEvent,
  type WarmRequest,
  type WarmTransferHost,
} from "./warm.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BRIEF = "Hello, this is the booking assistant. I have a caller about a damaged parcel. Can you take the call now?";

type Reading = { decision: string; say?: string } | Error;

/** The voice host's side, recording into `log`. The model answers each reading from `readings`,
 * after `askMs`; each line plays for `sayMs`. */
function fakeHost(readings: Reading[] = [], options: { join?: "fail"; askMs?: number; sayMs?: number } = {}) {
  const log: string[] = [];
  const requests: AgentRunRequest[] = [];
  const callerLeft = new Set<() => void>();
  const handedOff = new Set<() => void>();
  const targetListeners = new Set<(event: ConsultTargetEvent) => void>();
  const leg: ConsultLeg = {
    onTarget: (listener) => {
      targetListeners.add(listener);
      return () => targetListeners.delete(listener);
    },
    say: async (text) => {
      log.push(`say ${text}`);
      if (options.sayMs) await new Promise((resolve) => setTimeout(resolve, options.sayMs));
    },
    close: async () => {
      log.push("leave consultation");
    },
  };
  const host: WarmTransferHost = {
    hold: () => {
      log.push("hold");
      return () => log.push("hold stopped");
    },
    pause: () => {
      log.push("pause");
      return () => log.push("resume");
    },
    onCallerLeft: (listener) => {
      callerLeft.add(listener);
      return () => callerLeft.delete(listener);
    },
    onHandedOff: (listener) => {
      handedOff.add(listener);
      return () => handedOff.delete(listener);
    },
    openConsult: async (ticket, transferId) => {
      log.push(`join ${ticket.url} ${transferId}`);
      if (options.join === "fail") throw new Error("the room refused the token");
      return leg;
    },
    ask: async (request, signal): Promise<AgentRunResponse> => {
      requests.push(request);
      if (options.askMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.askMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            log.push("reading aborted");
            reject(new Error("aborted"));
          });
        });
      }
      const next = readings.shift() ?? { decision: "unclear" };
      if (next instanceof Error) throw next;
      return { text: "", toolCalls: [{ id: `c-${requests.length}`, name: CONSULT_DECISION_TOOL, input: { say: "", ...next } }] };
    },
  };
  const target = (event: ConsultTargetEvent) => {
    for (const listener of targetListeners) listener(event);
  };
  return {
    host,
    log,
    requests,
    target,
    joined: () => target({ type: "joined" }),
    says: (text: string) => target({ type: "turn", text }),
    callerLeaves: () => callerLeft.forEach((listener) => listener()),
    handOff: () => handedOff.forEach((listener) => listener()),
  };
}

/** A runtime on a phone call whose host accepts `call.transfer.warm` with `reply`. */
function phoneCall(reply: (message: OutgoingHostMessage) => Record<string, unknown> | null = acceptance) {
  const runtime = new AgentSiteRuntime(
    <Agent>
      <TransferCallTool to="+493012345678" warm={{ consultTimeoutSeconds: 30 }} />
    </Agent>,
  );
  runtime.updateInfo({ "caller.identity": "sip_caller-1", "caller.phoneNumber": "+491701234567" });
  const sent: OutgoingHostMessage[] = [];
  runtime.messages.connectHost((message) => {
    sent.push(message);
    const payload = message.expectsReply ? reply(message) : null;
    if (payload) {
      queueMicrotask(() => void runtime.messages.deliver("host", { id: "r-1", key: "reply", payload, inReplyTo: message.id }));
    }
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const decisions = () => sent.filter((message) => message.name === CALL_TRANSFER_DECIDE_MESSAGE).map((message) => message.payload);
  const result = (payload: Record<string, unknown>) =>
    runtime.messages.deliver("host", { id: "res-1", key: CALL_TRANSFER_RESULT_MESSAGE, payload });
  return { runtime, sent, decisions, result };
}

function acceptance(): Record<string, unknown> {
  return { transferId: "t-1", consult: { url: "wss://media.example/consult", token: "secret" } };
}

function fakeTrace() {
  const events: ConsultTraceEvent[] = [];
  const transfers: unknown[][] = [];
  const trace = {
    consult: (event: ConsultTraceEvent) => events.push(event),
    transfer: (...args: unknown[]) => {
      transfers.push(args);
      return { outcome: () => {} };
    },
  } as unknown as CallTrace;
  return { trace, events, transfers };
}

const REQUEST: WarmRequest = { to: "+493012345678", brief: BRIEF, consultTimeoutSeconds: 30, announce: "One moment please." };
const TIMING = { greetingMs: 5, connectMs: 200, lingerMs: 0, resultWaitMs: 20 };

function start(
  call: ReturnType<typeof phoneCall>,
  fake: ReturnType<typeof fakeHost>,
  request: WarmRequest = REQUEST,
  timing: Partial<typeof TIMING> = {},
) {
  const { trace, events } = fakeTrace();
  const lines: string[] = [];
  const outcome = warmTransfer(
    {
      messages: call.runtime.messages,
      host: fake.host,
      audio: {
        announce: async (text) => void fake.log.push(`announce ${text}`),
        ringback: () => () => {},
      },
      trace,
      log: (line) => lines.push(line),
      timing: { ...TIMING, ...timing },
    },
    request,
  );
  return { outcome, events, lines };
}

/** Wait until the consultation room is joined. */
async function untilJoined(fake: ReturnType<typeof fakeHost>) {
  await vi.waitFor(() => expect(fake.log.some((line) => line.startsWith("join "))).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("warm transfer", () => {
  it("asks the person first and puts the caller through on their yes", async () => {
    const call = phoneCall();
    const fake = fakeHost([{ decision: "yes", say: "Thank you, I am putting the caller through now." }]);
    const { outcome, events } = start(call, fake);
    await untilJoined(fake);
    // The host never gets the brief.
    expect(call.sent[0]).toMatchObject({
      name: CALL_TRANSFER_WARM_MESSAGE,
      payload: { to: "+493012345678", consultTimeoutSeconds: 30 },
    });
    expect(JSON.stringify(call.sent[0]!.payload)).not.toContain("parcel");
    fake.joined();
    fake.says("Sales, hello?");
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`));
    fake.says("Sure, go ahead.");
    await vi.waitFor(() => expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "connect" }]));
    // The model read the whole consultation, with the one decision tool.
    expect(isConsultDecisionRequest(fake.requests[0]!)).toBe(true);
    expect(fake.requests[0]!.stateSnapshot).toEqual(["person: Sales, hello?", `you: ${BRIEF}`, "person: Sure, go ahead."]);
    fake.handOff();
    await expect(outcome).resolves.toEqual({
      outcome: "answered",
      transferId: "t-1",
      targetReply: "Sales, hello? Sure, go ahead.",
    });
    expect(fake.log).toEqual([
      "pause",
      "announce One moment please.",
      "hold",
      "join wss://media.example/consult t-1",
      `say ${BRIEF}`,
      "say Thank you, I am putting the caller through now.",
      "leave consultation",
      "hold stopped",
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "answered",
      "turn",
      "turn",
      "turn",
      "decision",
      "turn",
      "ended",
    ]);
    expect(events.find((event) => event.kind === "decision")).toMatchObject({ decision: "yes", attempt: 1 });
    expect(events.at(-1)).toMatchObject({ kind: "ended", decision: "connect", reason: "confirmed" });
  });

  it("says the brief after a short wait when the person says nothing first", async () => {
    const call = phoneCall();
    const fake = fakeHost();
    const { outcome } = start(call, fake);
    await untilJoined(fake);
    fake.joined();
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`));
    fake.callerLeaves();
    await expect(outcome).resolves.toMatchObject({ outcome: "failed", message: expect.stringContaining("hung up") });
  });

  it("asks once more after an unclear reply and declines after the second", async () => {
    const call = phoneCall();
    const fake = fakeHost([
      { decision: "unclear", say: "It is about a damaged parcel. Can you take the call now?" },
      { decision: "unclear", say: "No problem, thank you. Goodbye." },
    ]);
    const { outcome, events } = start(call, fake);
    await untilJoined(fake);
    fake.joined();
    fake.says("Hello?");
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`));
    fake.says("What is it about?");
    await vi.waitFor(() => expect(fake.log).toContain("say It is about a damaged parcel. Can you take the call now?"));
    fake.says("Hmm, well, maybe later.");
    await expect(outcome).resolves.toMatchObject({ outcome: "declined", targetReply: "Hello? What is it about? Hmm, well, maybe later." });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "decline" }]);
    expect(events.filter((event) => event.kind === "decision")).toMatchObject([{ attempt: 1 }, { attempt: 2 }]);
    expect(events.at(-1)).toMatchObject({ decision: "decline", reason: "unclear_twice" });
    expect(fake.log.slice(-4)).toEqual(["say No problem, thank you. Goodbye.", "leave consultation", "hold stopped", "resume"]);
  });

  it("reads a reply the model could not decide on as unclear", async () => {
    const call = phoneCall();
    const fake = fakeHost([{ decision: "maybe" }, { decision: "no", say: "Thank you, goodbye." }]);
    const { outcome } = start(call, fake);
    await untilJoined(fake);
    fake.joined();
    fake.says("Hello?");
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`));
    fake.says("Who?");
    // No line from the model: the brief is the question asked again.
    await vi.waitFor(() => expect(fake.log.filter((line) => line === `say ${BRIEF}`)).toHaveLength(2));
    fake.says("Not now, sorry.");
    await expect(outcome).resolves.toMatchObject({ outcome: "declined" });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "decline" }]);
  });

  it("ends the person's call when they do not answer within the consultation time", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost();
    const { outcome, events } = start(call, fake, { ...REQUEST, consultTimeoutSeconds: 10 });
    await vi.advanceTimersByTimeAsync(0);
    fake.joined();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(outcome).resolves.toMatchObject({ outcome: "no_answer", transferId: "t-1" });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "no_answer" }]);
    expect(events.at(-1)).toMatchObject({ kind: "ended", decision: "no_answer", reason: "consult_timeout", durationMs: 10_000 });
  });

  it("takes a yes the model was still reading when the consultation time ran out", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost([{ decision: "yes" }], { askMs: 4_000 });
    const { outcome, events, lines } = start(call, fake, { ...REQUEST, consultTimeoutSeconds: 10 });
    await vi.advanceTimersByTimeAsync(0);
    fake.joined();
    await vi.advanceTimersByTimeAsync(8_000);
    fake.says("Yes, of course, put them through.");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "connect" }]);
    expect(events.filter((event) => event.kind === "decision")).toMatchObject([{ decision: "yes", attempt: 1 }]);
    expect(lines.some((line) => line.includes("ran out while the model read"))).toBe(true);
    fake.handOff();
    await expect(outcome).resolves.toMatchObject({ outcome: "answered", targetReply: "Yes, of course, put them through." });
  });

  it("reads a reply heard in time once its own line has played, even past the consultation time", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost([{ decision: "yes" }], { askMs: 2_000, sayMs: 9_000 });
    const { outcome } = start(call, fake, { ...REQUEST, consultTimeoutSeconds: 10 });
    await vi.advanceTimersByTimeAsync(0);
    fake.joined();
    await vi.advanceTimersByTimeAsync(8_000);
    // The brief is still playing (until 9 s); the reading starts once it has.
    fake.says("Yes, put them through.");
    await vi.advanceTimersByTimeAsync(3_100);
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "connect" }]);
    fake.handOff();
    await expect(outcome).resolves.toMatchObject({ outcome: "answered" });
  });

  it("gives a reading one grace past the consultation time, and no more", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost([{ decision: "yes" }], { askMs: 30_000 });
    const { outcome, events } = start(call, fake, { ...REQUEST, consultTimeoutSeconds: 10 });
    await vi.advanceTimersByTimeAsync(0);
    fake.joined();
    await vi.advanceTimersByTimeAsync(8_000);
    fake.says("Yes, sure.");
    await vi.advanceTimersByTimeAsync(11_990);
    expect(call.decisions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toMatchObject({ outcome: "no_answer", targetReply: "Yes, sure." });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "no_answer" }]);
    expect(fake.log).toContain("reading aborted");
    expect(events.some((event) => event.kind === "decision")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "ended", reason: "consult_timeout", durationMs: 20_000 });
  });

  it("asks nothing again once the consultation time ran out", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost([{ decision: "unclear", say: "Sorry, can you take the call now?" }], { askMs: 4_000 });
    const { outcome, events } = start(call, fake, { ...REQUEST, consultTimeoutSeconds: 10 });
    await vi.advanceTimersByTimeAsync(0);
    fake.joined();
    await vi.advanceTimersByTimeAsync(8_000);
    fake.says("Hmm?");
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(outcome).resolves.toMatchObject({ outcome: "no_answer" });
    expect(fake.log).not.toContain("say Sorry, can you take the call now?");
    expect(events.filter((event) => event.kind === "decision")).toMatchObject([{ decision: "unclear" }]);
    expect(events.at(-1)).toMatchObject({ kind: "ended", decision: "no_answer", reason: "consult_timeout", durationMs: 12_000 });
  });

  it("takes the host's own dial result while it rings, without a decision", async () => {
    const call = phoneCall();
    const fake = fakeHost();
    const { outcome, events } = start(call, fake);
    await untilJoined(fake);
    await call.result({ transferId: "t-1", outcome: "no_answer", dialStatus: "NOANSWER" });
    await expect(outcome).resolves.toEqual({ outcome: "no_answer", transferId: "t-1" });
    expect(call.decisions()).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "ended", transferId: "t-1", decision: "no_answer", reason: "dial_no_answer" });
    expect(fake.log.slice(-3)).toEqual(["leave consultation", "hold stopped", "resume"]);
  });

  it("takes the host's result when the room ends first while the phone still rings", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost();
    const { outcome, events, lines } = start(call, fake, REQUEST, { resultWaitMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    // The host ends the room right after the dial, and sends its result a few seconds later.
    fake.target({ type: "lost", message: "the agent lost the consultation room (room deleted)" });
    await vi.advanceTimersByTimeAsync(4_600);
    expect(call.decisions()).toEqual([]);
    await call.result({ transferId: "t-1", outcome: "no_answer", dialStatus: "NOANSWER" });
    await expect(outcome).resolves.toEqual({ outcome: "no_answer", transferId: "t-1" });
    expect(call.decisions()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "ended", decision: "no_answer", reason: "dial_no_answer" });
    expect(lines.some((line) => line.includes("waiting up to 15000 ms for the host's result"))).toBe(true);
  });

  it("takes the host's result when the room is gone before the agent could join it", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost([], { join: "fail" });
    const { outcome } = start(call, fake, REQUEST, { resultWaitMs: 15_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(call.decisions()).toEqual([]);
    await call.result({ transferId: "t-1", outcome: "busy", dialStatus: "BUSY" });
    await expect(outcome).resolves.toEqual({ outcome: "busy", transferId: "t-1" });
    expect(call.decisions()).toEqual([]);
  });

  it("fails when the room ended while ringing and no result came in time", async () => {
    vi.useFakeTimers();
    const call = phoneCall();
    const fake = fakeHost();
    const { outcome, events } = start(call, fake, REQUEST, { resultWaitMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    fake.target({ type: "lost", message: "the agent lost the consultation room (room deleted)" });
    await vi.advanceTimersByTimeAsync(14_990);
    expect(call.decisions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toMatchObject({ outcome: "failed", transferId: "t-1" });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "failed" }]);
    expect(events.at(-1)).toMatchObject({ kind: "ended", decision: "failed", reason: "error" });
  });

  it("ends the person's call when the caller hangs up during the consultation", async () => {
    const call = phoneCall();
    const fake = fakeHost();
    const { outcome } = start(call, fake);
    await untilJoined(fake);
    fake.joined();
    fake.callerLeaves();
    await expect(outcome).resolves.toMatchObject({ outcome: "failed" });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "failed" }]);
  });

  it("fails when the agent cannot join the consultation room, and when the model fails", async () => {
    const call = phoneCall();
    const failing = start(call, fakeHost([], { join: "fail" }));
    await expect(failing.outcome).resolves.toMatchObject({ outcome: "failed", message: expect.stringContaining("join") });
    expect(call.decisions()).toEqual([{ transferId: "t-1", decision: "failed" }]);
    expect(failing.lines.join("\n")).not.toContain("secret");

    const second = phoneCall();
    const fake = fakeHost([new Error("model down")]);
    const { outcome } = start(second, fake);
    await untilJoined(fake);
    fake.joined();
    fake.says("Hello?");
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`));
    fake.says("Yes?");
    await expect(outcome).resolves.toMatchObject({ outcome: "failed" });
    expect(second.decisions()).toEqual([{ transferId: "t-1", decision: "failed" }]);
  });

  it("returns to the caller when the person agreed but never arrives", async () => {
    const call = phoneCall();
    const fake = fakeHost([{ decision: "yes", say: "Putting them through." }]);
    const { outcome } = start(call, fake);
    await untilJoined(fake);
    fake.joined();
    fake.says("Hello?");
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`));
    fake.says("Yes, put them through.");
    await expect(outcome).resolves.toMatchObject({ outcome: "failed", message: expect.stringContaining("did not put them through") });
    expect(fake.log.at(-1)).toBe("resume");
  });

  it("passes a refusal through and dials nobody", async () => {
    const call = phoneCall(() => ({ code: "consult_unavailable", message: "no consultation rooms on this host" }));
    const fake = fakeHost();
    const { outcome } = start(call, fake);
    await expect(outcome).resolves.toEqual({
      outcome: "refused",
      code: "consult_unavailable",
      message: "no consultation rooms on this host",
    });
    expect(fake.log).toEqual(["pause", "announce One moment please.", "hold", "hold stopped", "resume"]);
  });

  it("ends what the host dialed when its acceptance carries no consultation ticket", async () => {
    const call = phoneCall(() => ({ transferId: "t-3" }));
    const { outcome } = start(call, fakeHost());
    await expect(outcome).resolves.toMatchObject({ outcome: "failed", code: "transfer_invalid_reply", transferId: "t-3" });
    expect(call.decisions()).toEqual([{ transferId: "t-3", decision: "failed" }]);
  });
});

describe("<TransferCallTool warm>", () => {
  it("asks the model for a brief and refuses a call without one", async () => {
    const call = phoneCall();
    const definition = call.runtime.snapshot().context.tools.find((tool) => tool.name === "transfer_call")!;
    expect(definition.inputSchema).toMatchObject({ required: ["announce", "brief"], properties: { brief: { type: "string" } } });
    expect(definition.description).toContain("asking them first");
    const { result } = await call.runtime.callTool("transfer_call", { announce: "One moment please." });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("brief");
    expect(call.sent).toHaveLength(0);
  });

  it("refuses before dialing on a call whose voice host cannot consult", async () => {
    const call = phoneCall();
    const { result } = await call.runtime.callTool("transfer_call", { announce: "One moment please.", brief: BRIEF });
    expect(result.message).toContain("not available on this call");
    expect(call.sent).toHaveLength(0);
  });

  it("runs the consultation through the attached voice host", async () => {
    const call = phoneCall();
    const fake = fakeHost([{ decision: "no", say: "Thank you, goodbye." }]);
    attachWarmTransferHost(call.runtime.info, fake.host);
    const pending = call.runtime.callTool("transfer_call", { announce: "One moment please.", brief: BRIEF });
    await untilJoined(fake);
    fake.joined();
    fake.says("Hello?");
    await vi.waitFor(() => expect(fake.log).toContain(`say ${BRIEF}`), { timeout: 4_000 });
    fake.says("I am in a meeting, sorry.");
    const { result } = await pending;
    expect(result.message).toContain("cannot take the call now");
    expect(result.message).toContain('"Hello? I am in a meeting, sorry."');
    expect(result.message).toContain("callback");
  });

  it("tells the model what each warm outcome means", () => {
    expect(transferToolResult({ outcome: "declined" }).message).toContain("cannot take the call now");
    expect(transferToolResult({ outcome: "no_answer", targetReply: "Mailbox of the sales team." }).message).toContain(
      "Mailbox of the sales team.",
    );
  });
});
