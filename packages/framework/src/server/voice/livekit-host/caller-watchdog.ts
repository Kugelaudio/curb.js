/**
 * When to give up on a room with nobody in it.
 *
 * EXTRACTED SO IT CAN BE TESTED. This logic lived inline in `startLivekitVoiceAgent`,
 * inside a function that needs a connected LiveKit Room to construct, which meant the rule
 * deciding when a hosted call ends had no test at all. It is two timers and a counter; it
 * does not need a media server to check.
 *
 * TWO SITUATIONS, NOT ONE, and conflating them is what left runners alive forever:
 *
 *   - The caller LEFT. Somebody was here and now is not. A short grace, because a transport
 *     that blinked looks identical for a moment and hanging up on it would drop a live call.
 *   - The caller NEVER CAME. The agent joined an empty room and nobody ever arrived. This
 *     one was uncovered: the old code armed its timer from `ParticipantDisconnected` alone,
 *     and a caller who never connects never disconnects — so nothing ever started it and
 *     the agent waited indefinitely. It gets a longer deadline, because the wait includes
 *     however long a browser takes to negotiate.
 *
 * The distinction is the whole point. One deadline for both would either hang up on slow
 * joins or leave abandoned rooms running for a minute.
 */

/**
 * How long a room may sit with no caller before the agent ends the call.
 *
 * Long enough to ride out a renegotiation or a brief transport blink, short enough
 * that a runner does not outlive a caller who really hung up. A caller who left stays
 * gone; one whose connection stuttered gets their call back.
 *
 * On a hosted platform this must outlast PLATFORM_SESSION_RECONNECT_GRACE (30 s by default).
 * The platform decides when a dropped call is over and stops the runner then, so a caller it
 * lets back in has to find the agent still in the room, not an empty one.
 */
export const EMPTY_ROOM_GRACE_MS = 45_000;

export interface CallerWatchdogOptions {
  /** How many remote participants are in the room right now. */
  remoteCount: () => number;
  /** End the call. Called at most once. */
  giveUp: () => void;
  log: (message: string) => void;
  /** Grace after a known participant disconnects. */
  emptyRoomMs: number;
  /** Grace for a caller who has not arrived at all. */
  noCallerMs: number;
  /** Injected so tests do not wait in real time. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CallerWatchdog {
  /** The agent is in the room and waiting. Starts the never-arrived deadline. */
  armForArrival(): void;
  /** Somebody joined. Cancels whichever deadline is running. */
  onParticipantJoined(): void;
  /** Somebody left. Starts the left-the-call deadline if the room is now empty. */
  onParticipantLeft(): void;
  /** Stop watching. Safe to call twice. */
  cancel(): void;
}

export function createCallerWatchdog(options: CallerWatchdogOptions): CallerWatchdog {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  let timer: unknown = null;
  let finished = false;

  const cancel = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const start = (ms: number, describe: string) => {
    cancel();
    timer = setTimer(() => {
      timer = null;
      // Re-checked at FIRING TIME, not only when armed. A join during the grace cancels
      // this, but a cancel that raced the timer would otherwise end a call somebody is on.
      if (options.remoteCount() > 0) return;
      if (finished) return;
      finished = true;
      options.log(describe);
      options.giveUp();
    }, ms);
  };

  return {
    armForArrival() {
      if (finished || options.remoteCount() > 0) return;
      start(options.noCallerMs, `no caller ever joined within ${options.noCallerMs}ms, ending the call`);
    },
    onParticipantJoined() {
      cancel();
    },
    onParticipantLeft() {
      if (finished || options.remoteCount() > 0) return;
      start(options.emptyRoomMs, `no caller for ${options.emptyRoomMs}ms, ending the call`);
    },
    cancel() {
      finished = true;
      cancel();
    },
  };
}
