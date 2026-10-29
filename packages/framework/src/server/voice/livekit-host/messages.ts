/**
 * The client side of a call over LiveKit: app messages (`useSend` / `useMessage`) and live
 * settings (`<Agent adjustable>`).
 *
 * The wire format is plain LiveKit, so raw `livekit-client` and the native SDKs work
 * (constants and refusal codes in `../../../wire.ts`):
 *
 *   agent -> client   text stream on topic `curb.message`, body `{ key, id, payload }`
 *   client -> agent   RPC method `curb.message` on the agent participant, request
 *                     `{ key, id, payload }`, response `{ reply? }`, or an RpcError whose
 *                     message is the refusal code (see {@link CLIENT_MESSAGE_RPC_ERRORS})
 *   client -> agent   RPC method `curb.update`, request a `SessionUpdate`, response the
 *                     `EffectiveSettings`, or an RpcError `not_adjustable` / `invalid_settings`
 *
 * Client to agent is RPC rather than a text stream so every send gets an acknowledgement
 * or a coded error.
 *
 * ONE BRIDGE PER ROOM, attached by whatever connects the room, AS SOON AS it is connected:
 * the agent participant is visible to the caller's app from that moment, and an RPC to a
 * method not registered yet fails with LiveKit's unsupported-method error. The voice session
 * binds it to its runtime once that exists; a request that arrives earlier waits for the
 * bind (up to {@link BIND_WAIT_MS}). A rewind binds the next runtime, and the RPC methods keep
 * answering for whichever runtime is current; outside settings changes move with it.
 */

import { ParticipantKind, RpcError, type RpcInvocationData } from "@livekit/rtc-node";
import {
  MessageRefusedError,
  isMessageKey,
  type AppMessages,
  type ClientDelivery,
  type OutgoingClientMessage,
} from "../../../messages.js";
import type { SessionSettings } from "../../../session-settings.js";
import { SettingsRefusedError } from "../../../settings-update.js";
import {
  CLIENT_MESSAGE_RPC_ERRORS,
  CURB_MESSAGE_RPC_METHOD,
  CURB_MESSAGE_TOPIC,
  CURB_UPDATE_RPC_METHOD,
  MAX_CLIENT_MESSAGE_BYTES,
  type ClientRefusalCode,
} from "../../../wire.js";
import { logError } from "../../log.js";

export {
  CLIENT_MESSAGE_RPC_ERRORS,
  CURB_MESSAGE_RPC_METHOD,
  CURB_MESSAGE_TOPIC,
  CURB_UPDATE_RPC_METHOD,
  MAX_CLIENT_MESSAGE_BYTES,
};

/** How long a client request that arrived before the session bound the bridge waits for it. */
export const BIND_WAIT_MS = 10_000;

/** What a bridge serves: one conversation's app messages and settings (a runtime fits). */
export interface ClientBridgeTarget {
  messages: AppMessages;
  settings: SessionSettings;
}

/** The room surface the bridge uses, so a test can hand in a fake participant. */
export interface MessagingRoom {
  localParticipant?: {
    registerRpcMethod(method: string, handler: (data: RpcInvocationData) => Promise<string>): void;
    unregisterRpcMethod(method: string): void;
    sendText(text: string, options?: { topic?: string }): Promise<unknown>;
  };
  remoteParticipants: Map<string, { kind: ParticipantKind }>;
}

/** `attachClientMessages` options. */
export interface ClientBridgeOptions {
  roomName?: string;
  log?: (message: string) => void;
  /** Replaces {@link BIND_WAIT_MS}. */
  bindWaitMs?: number;
}

export interface ClientMessageBridge {
  /**
   * Serve `target`: connect its client transport and answer both RPCs with it. Binding a
   * new target mid-call (a rewind) carries the outside settings changes onto it.
   */
  bind(target: ClientBridgeTarget): void;
  /** Stop serving: unregister the RPC methods and disconnect the client transport. */
  detach(): void;
}

/**
 * Wire app messages and settings onto a CONNECTED `room`. Registers both RPC methods at
 * once. A request before `bind` waits for it; one still unbound after the wait is refused
 * `no_handler` (a message) or `not_adjustable` (an update), and at once after `detach`.
 */
