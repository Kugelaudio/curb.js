import { EventEmitter } from "node:events";
import { voice } from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForCurrentReply, watchFirstAgentAudio, type PlayingReply } from "./host.js";

/**
 * The moment a caller first hears the agent.
 *
 * LiveKit moves the agent to `speaking` when the audio output reports its first frame
 * captured for playout, which is the first agent frame published into the room. That is
 * the number the warm-runner latency budget is measured against, so it is reported once
 * per call and never again: a second report would move the measurement to a later reply.
 */

const STATE = voice.AgentSessionEventTypes.AgentStateChanged;

describe("watchFirstAgentAudio", () => {
  it("reports the first agent audio once, on the monotonic clock", () => {
    const session = new EventEmitter();
    const seen: number[] = [];
    let clock = 100;
    watchFirstAgentAudio(session, (at) => seen.push(at), () => clock);

    session.emit(STATE, { type: "agent_state_changed", oldState: "initializing", newState: "listening" });
    expect(seen).toEqual([]);

    clock = 250;
    session.emit(STATE, { type: "agent_state_changed", oldState: "thinking", newState: "speaking" });
    clock = 900;
    session.emit(STATE, { type: "agent_state_changed", oldState: "speaking", newState: "listening" });
    session.emit(STATE, { type: "agent_state_changed", oldState: "thinking", newState: "speaking" });

    expect(seen).toEqual([250]);
    // Unsubscribed after it fired, so a long call does not keep a dead listener per reply.
    expect(session.listenerCount(STATE)).toBe(0);
  });

  it("never lets a failing observer reach the call", () => {
    const session = new EventEmitter();
    watchFirstAgentAudio(
      session,
      () => {
        throw new Error("the journal is gone");
      },
      () => 1,
    );
    // Telemetry about the call must not end the call.
    expect(() =>
      session.emit(STATE, { type: "agent_state_changed", oldState: "thinking", newState: "speaking" }),
    ).not.toThrow();
  });
});

/**
 * A host's stop with a grace: the agent finishes the reply it is speaking, then leaves.
 * The grace is an upper bound, never a delay: a reply that ends early ends the wait early,
 * and one that never ends is cut at the bound.
 */
describe("waitForCurrentReply", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A reply whose playout finishes when `finish` is called, and not before. */
  function fakeReply(): PlayingReply & { finish: () => void; waits: number } {
    let finish!: () => void;
    const playedOut = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let done = false;
    const reply = {
      waits: 0,
      interrupted: false,
      done: () => done,
      waitForPlayout: () => {
        reply.waits += 1;
        return playedOut;
      },
      finish: () => {
        done = true;
        finish();
      },
    };
    return reply;
  }

  it("waits for the current reply to play out when it ends inside the grace", async () => {
    vi.useFakeTimers();
    const reply = fakeReply();
    let outcome: string | undefined;
    const waiting = waitForCurrentReply(reply, 5000).then((result) => {
      outcome = result;
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(outcome).toBeUndefined();

    reply.finish();
    await waiting;
    expect(outcome).toBe("played");
    // The bound's timer is cleared, so a finished close leaves nothing scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never waits longer than the grace", async () => {
    vi.useFakeTimers();
    const reply = fakeReply();
    let outcome: string | undefined;
    const waiting = waitForCurrentReply(reply, 2000).then((result) => {
      outcome = result;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(outcome).toBe("timed-out");
  });

  it("does not wait without a grace, without a reply, or after the reply is done", async () => {
    const reply = fakeReply();
    expect(await waitForCurrentReply(reply, 0)).toBe("idle");
    expect(await waitForCurrentReply(reply, -5)).toBe("idle");
    expect(await waitForCurrentReply(reply, Number.NaN)).toBe("idle");
    expect(await waitForCurrentReply(null, 5000)).toBe("idle");
    expect(reply.waits).toBe(0);

    reply.finish();
    expect(await waitForCurrentReply(reply, 5000)).toBe("idle");
    expect(reply.waits).toBe(0);
  });
});
