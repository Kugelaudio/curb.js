/**
 * Handed-off mode: while a transferred call's target is in the room, the agent stays in the
 * room but neither listens nor speaks; when the target leaves and the caller is still there,
 * the agent takes the call back.
 *
 * The platform dials the transfer target into the call's LiveKit room as a second SIP
 * participant whose identity starts with {@link TRANSFER_TARGET_IDENTITY_PREFIX}. The caller
 * and the target hear each other through the room; the agent's job is to get out of the way.
 *
 * Extracted from `startLivekitVoiceAgent` so the rule is testable without a LiveKit room.
 */

import type { TransferEndedDecision } from "../../../transfer-ended.js";
import { isCaller, type CallParticipant } from "./call-opening.js";

/** The LiveKit identity of a transfer target starts with this (`sip_` + its caller ID). */
export const TRANSFER_TARGET_IDENTITY_PREFIX = "sip_transfer-";

const TRANSFER_ENDED_DEFAULT_INSTRUCTION =
  "Tell them in one short line that the other person has left, and ask whether you can help with anything else.";

/** The system note the model gets when the transfer target left and the caller stayed, with a
 * transfer's `onEnded` `instruction` in place of the default one. Kept out of the
 * visible transcript while still giving the model a normal turn. */
export function transferEndedPrompt(instruction: string = TRANSFER_ENDED_DEFAULT_INSTRUCTION): string {
  const sentence = /[.!?]$/.test(instruction) ? instruction : `${instruction}.`;
  return `(The person you transferred this call to has left the call. The caller is still on the line and hears you again. ${sentence} Do not call skip_turn.)`;
}

export const TRANSFER_ENDED_PROMPT = transferEndedPrompt();

export function isTransferTarget(participant: Pick<CallParticipant, "identity">): boolean {
  return participant.identity.startsWith(TRANSFER_TARGET_IDENTITY_PREFIX);
}

/** The participants that are the caller's side of the call: callers, never a transfer target. */
export function callerSide(participants: Iterable<CallParticipant>): CallParticipant[] {
  return [...participants].filter((participant) => isCaller(participant) && !isTransferTarget(participant));
}

export type TransferHandoffOptions = {
  /** The room's remote participants right now. */
  participants: () => Iterable<CallParticipant>;
  /** Stop listening and speaking. */
  pause: () => void;
  /** The target left while the caller stays: listen and speak again, or end the call, as
   * the transfer's `onEnded` decides (default: continue). */
  resume: () => void;
  log: (message: string) => void;
};

export type TransferHandoff = {
  /** True while a transfer target is on the call and the agent stays quiet. */
  handedOff(): boolean;
  onParticipantJoined(participant: CallParticipant): void;
  onParticipantLeft(participant: CallParticipant): void;
};

export function createTransferHandoff(options: TransferHandoffOptions): TransferHandoff {
  let handedOff = false;
  return {
    handedOff: () => handedOff,
    onParticipantJoined: (participant) => {
      if (!isTransferTarget(participant) || handedOff) return;
      handedOff = true;
      options.log(`transfer target ${participant.identity} joined: handed off, the agent stops listening and speaking`);
      options.pause();
    },
    onParticipantLeft: (participant) => {
      if (!isTransferTarget(participant) || !handedOff) return;
      // The leaving participant may still be listed while its event runs.
      const others = [...options.participants()].filter((other) => other.identity !== participant.identity);
      if (others.some(isTransferTarget)) return;
      if (callerSide(others).length === 0) {
        options.log(`transfer target ${participant.identity} left and no caller remains: staying handed off`);
        return;
      }
      handedOff = false;
      options.log(`transfer target ${participant.identity} left while the caller stays: the agent resumes`);
      options.resume();
    },
  };
}

export type TransferEndedEffects = {
  /** True when the decision no longer applies: the call is closing, another target joined,
   * or no caller is left to hear it. */
  stale: () => boolean;
  /** Listen and speak again, then give the model `prompt`. */
  resume: (prompt: string) => void;
  /** Say `goodbye` to the caller, not interruptible. Resolves once it played. */
  sayGoodbye: (goodbye: string) => Promise<void>;
  /** End the call. */
  endCall: () => void;
  log: (message: string) => void;
  error: (message: string) => void;
};

/** Carry out what the transfer's `onEnded` decided once its target left (`transfer-ended.ts`). */
export async function applyTransferEnded(decision: TransferEndedDecision, effects: TransferEndedEffects): Promise<void> {
  if (effects.stale()) {
    effects.log(`the transfer's onEnded decided ${decision.action} after the call moved on: nothing to do`);
    return;
  }
  if (decision.action === "continue") {
    effects.resume(transferEndedPrompt(decision.instruction));
    return;
  }
  effects.log("the transfer target left and the transfer's onEnded ends the call");
  if (decision.goodbye !== undefined) {
    try {
      await effects.sayGoodbye(decision.goodbye);
    } catch (error) {
      // KEEP-JUSTIFIED: the author asked to end the call; a goodbye that could not be played
      // must not keep it open. The cause is reported.
      effects.error(`the goodbye could not be played, the call ends anyway: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  effects.endCall();
}
