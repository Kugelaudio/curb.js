import { describe, expect, it } from "vitest";
import {
  WARM_INITIAL_STATE,
  decisionAttempt,
  step,
  warmOutcome,
  warmSettled,
  type WarmEvent,
  type WarmState,
} from "./warm-state.js";

/** The state after `events`, from the start, with every effect on the way. */
function run(...events: WarmEvent[]) {
  let state: WarmState = WARM_INITIAL_STATE;
  const effects = [];
  for (const event of events) {
    const next = step(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const consulting: WarmEvent[] = [{ type: "accepted" }, { type: "target_joined" }];
const decide = (decision: "yes" | "no" | "unclear" | "voicemail"): WarmEvent => ({ type: "decision", decision });

describe("warm transfer states", () => {
  it("asks, dials and consults", () => {
    expect(run({ type: "accepted" }).state).toEqual({ phase: "dialing" });
    expect(run(...consulting).state).toEqual({
      phase: "consulting",
      unclear: 0,
    });
  });

  it("ends a refused or unanswered request without telling the host anything", () => {
    expect(run({ type: "refused" })).toEqual({
      state: { phase: "ended", outcome: "refused", reason: "refused" },
      effects: [],
    });
    expect(run({ type: "no_reply" })).toEqual({
      state: { phase: "ended", outcome: "failed", reason: "no_reply" },
      effects: [],
    });
  });

  it("takes the dial's own result while it rings, and records it without a decision", () => {
    expect(run({ type: "accepted" }, { type: "dial_result", outcome: "no_answer" })).toEqual({
      state: { phase: "ended", outcome: "no_answer", reason: "dial_no_answer" },
      effects: [
        {
          type: "end_consult",
          decision: "no_answer",
          reason: "dial_no_answer",
          send: false,
          farewell: false,
        },
      ],
    });
    expect(run({ type: "accepted" }, { type: "dial_result", outcome: "busy" }).state).toMatchObject({
      outcome: "busy",
      reason: "dial_busy",
    });
    expect(run({ type: "accepted" }, { type: "dial_result", outcome: "failed" }).state).toMatchObject({
      outcome: "failed",
      reason: "dial_failed",
    });
  });

  it("gives up on a person who never arrives, and on a consultation room it cannot join", () => {
    expect(run({ type: "accepted" }, { type: "dial_timeout" }).effects).toEqual([
      {
        type: "end_consult",
        decision: "no_answer",
        reason: "dial_no_answer",
        send: true,
        farewell: false,
      },
    ]);
    expect(run({ type: "accepted" }, { type: "join_failed" })).toEqual({
      state: { phase: "ended", outcome: "failed", reason: "join_failed" },
      effects: [
        {
          type: "end_consult",
          decision: "failed",
          reason: "join_failed",
          send: true,
          farewell: false,
        },
      ],
    });
  });

  it("connects on a yes and hands off once the person is with the caller", () => {
    const confirmed = run(...consulting, decide("yes"));
    expect(confirmed).toEqual({
      state: { phase: "connecting" },
      effects: [
        {
          type: "end_consult",
          decision: "connect",
          reason: "confirmed",
          send: true,
          farewell: true,
        },
      ],
    });
    // The person leaving the consultation room is the host moving them: nothing changes.
    expect(step(confirmed.state, { type: "target_left" })).toEqual({
      state: { phase: "connecting" },
      effects: [],
    });
    expect(step(confirmed.state, { type: "handed_off" }).state).toEqual({
      phase: "handed_off",
    });
    expect(step(confirmed.state, { type: "dial_result", outcome: "answered" }).state).toEqual({ phase: "handed_off" });
  });

  it("returns to the caller when the connection fails after the yes", () => {
    const confirmed = run(...consulting, decide("yes")).state;
    expect(step(confirmed, { type: "dial_result", outcome: "failed" })).toEqual({
      state: { phase: "ended", outcome: "failed", reason: "connect_failed" },
      effects: [],
    });
    expect(step(confirmed, { type: "connect_timeout" }).state).toMatchObject({
      outcome: "failed",
      reason: "connect_failed",
    });
  });

  it("declines on a no, with a closing line to the person", () => {
    expect(run(...consulting, decide("no"))).toEqual({
      state: { phase: "ended", outcome: "declined", reason: "declined" },
      effects: [
        {
          type: "end_consult",
          decision: "decline",
          reason: "declined",
          send: true,
          farewell: true,
        },
      ],
    });
  });

  it("asks once more after the first unclear reply and declines after the second", () => {
    const once = run(...consulting, decide("unclear"));
    expect(once).toEqual({
      state: { phase: "consulting", unclear: 1 },
      effects: [{ type: "ask_again" }],
    });
    expect(step(once.state, decide("unclear"))).toEqual({
      state: { phase: "ended", outcome: "declined", reason: "unclear_twice" },
      effects: [
        {
          type: "end_consult",
          decision: "decline",
          reason: "unclear_twice",
          send: true,
          farewell: true,
        },
      ],
    });
    // A clear answer after the question was asked again still counts.
    expect(step(once.state, decide("yes")).state).toEqual({
      phase: "connecting",
    });
  });

  it("counts attempts by code", () => {
    expect(decisionAttempt(run(...consulting).state)).toBe(1);
    expect(decisionAttempt(run(...consulting, decide("unclear")).state)).toBe(2);
  });

  it("reads a voicemail and a consultation that runs out as not answered", () => {
    expect(run(...consulting, decide("voicemail"))).toEqual({
      state: { phase: "ended", outcome: "no_answer", reason: "voicemail" },
      effects: [
        {
          type: "end_consult",
          decision: "no_answer",
          reason: "voicemail",
          send: true,
          farewell: false,
        },
      ],
    });
    expect(run(...consulting, { type: "consult_timeout" }).state).toMatchObject({
      outcome: "no_answer",
      reason: "consult_timeout",
    });
  });

  it("reads a person who hangs up during the consultation as declined", () => {
    expect(run(...consulting, { type: "target_left" }).effects).toEqual([
      {
        type: "end_consult",
        decision: "decline",
        reason: "target_left",
        send: true,
        farewell: false,
      },
    ]);
  });

  it("fails on a model, voice or room error", () => {
    expect(run(...consulting, { type: "error" })).toEqual({
      state: { phase: "ended", outcome: "failed", reason: "error" },
      effects: [
        {
          type: "end_consult",
          decision: "failed",
          reason: "error",
          send: true,
          farewell: false,
        },
      ],
    });
  });

  it("ends everything when the caller hangs up", () => {
    expect(run({ type: "caller_left" })).toEqual({
      state: { phase: "ended", outcome: "failed", reason: "caller_left" },
      effects: [],
    });
    for (const before of [[{ type: "accepted" }], consulting] as WarmEvent[][]) {
      expect(run(...before, { type: "caller_left" }).effects).toEqual([
        {
          type: "end_consult",
          decision: "failed",
          reason: "caller_left",
          send: true,
          farewell: false,
        },
      ]);
    }
    expect(step(run(...consulting, decide("yes")).state, { type: "caller_left" })).toEqual({
      state: { phase: "ended", outcome: "failed", reason: "caller_left" },
      effects: [],
    });
  });

  it("ignores everything once settled", () => {
    const ended = run(...consulting, decide("no")).state;
    const handedOff = run(...consulting, decide("yes"), {
      type: "handed_off",
    }).state;
    for (const state of [ended, handedOff]) {
      expect(step(state, { type: "caller_left" })).toEqual({
        state,
        effects: [],
      });
      expect(step(state, decide("yes"))).toEqual({ state, effects: [] });
    }
    expect(warmSettled(ended) && warmOutcome(ended)).toBe("declined");
    expect(warmSettled(handedOff) && warmOutcome(handedOff)).toBe("answered");
    expect(warmSettled(run(...consulting).state)).toBe(false);
  });
});
