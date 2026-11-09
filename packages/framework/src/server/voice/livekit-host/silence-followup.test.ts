import { afterEach, describe, expect, it, vi } from "vitest";
import { createSilenceFollowup, silenceFollowupDelayMs } from "./silence-followup.js";

function followup(
  reply: () => void,
  handedOff = false,
  onError: (error: unknown) => void = () => {},
  callerAway = false,
) {
  return createSilenceFollowup({ delayMs: 6000, handedOff: () => handedOff, callerAway: () => callerAway, reply, onError });
}

describe("createSilenceFollowup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks in once the caller stayed quiet", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    followup(reply).arm();
    vi.advanceTimersByTime(5999);
    expect(reply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reply).toHaveBeenCalledOnce();
  });

  it("arming again starts the wait over", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    const silence = followup(reply);
    silence.arm();
    vi.advanceTimersByTime(4000);
    silence.arm();
    vi.advanceTimersByTime(4000);
    expect(reply).not.toHaveBeenCalled();
  });

  it("stays quiet while nobody is on the line", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    followup(reply, false, () => {}, true).arm();
    vi.advanceTimersByTime(6000);
    expect(reply).not.toHaveBeenCalled();
  });

  it("stays quiet during a handoff", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    followup(reply, true).arm();
    vi.advanceTimersByTime(6000);
    expect(reply).not.toHaveBeenCalled();
  });

  // A caller left mid-call; the SDK closed the session, this timer fired 6 s later, and its
  // throw ended the process with every other call in it (runner_failure, 2026-10-26).
  it("a session that closed while it waited gets no reply", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    const silence = followup(reply);
    silence.arm();
    silence.stop();
    vi.advanceTimersByTime(6000);
    expect(reply).not.toHaveBeenCalled();
  });

  it("a turn ending after the session closed cannot arm it again", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    const silence = followup(reply);
    silence.stop();
    silence.arm();
    vi.advanceTimersByTime(6000);
    expect(reply).not.toHaveBeenCalled();
  });

  it("a reply that throws stays inside the timer, where it would end every call in the process", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const failure = new Error("AgentSession is not running");
    const silence = followup(
      () => {
        throw failure;
      },
      false,
      onError,
    );
    silence.arm();
    expect(() => vi.advanceTimersByTime(6000)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("does not check in over a caller who is speaking when the wait ends", () => {
    vi.useFakeTimers();
    const reply = vi.fn();
    let speaking = true;
    const silence = createSilenceFollowup({
      delayMs: 6000,
      handedOff: () => false,
      callerAway: () => false,
      callerSpeaking: () => speaking,
      reply,
      onError: () => {},
    });
    silence.arm();
    vi.advanceTimersByTime(6000);
    expect(reply).not.toHaveBeenCalled();
    speaking = false;
    vi.advanceTimersByTime(6000);
    expect(reply).not.toHaveBeenCalled();
    silence.arm();
    vi.advanceTimersByTime(6000);
    expect(reply).toHaveBeenCalledOnce();
  });
});

describe("silenceFollowupDelayMs", () => {
  it("reads VOICE_SILENCE_FOLLOWUP_MS, 6 s when unset", () => {
    expect(silenceFollowupDelayMs({})).toBe(6000);
    expect(silenceFollowupDelayMs({ VOICE_SILENCE_FOLLOWUP_MS: "2500" })).toBe(2500);
  });
});
