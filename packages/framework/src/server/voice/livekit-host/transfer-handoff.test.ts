import { ParticipantKind } from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";
import type { TransferEndedDecision } from "../../../transfer-ended.js";
import {
  TRANSFER_ENDED_PROMPT,
  TRANSFER_GOODBYE_TIMEOUT_MS,
  applyTransferEnded,
  callerSide,
  createTransferHandoff,
  isTransferTarget,
  settleTransferEnded,
  transferEndedPrompt,
  type TransferEndedEffects,
} from "./transfer-handoff.js";
import type { CallParticipant } from "./call-opening.js";

const caller: CallParticipant = { identity: "sip_caller-abc", kind: ParticipantKind.SIP };
const target: CallParticipant = { identity: "sip_transfer-abc", kind: ParticipantKind.SIP };

function setup(initial: CallParticipant[] = [caller]) {
  const room = new Set<CallParticipant>(initial);
  const calls: string[] = [];
  const handoff = createTransferHandoff({
    participants: () => room.values(),
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    log: () => {},
  });
  return { room, calls, handoff };
}

describe("transfer handoff", () => {
  it("tells a transfer target from the caller", () => {
    expect(isTransferTarget(target)).toBe(true);
    expect(isTransferTarget(caller)).toBe(false);
    expect(callerSide([caller, target])).toEqual([caller]);
  });

  it("hands off when the target joins and resumes when it leaves while the caller stays", () => {
    const { room, calls, handoff } = setup();
    room.add(target);
    handoff.onParticipantJoined(target);
    expect(handoff.handedOff()).toBe(true);
    // The leaving participant can still be listed while its event runs.
    handoff.onParticipantLeft(target);
    room.delete(target);
    expect(handoff.handedOff()).toBe(false);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("stays handed off when no caller remains", () => {
    const { room, calls, handoff } = setup();
    room.add(target);
    handoff.onParticipantJoined(target);
    room.delete(caller);
    room.delete(target);
    handoff.onParticipantLeft(target);
    expect(handoff.handedOff()).toBe(true);
    expect(calls).toEqual(["pause"]);
  });

  it("ignores other participants and a second join", () => {
    const { room, calls, handoff } = setup();
    handoff.onParticipantJoined({ identity: "web-visitor", kind: ParticipantKind.STANDARD });
    handoff.onParticipantLeft(target);
    expect(calls).toEqual([]);
    room.add(target);
    handoff.onParticipantJoined(target);
    handoff.onParticipantJoined(target);
    handoff.onParticipantLeft(caller);
    expect(calls).toEqual(["pause"]);
  });

  it("frames an onEnded instruction like the default note", () => {
    expect(TRANSFER_ENDED_PROMPT).toBe(
      "(The person you transferred this call to has left the call. The caller is still on the line and hears you again. Tell them in one short line that the other person has left, and ask whether you can help with anything else. Do not call skip_turn.)",
    );
    expect(transferEndedPrompt("Ask whether the colleague could help.")).toBe(
      "(The person you transferred this call to has left the call. The caller is still on the line and hears you again. Ask whether the colleague could help. Do not call skip_turn.)",
    );
    // An instruction without its full stop still reads as its own sentence.
    expect(transferEndedPrompt("Ask whether the colleague could help")).toBe(
      transferEndedPrompt("Ask whether the colleague could help."),
    );
  });
});

/** What applyTransferEnded did, in order. */
async function applied(decision: TransferEndedDecision, options: { stale?: boolean; goodbyeFails?: boolean } = {}) {
  const calls: string[] = [];
  await applyTransferEnded(decision, {
    stale: () => options.stale ?? false,
    resume: (prompt) => calls.push(`resume ${prompt}`),
    sayGoodbye: async (goodbye) => {
      calls.push(`goodbye ${goodbye}`);
      if (options.goodbyeFails) throw new Error("TTS down");
    },
    endCall: () => calls.push("end"),
    log: () => {},
    error: (message) => calls.push(`error ${message}`),
  });
  return calls;
}

/** Effects that record what `settleTransferEnded` and a stalled goodbye do, in order. */
function recorded(overrides: Partial<TransferEndedEffects> = {}) {
  const calls: string[] = [];
  const effects: TransferEndedEffects = {
    stale: () => false,
    resume: (prompt) => calls.push(`resume ${prompt}`),
    sayGoodbye: async () => {},
    endCall: () => calls.push("end"),
    log: () => {},
    error: (message) => calls.push(`error ${message}`),
    ...overrides,
  };
  return { calls, effects };
}

describe("applyTransferEnded", () => {
  it("ends the call when the goodbye never finishes, and reports why", async () => {
    vi.useFakeTimers();
    try {
      const { calls, effects } = recorded({ sayGoodbye: () => new Promise(() => {}) });
      const applying = applyTransferEnded({ action: "end_call", goodbye: "Goodbye!" }, effects);

      await vi.advanceTimersByTimeAsync(TRANSFER_GOODBYE_TIMEOUT_MS - 1);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await applying;

      expect(calls).toEqual([
        `error the goodbye did not finish within ${TRANSFER_GOODBYE_TIMEOUT_MS} ms, the call ends anyway`,
        "end",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes with the default note, or the decision's instruction", async () => {
    expect(await applied({ action: "continue" })).toEqual([`resume ${TRANSFER_ENDED_PROMPT}`]);
    expect(await applied({ action: "continue", instruction: "Offer a callback." })).toEqual([
      `resume ${transferEndedPrompt("Offer a callback.")}`,
    ]);
  });

  it("says the goodbye, then ends the call; without one it ends at once", async () => {
    expect(await applied({ action: "end_call", goodbye: "Goodbye!" })).toEqual(["goodbye Goodbye!", "end"]);
    expect(await applied({ action: "end_call" })).toEqual(["end"]);
  });

  it("ends the call even when the goodbye cannot be played, and reports why", async () => {
    expect(await applied({ action: "end_call", goodbye: "Goodbye!" }, { goodbyeFails: true })).toEqual([
      "goodbye Goodbye!",
      "error the goodbye could not be played, the call ends anyway: TTS down",
      "end",
    ]);
  });

  it("does nothing once the call moved on", async () => {
    expect(await applied({ action: "end_call", goodbye: "Goodbye!" }, { stale: true })).toEqual([]);
    expect(await applied({ action: "continue" }, { stale: true })).toEqual([]);
  });
});

describe("settleTransferEnded", () => {
  it("carries out what was decided", async () => {
    const { calls, effects } = recorded();
    await settleTransferEnded(async () => ({ action: "end_call" }), effects);
    expect(calls).toEqual(["end"]);
  });

  it("takes the call back when deciding fails, so the caller is not left muted", async () => {
    const { calls, effects } = recorded();
    await settleTransferEnded(() => Promise.reject(new Error("no decision")), effects);
    expect(calls).toEqual([
      `resume ${TRANSFER_ENDED_PROMPT}`,
      "error taking the call back after a transfer failed: no decision",
    ]);
  });

  it("takes the call back when carrying out the decision fails", async () => {
    const { calls, effects } = recorded({
      endCall: () => {
        throw new Error("no room");
      },
    });
    await settleTransferEnded(async () => ({ action: "end_call" }), effects);
    expect(calls).toEqual([
      `resume ${TRANSFER_ENDED_PROMPT}`,
      "error taking the call back after a transfer failed: no room",
    ]);
  });

  it("does not take back a call that moved on", async () => {
    const { calls, effects } = recorded({ stale: () => true });
    await settleTransferEnded(() => Promise.reject(new Error("no decision")), effects);
    expect(calls).toEqual(["error taking the call back after a transfer failed: no decision"]);
  });

  it("reports the cause and rejects when even the recovery fails", async () => {
    const { calls, effects } = recorded({
      resume: () => {
        throw new Error("session gone");
      },
    });
    await expect(settleTransferEnded(() => Promise.reject(new Error("no decision")), effects)).rejects.toThrow(
      "session gone",
    );
    expect(calls).toEqual(["error taking the call back after a transfer failed: no decision"]);
  });
});
