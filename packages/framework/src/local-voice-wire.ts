/**
 * The wire of a local voice call: the page and the agent server talk over one WebSocket,
 * no WebRTC and no media server (`server/voice/local-host/`, `preview/voice/local-voice-client.ts`).
 *
 * Binary frames are audio, little-endian 16-bit mono PCM: the caller's microphone at
 * {@link LOCAL_VOICE_INPUT_SAMPLE_RATE} from the page, the agent's voice at
 * {@link LOCAL_VOICE_OUTPUT_SAMPLE_RATE} from the server. Text frames are the JSON messages
 * below. Browser-safe: imported by the preview page and the server alike.
 */

/** The rate the page sends the microphone at: what Silero VAD and every wired STT consume. */
export const LOCAL_VOICE_INPUT_SAMPLE_RATE = 16_000;
/** The rate the agent's voice arrives at: Kugel TTS's native rate, so nothing resamples it. */
export const LOCAL_VOICE_OUTPUT_SAMPLE_RATE = 24_000;

/** Server to page. */
export type LocalVoiceServerMessage =
  /** Every audio frame since the previous flush is one reply segment: say when it has played. */
  | { type: "audio_flush" }
  /** A barge-in: drop the queued audio now and say how much of the segment played. */
  | { type: "audio_clear" }
  /** The next words of the reply being spoken, paced to its playback. */
  | { type: "agent_text"; text: string }
  /** The reply's words are all delivered. */
  | { type: "agent_text_end" }
  /** What the caller is saying: the whole text of segment `id` so far. */
  | { type: "caller_text"; id: string; text: string; final: boolean }
  /** The agent's state: `listening`, `thinking`, `speaking`, ... */
  | { type: "agent_state"; state: string };

/** Page to server. */
export type LocalVoiceClientMessage =
  /** The segment the last `audio_flush` closed has played to its end. */
  | { type: "playout_done"; playedMs: number }
  /** The segment was cut by `audio_clear` after `playedMs` of it had played. */
  | { type: "playout_cleared"; playedMs: number };

export function parseLocalVoiceServerMessage(raw: string): LocalVoiceServerMessage {
  const message = JSON.parse(raw) as { type?: unknown };
  switch (message.type) {
    case "audio_flush":
    case "audio_clear":
    case "agent_text":
    case "agent_text_end":
    case "caller_text":
    case "agent_state":
      return message as LocalVoiceServerMessage;
  }
  throw new Error(`Unknown local voice message from the agent: ${raw.slice(0, 120)}`);
}

export function parseLocalVoiceClientMessage(raw: string): LocalVoiceClientMessage {
  const message = JSON.parse(raw) as { type?: unknown; playedMs?: unknown };
  if (
    (message.type === "playout_done" || message.type === "playout_cleared") &&
    typeof message.playedMs === "number" &&
    Number.isFinite(message.playedMs) &&
    message.playedMs >= 0
  ) {
    return message as LocalVoiceClientMessage;
  }
  throw new Error(`Unknown local voice message from the page: ${raw.slice(0, 120)}`);
}
