/**
 * How a call opens: who the caller is, then the agent-first greeting or the agent's fixed line.
 *
 * Every route runs this through the one voice host (`host.ts`): `curb dev`, `curb start`, and
 * the built artifact's worker, direct-join and managed modes. So the caller info an agent reads
 * and the way it greets cannot differ between the preview and production. A call on a
 * speech-to-speech model opens the same way (`../s2s/call.ts`); only the model speaks the line.
 *
 * Extracted from `startLivekitVoiceAgent` so the rules are testable without a LiveKit room.
 */

import { ParticipantKind } from "@livekit/rtc-node";
import type { AgentFirstTurn } from "../../../config.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import { logError } from "../../log.js";

/** Synthetic input that asks the model to open an agent-first call. Kept out of the visible
 * transcript while still giving the model a normal turn. */
export const AGENT_FIRST_TURN_PROMPT =
  "(The voice call has just connected. Open the conversation now with one short, natural greeting that orients the user to what you can help with. Do not wait for the user to speak.)";

/** The parts of a LiveKit remote participant the opening reads. */
export type CallParticipant = {
  readonly identity: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly kind?: ParticipantKind;
};

/**
 * Who counts as the caller: a person, a phone line or a connector, never another agent or a
 * recorder. The same kinds LiveKit's own room input listens to by default.
 */
const CALLER_KINDS: readonly ParticipantKind[] = [
  ParticipantKind.STANDARD,
  ParticipantKind.SIP,
  ParticipantKind.CONNECTOR,
];

export function isCaller(participant: CallParticipant): boolean {
  return participant.kind === undefined || CALLER_KINDS.includes(participant.kind);
}

/**
 * What the agent reads about its caller with `useAgentInfo`, the same keys on every route:
 * `caller.identity`, and `caller.phoneNumber` when the caller dialed in over SIP.
 */
export function callerInfo(participant: CallParticipant): Record<string, string> {
  const phoneNumber = participant.attributes?.["sip.phoneNumber"]?.trim();
  return {
    "caller.identity": participant.identity,
    ...(phoneNumber ? { "caller.phoneNumber": phoneNumber } : {}),
  };
}

/** The spoken greeting, as the opening needs it. LiveKit's `SpeechHandle` fits. */
export type GreetingReply = {
  done(): boolean;
  waitForPlayout(): Promise<void>;
};

export type CallOpeningOptions = {
  firstTurn: AgentFirstTurn | undefined;
  /** The room's remote participants right now. */
  participants: () => Iterable<CallParticipant>;
  /** Puts the caller's info on the conversation. Called once, before any turn can run. */
  recordCaller: (info: Record<string, string>) => void;
  /** Speaks a reply the model writes: the session's `generateReply`. */
  generateReply: (options: { userInput: string; allowInterruptions: boolean }) => GreetingReply;
  /** Opens the conversation with the agent's fixed line (`firstTurn: { say }`) and returns it; null
   * when it has none or the conversation has begun. The curb session's `open`. */
  openConversation: () => string | null;
  /** Speaks a line as written, with no model call: the session's `say`. */
  say: (text: string, options: { allowInterruptions: boolean }) => GreetingReply;
};

export type CallOpening = {
  /** The room changed (a participant joined): record the caller, greet when it is due. */
  update(): void;
  /** The voice session started. A greeting needs a running session. */
  sessionStarted(): void;
  /**
   * Resolves once the greeting has played; at once when there is none or it is over. Typed
   * input waits on this: the greeting cannot be interrupted, and LiveKit refuses to interrupt
   * it rather than queueing the message.
   */
  greeted(): Promise<void>;
};

/**
 * Run one step of the opening (`update`, `sessionStarted`) where a throw must not escape: inside
 * the call's room events, where it could end every call the process serves, and once the session
 * starts, where a `firstTurn: { say }` function that returns no line would fail a call that can
 * go on.
 */
export function runOpeningStep(step: () => void, call: { roomName: string; reporter?: CallReporter }): void {
  try {
    step();
  } catch (error) {
    // KEEP-JUSTIFIED: the caller can still speak to an agent that failed to greet; the
    // cause is logged and lands in the call's record.
    const message = error instanceof Error ? error.message : String(error);
    logError("voice", `${call.roomName}: could not open the call: ${message}`);
    call.reporter?.event("error", { kind: "call_opening", message });
  }
}

/**
 * Record the caller as soon as one is in the room, then open the call once the session runs: for
 * `firstTurn: "agent"` with a greeting the model writes, otherwise with the agent's fixed line
 * (`firstTurn: { say }`), which the conversation records and the call speaks as written, with no
 * model call. A conversation that has begun (typed turns before the call) is not opened again.
 * Either opening is spoken with interruptions off: the caller hears the whole opening line, and
 * speech during it is not taken as a turn.
 */
export function createCallOpening(options: CallOpeningOptions): CallOpening {
  let callerRecorded = false;
  let started = false;
  let opened = false;
  let greeting: GreetingReply | null = null;

  const update = () => {
    if (!callerRecorded) {
      for (const participant of options.participants()) {
        if (!isCaller(participant)) continue;
        callerRecorded = true;
        options.recordCaller(callerInfo(participant));
        break;
      }
    }
    if (!started || !callerRecorded || opened) return;
    // Set first: an opening that fails is reported once, and the caller can still speak.
    opened = true;
    if (options.firstTurn === "agent") {
      greeting = options.generateReply({ userInput: AGENT_FIRST_TURN_PROMPT, allowInterruptions: false });
      return;
    }
    // Read now, with the caller's info (and any page info) on the conversation.
    const line = options.openConversation();
    if (line !== null) greeting = options.say(line, { allowInterruptions: false });
  };

  return {
    update,
    sessionStarted: () => {
      started = true;
      update();
    },
    greeted: async () => {
      if (greeting === null || greeting.done()) return;
      await greeting.waitForPlayout();
    },
  };
}
