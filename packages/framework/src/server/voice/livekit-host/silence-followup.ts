/**
 * The check-in after a silence: the agent finished or skipped a turn and the caller said
 * nothing for `delayMs`. Its own module because the timer outlives what started it.
 *
 * Every voice call has one: the cascaded pipeline checks in after a skipped turn (`host.ts`),
 * and a call on a speech-to-speech model after the model's line (`../s2s/call.ts`).
 */

import type { Env } from "../../../provider-keys.js";

/** How long a call waits in silence before it checks in: `VOICE_SILENCE_FOLLOWUP_MS`, 6 s by default. */
export function silenceFollowupDelayMs(env: Env): number {
  return Number(env.VOICE_SILENCE_FOLLOWUP_MS ?? 6000);
}

export interface SilenceFollowupOptions {
  delayMs: number;
  /** The caller is talking to someone else, not quiet. */
  handedOff: () => boolean;
  /** Nobody is on the line to check on. */
  callerAway: () => boolean;
  /** The caller is speaking right now, whether or not their words were transcribed yet: a
   * check-in would talk over them. Absent, only `cancel` says the caller spoke. */
  callerSpeaking?: () => boolean;
  reply: () => void;
  onError: (error: unknown) => void;
}

export interface SilenceFollowup {
  arm: () => void;
  cancel: () => void;
  /** The session is over: nothing may arm again. */
  stop: () => void;
}

export function createSilenceFollowup(options: SilenceFollowupOptions): SilenceFollowup {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  return {
    arm: () => {
      if (stopped || options.handedOff() || options.callerAway() || options.delayMs <= 0) return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (options.callerSpeaking?.()) return;
        try {
          options.reply();
        } catch (error) {
          // KEEP-JUSTIFIED: a throw in a timer ends the process, and with it every other call
          // the process holds. This call only loses a check-in; the cause is reported.
          options.onError(error);
        }
      }, options.delayMs);
    },
    cancel,
    stop: () => {
      stopped = true;
      cancel();
    },
  };
}