export function attachClientMessages(
  room: MessagingRoom,
  options: ClientBridgeOptions = {},
): ClientMessageBridge {
  const log = options.log ?? ((message: string) => logError("voice", message));
  const where = options.roomName ?? "the room";
  const bindWaitMs = options.bindWaitMs ?? BIND_WAIT_MS;
  const participant = room.localParticipant;
  let bound: ClientBridgeTarget | null = null;
  let detached = false;
  const waiting = new Set<(target: ClientBridgeTarget | null) => void>();

  /** The bound target, waiting for the bind when there is none yet; null when it never came. */
  const target = (): Promise<ClientBridgeTarget | null> => {
    if (bound !== null || detached) return Promise.resolve(bound);
    return new Promise((resolve) => {
      const done = (value: ClientBridgeTarget | null) => {
        clearTimeout(timer);
        waiting.delete(done);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), bindWaitMs);
      waiting.add(done);
    });
  };
  const release = (value: ClientBridgeTarget | null) => {
    for (const done of [...waiting]) done(value);
  };

  // Who could receive a message. A phone caller (SIP) has no app; an app that has not joined
  // yet is another case, so the hub can warn about each separately. Other agents are not
  // clients.
  const reach = (): ClientDelivery => {
    const people = [...room.remoteParticipants.values()].filter((p) => p.kind !== ParticipantKind.AGENT);
    if (people.some((p) => p.kind !== ParticipantKind.SIP)) return "sent";
    return people.length > 0 ? "phone_call" : "no_client_yet";
  };

  const transport = (message: OutgoingClientMessage): ClientDelivery => {
    const outcome = participant === undefined ? "no_client_yet" : reach();
    if (outcome !== "sent" || participant === undefined) return outcome;
    participant
      .sendText(JSON.stringify({ key: message.key, id: message.id, payload: message.payload }), {
        topic: CURB_MESSAGE_TOPIC,
      })
      .catch((error: unknown) => {
        log(`could not send app message "${message.key}" to the client in ${where}: ${describe(error)}`);
      });
    return "sent";
  };

  participant?.registerRpcMethod(CURB_MESSAGE_RPC_METHOD, async (data) => {
    if (tooLarge(data.payload)) {
      throw refusal("payload_too_large", `the request is over ${MAX_CLIENT_MESSAGE_BYTES} bytes`);
    }
    const envelope = parseEnvelope(data.payload);
    if (typeof envelope === "string") throw refusal("invalid_payload", envelope);
    const serving = await target();
    if (serving === null) throw refusal("no_handler", "no agent runtime is serving this call");
    let answer: { reply?: unknown };
    try {
      answer = await serving.messages.deliver("client", envelope);
    } catch (error) {
      if (error instanceof MessageRefusedError) {
        // The issues go back to the client; a handler's error stays on the server, where
        // the hub already logged it.
        throw refusal(error.code, error.issues === undefined ? undefined : JSON.stringify({ issues: error.issues }));
      }
      throw error;
    }
    try {
      const response = JSON.stringify(answer);
      if ("reply" in answer) serving.messages.recordReplyToClient(envelope.key, envelope.id, answer.reply);
      return response;
    } catch (error) {
      log(`the reply to app message "${envelope.key}" in ${where} is not JSON: ${describe(error)}`);
      throw refusal("handler_failed");
    }
  });

  // Live settings, origin `client`: the same gate and checks as the host's PATCH.
  participant?.registerRpcMethod(CURB_UPDATE_RPC_METHOD, async (data) => {
    if (tooLarge(data.payload)) {
      throw refusal("payload_too_large", `the request is over ${MAX_CLIENT_MESSAGE_BYTES} bytes`);
    }
    let body: unknown;
    try {
      body = JSON.parse(data.payload);
    } catch {
      throw refusal("invalid_settings", JSON.stringify({ issues: [{ path: [], message: "the request is not JSON" }] }));
    }
    const serving = await target();
    if (serving === null) throw refusal("not_adjustable");
    try {
      return JSON.stringify(serving.settings.update("client", body));
    } catch (error) {
      if (!(error instanceof SettingsRefusedError)) throw error;
      throw refusal(
        error.code,
        JSON.stringify(error.code === "not_adjustable" ? { path: error.path } : { issues: error.issues }),
      );
    }
  });

  return {
    bind(next) {
      if (detached) return;
      const previous = bound;
      previous?.messages.connectClient(null);
      bound = next;
      next.messages.connectClient(transport);
      if (previous !== null && previous.settings !== next.settings) {
        next.settings.restoreOverrides(previous.settings.overridesSnapshot());
      }
      release(next);
    },
    detach() {
      if (detached) return;
      detached = true;
      bound?.messages.connectClient(null);
      bound = null;
      release(null);
      participant?.unregisterRpcMethod(CURB_MESSAGE_RPC_METHOD);
      participant?.unregisterRpcMethod(CURB_UPDATE_RPC_METHOD);
    },
  };
}

function tooLarge(payload: string): boolean {
  return new TextEncoder().encode(payload).length > MAX_CLIENT_MESSAGE_BYTES;
}

function refusal(code: ClientRefusalCode, data?: string): RpcError {
  return new RpcError(CLIENT_MESSAGE_RPC_ERRORS[code], code, data);
}

/** The request envelope, or why it is not one. */
function parseEnvelope(raw: string): { key: string; id: string; payload: unknown } | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "the request is not JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "the request must be an object { key, id, payload }";
  }
  const { key, id, payload } = parsed as Record<string, unknown>;
  if (!isMessageKey(key)) return "key must be a non-empty string of at most 256 characters";
  if (typeof id !== "string" || id.length < 1 || id.length > 128) {
    return "id must be a string of 1 to 128 characters";
  }
  return { key, id, payload };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
