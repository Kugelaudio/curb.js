import { ParticipantKind } from "@livekit/rtc-node";
import { describe, expect, it } from "vitest";
import { callerSide, createTransferHandoff, isTransferTarget } from "./transfer-handoff.js";
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
});
