import { describe, expect, it } from "vitest";
import { AgentSession, type AgentLlmClient } from "../../agent-session.js";
import { createInsuranceDemoRuntime } from "../../test-fixtures/insurance-runtime.js";
import { END_CALL_TOOL_NAME } from "../../types.js";
import { createEndCallHangup, type SpokenReply } from "./end-call.js";

/** Let the hang-up's fire-and-forget wait run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Stand-in for LiveKit's SpeechHandle. Same contract: `waitForPlayout()`
 * resolves once the reply is done — either every frame reached the caller
 * (`finishPlayout`) or playback was cut short (`cut`, which is what a
 * disconnect mid-reply does).
 */
class FakeReply implements SpokenReply {
  interrupted = false;
  playing = true;
  private resolvePlayout!: () => void;
  private readonly playout = new Promise<void>((resolve) => {
    this.resolvePlayout = resolve;
  });

  waitForPlayout(): Promise<void> {
    return this.playout;
  }

  /** The whole reply played. */
  finishPlayout(): void {
    this.playing = false;
    this.resolvePlayout();
  }

  /** Playback stopped early — the caller heard a prefix. */
  cut(): void {
    this.interrupted = true;
    this.playing = false;
    this.resolvePlayout();
  }
}

const CLOSING_LINE = "Glad I could help. Take care.";

function goodbyeSession() {
  const runtime = createInsuranceDemoRuntime();
  const llm: AgentLlmClient = async () => ({
    text: "",
    toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: CLOSING_LINE } }],
  });
  return { runtime, session: new AgentSession(runtime, llm) };
}

describe("end_call hang-up", () => {
  it("never cuts off the closing line: the call ends only after playout", async () => {
    const { runtime, session } = goodbyeSession();
    const reply = new FakeReply();
    let closed = false;

    const hangup = createEndCallHangup({
      currentReply: () => reply,
      close: () => {
        closed = true;
        // What a disconnect mid-reply really does: LiveKit force-interrupts
        // the speech and the host reconciles curb's history to the words that
        // actually played. If the hang-up fires too early, this is where the
        // truncation would appear.
        if (reply.playing) {
          reply.cut();
          session.reconcileInterruptedReply("Glad I could");
        }
      },
    });
    runtime.setEndCallRequest(hangup.request);

    const said = await session.runTurn("that's all, thanks — bye", { spoken: true });

    // The tool ran DURING the turn, and the turn then said its goodbye; it has not played yet.
    expect(said).toBe(CLOSING_LINE);
    expect(hangup.isPending()).toBe(true);
    expect(closed).toBe(false);

    reply.finishPlayout();
    await settle();

    expect(closed).toBe(true);
    const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    expect(assistant?.content).toBe(CLOSING_LINE);
    expect(assistant?.content).not.toContain("cut off");
    expect(assistant?.role === "assistant" && assistant.interruption).toBeUndefined();
  });

  it("hangs up immediately when nothing is playing", async () => {
    let closed = false;
    const hangup = createEndCallHangup({ currentReply: () => null, close: () => { closed = true; } });

    hangup.request();
    await settle();

    expect(closed).toBe(true);
  });

  it("keeps the call up when the user talks over the closing line", async () => {
    const reply = new FakeReply();
    const logs: string[] = [];
    let closed = false;
    const hangup = createEndCallHangup({
      currentReply: () => reply,
      close: () => { closed = true; },
      log: (message) => logs.push(message),
    });

    hangup.request();
    reply.cut();
    await settle();

    // The user is mid-sentence — hanging up on them would be worse than
    // staying on the line, and the model can end the call again next turn.
    expect(closed).toBe(false);
    expect(hangup.isPending()).toBe(false);
    expect(logs.join(" ")).toContain("cancelled");
  });

  it("tells the model the call is still on when the closing line was talked over", async () => {
    const { runtime, session } = goodbyeSession();
    const reply = new FakeReply();
    const hangup = createEndCallHangup({
      currentReply: () => reply,
      close: () => {},
      onCancelled: () => runtime.endCallCancelled(),
    });
    runtime.setEndCallRequest(hangup.request);

    await session.runTurn("that's all, thanks — bye", { spoken: true });
    reply.cut();
    await settle();

    // The tool result said the call ends; without this line the model believes it did and
    // tells the caller so (a voicemail menu kept talking over the goodbye, 2026-10-26).
    const stillOn = runtime.snapshot().stateSnapshot.filter((line) => line.includes("end_call did not hang up"));
    expect(stillOn).toHaveLength(1);

    // A later end_call that runs clears it.
    await session.runTurn("no really, bye", { spoken: true });
    expect(runtime.snapshot().stateSnapshot.join("\n")).not.toContain("end_call did not hang up");
  });

  it("hangs up on a second end_call even when that goodbye is talked over too", async () => {
    // A voicemail menu or an announcement never stops talking: cancelling every time
    // would keep the call up until the other side hangs up.
    let reply = new FakeReply();
    let closed = false;
    const hangup = createEndCallHangup({ currentReply: () => reply, close: () => { closed = true; } });

    hangup.request();
    reply.cut();
    await settle();
    expect(closed).toBe(false);

    reply = new FakeReply();
    hangup.request();
    reply.cut();
    await settle();
    expect(closed).toBe(true);
  });

  it("a second request during the same wait does not queue a second hang-up", async () => {
    const reply = new FakeReply();
    let closes = 0;
    const hangup = createEndCallHangup({
      currentReply: () => reply,
      close: () => { closes += 1; },
    });

    hangup.request();
    hangup.request();
    reply.finishPlayout();
    await settle();

    expect(closes).toBe(1);
  });

  it("reports a failed wait instead of leaving the call silently up", async () => {
    const failure = new Error("playout tracking died");
    const errors: unknown[] = [];
    let closed = false;
    const hangup = createEndCallHangup({
      currentReply: () => ({
        interrupted: false,
        waitForPlayout: () => Promise.reject(failure),
      }),
      close: () => { closed = true; },
      onError: (error) => errors.push(error),
    });

    hangup.request();
    await settle();

    expect(closed).toBe(false);
    expect(errors).toEqual([failure]);
    expect(hangup.isPending()).toBe(false);
  });
});
