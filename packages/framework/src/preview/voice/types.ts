import type { ReplyPlayback } from "../../llm/spoken-split.js";
import type { CallerSpeech } from "./caller-transcript.js";
/** Live-call state — audio/status only. The transcript is the conversation's
 * own (server-pushed over the WS); the call adds live overlays on top. */

export type MicrophoneDevice = {
  deviceId: string;
  label: string;
};

export type VoiceClientState = {
  connected: boolean;
  connecting: boolean;
  /** Mic published, waiting for the user to speak. */
  listening: boolean;
  /** The agent's audio is playing right now. */
  speaking: boolean;
  /** User finished speaking, reply not yet audible. */
  processing: boolean;
  error: string | null;
  /** What the caller is saying, per recognised segment, as it is recognised. The page
   * shows what the transcript has not committed yet (`caller-transcript.ts`). */
  callerSpeech: CallerSpeech;
  microphones: readonly MicrophoneDevice[];
  selectedMicrophoneId: string | null;
  switchingMicrophone: boolean;
  /** The mic is published but muted: the agent hears nothing until it is
   * unmuted. Distinct from having no mic at all, which is `microphones` being
   * empty — a muted call is still a live call. */
  micMuted: boolean;
  /** Where the agent's current spoken reply is: not started, part-heard, or
   * done. See {@link ReplyPlayback} — the panel renders from this alone. */
  replyPlayback: ReplyPlayback;
  /** Increments whenever a completed call recording becomes available. */
  recordingRevision: number;
};
