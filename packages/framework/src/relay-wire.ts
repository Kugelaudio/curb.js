/**
 * The wire of a relayed call: a media relay outside the agent's process holds the realtime room
 * and carries its audio and events to the agent over one WebSocket per call
 * (`server/voice/relay-host/`). See `docs/agent-guide/host-protocol.md`, "Media relay".
 *
 * The host selects it per call with a start request whose `realtimeUrl` uses a
 * {@link RELAY_URL_SCHEMES} scheme; `realtimeToken` is then the relay's per-call token, sent as a
 * bearer `Authorization` header and never in the URL. A build says it can do this with
 * `mediaRelayProtocol` in `curb.bundle.json`.
 *
 * Binary frames are one {@link RELAY_STREAM} byte, then little-endian 16-bit mono PCM. Text frames
 * are the JSON messages below.
 */

import type { LocalVoiceServerMessage } from "./local-voice-wire.js";

/** The relay protocol this framework speaks, stamped into each build's manifest. */
export const MEDIA_RELAY_PROTOCOL = 1;

export const RELAY_URL_SCHEMES = ["curb-relay+ws:", "curb-relay+wss:"] as const;

/** The first byte of a binary frame: which audio it is. */
export const RELAY_STREAM = {
  /** Relay to agent: the linked caller at {@link RELAY_CALLER_SAMPLE_RATE}. Agent to relay: its voice at {@link RELAY_VOICE_SAMPLE_RATE}. */
  main: 0,
  /** Agent to relay: a transfer's announcement and ringback at {@link RELAY_TRANSFER_SAMPLE_RATE}. */
  transfer: 1,
} as const;

/** What Silero VAD and every wired STT consume. */
export const RELAY_CALLER_SAMPLE_RATE = 16_000;
/** Kugel TTS's native rate, so nothing resamples it on the agent's side. */
export const RELAY_VOICE_SAMPLE_RATE = 24_000;
export const RELAY_TRANSFER_SAMPLE_RATE = 48_000;

/** One person, phone line or agent in the room. `kind` is LiveKit's `ParticipantKind`. */
export type RelayParticipant = {
  identity: string;
  kind?: number;
  attributes?: Record<string, string>;
};

/** Agent to relay. */
export type RelayAgentMessage =
  /** Flush and clear of the voice, agent text and states, as on a local call. */
  | LocalVoiceServerMessage
  /** Hear this participant from now on; null hears nobody. */
  | { type: "listen"; identity: string | null }
  /** Publish the transfer track; answered by `transfer_ready`. */
  | { type: "transfer_open" }
  /** Say when everything sent so far has played; answered by `transfer_played`. */
  | { type: "transfer_wait"; id: number }
  /** Drop the transfer audio still queued. */
  | { type: "transfer_clear" }
  | { type: "transfer_close" }
  /** Answer RPCs to this method; each comes as an `rpc_request`. */
  | { type: "rpc_register"; method: string }
  | { type: "rpc_unregister"; method: string }
  | { type: "rpc_response"; id: number; payload?: string; error?: RelayRpcError }
  /** A text stream to the room on `topic`; answered by `send_text_result`. */
  | { type: "send_text"; id: number; topic: string; text: string }
  /** The call is over: leave the room and close this socket. */
  | { type: "leave" };

export type RelayRpcError = { code: number; message: string; data?: string };

/** Relay to agent. */
export type RelayRoomMessage =
  /** The relay is in the room: its name, and everyone already there besides the agent. */
  | { type: "joined"; room: string; participants: RelayParticipant[] }
  | { type: "participant_connected"; participant: RelayParticipant }
  | { type: "participant_updated"; participant: RelayParticipant }
  | { type: "participant_disconnected"; identity: string }
  /** The segment the last `audio_flush` closed has played to its end. */
  | { type: "playout_done"; playedMs: number }
  /** The segment was cut by `audio_clear` after `playedMs` of it had played. */
  | { type: "playout_cleared"; playedMs: number }
  /** A message the caller typed on the room's chat topic. */
  | { type: "typed_text"; text: string }
  | { type: "transfer_ready" }
  | { type: "transfer_failed"; message: string }
  | { type: "transfer_played"; id: number }
  | { type: "rpc_request"; id: number; method: string; payload: string; callerIdentity: string; responseTimeoutMs: number }
  | { type: "send_text_result"; id: number; error?: string }
  /** The relay lost the room. The socket closes after this. */
  | { type: "room_lost"; reason: string };

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function isParticipant(value: unknown): value is RelayParticipant {
  if (typeof value !== "object" || value === null) return false;
  const { identity, kind, attributes } = value as Record<string, unknown>;
  return (
    isString(identity) &&
    (kind === undefined || typeof kind === "number") &&
    (attributes === undefined ||
      (typeof attributes === "object" && attributes !== null && Object.values(attributes).every(isString)))
  );
}

/** One text frame from the relay. Throws on anything this framework does not know. */
export function parseRelayRoomMessage(raw: string): RelayRoomMessage {
  const message = JSON.parse(raw) as Record<string, unknown> & { type?: unknown };
  const valid = (() => {
    switch (message.type) {
      case "joined":
        return isString(message.room) && Array.isArray(message.participants) && message.participants.every(isParticipant);
      case "participant_connected":
      case "participant_updated":
        return isParticipant(message.participant);
      case "participant_disconnected":
        return isString(message.identity);
      case "playout_done":
      case "playout_cleared":
        return isCount(message.playedMs);
      case "typed_text":
        return isString(message.text);
      case "transfer_ready":
        return true;
      case "transfer_failed":
        return isString(message.message);
      case "transfer_played":
        return isCount(message.id);
      case "rpc_request":
        return (
          isCount(message.id) &&
          isString(message.method) &&
          isString(message.payload) &&
          isString(message.callerIdentity) &&
          isCount(message.responseTimeoutMs)
        );
      case "send_text_result":
        return isCount(message.id) && (message.error === undefined || isString(message.error));
      case "room_lost":
        return isString(message.reason);
      default:
        return false;
    }
  })();
  if (!valid) throw new Error(`Unknown media relay message: ${raw.slice(0, 120)}`);
  return message as unknown as RelayRoomMessage;
}

/** Whether `url` selects the relay route rather than a realtime room. */
export function isRelayUrl(url: string): boolean {
  return RELAY_URL_SCHEMES.some((scheme) => url.startsWith(`${scheme}//`));
}

/** The socket address of a relay URL: `curb-relay+wss://host/x` is `wss://host/x`. */
export function relaySocketUrl(url: string): string {
  if (!isRelayUrl(url)) throw new Error(`${url} is not a media relay URL (${RELAY_URL_SCHEMES.join(", ")})`);
  return url.slice("curb-relay+".length);
}
