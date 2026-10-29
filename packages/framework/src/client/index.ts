/**
 * `curb/client`: talk to a Curb agent from the app the caller uses.
 *
 *   import { connectAgent } from "curb/client";
 *   const agent = connectAgent(room);              // a LiveKit Room the app already owns
 *   agent.on("show-form", ({ form }) => openForm(form));
 *   await agent.send("claim-submitted", { claimId: "C-17" });
 *   const quote = await agent.ask("quote", { plan: "basic" });
 *   await agent.update({ tts: { voice: 17 } });
 *
 * Works with any connected `livekit-client` Room, including `useRoomContext()` from
 * `@livekit/components-react`. The wire format is plain LiveKit (see `../wire.ts`), so this
 * module is a convenience, not a requirement.
 *
 * BROWSER-ONLY AND SMALL: it imports `livekit-client` and the dependency-free wire constants,
 * nothing else at runtime (`client.browser-safe.test.ts` holds it to that).
 */

import { ParticipantKind, RoomEvent, type Room, type TextStreamReader } from "livekit-client";
import type { EffectiveSettings, SessionUpdate } from "../settings-update.js";
import {
  CLIENT_MESSAGE_RPC_ERRORS,
  CURB_MESSAGE_RPC_METHOD,
  CURB_MESSAGE_TOPIC,
  CURB_UPDATE_RPC_METHOD,
  MAX_CLIENT_MESSAGE_BYTES,
  type ClientRefusalCode,
} from "../wire.js";

export type { EffectiveSettings, SessionUpdate };
export type { AdjustablePath } from "../settings-update.js";
export { MAX_CLIENT_MESSAGE_BYTES };

/** How long a call waits for the agent to join and to answer, unless told otherwise. */
export const DEFAULT_AGENT_TIMEOUT_MS = 10_000;

/** One problem with a refused payload or update, `path` into it. */
export interface AgentIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * The agent refused a message or an update, with a code:
 * `no_handler`, `invalid_payload`, `handler_failed`, `payload_too_large` (checked here,
 * before sending), `not_adjustable` (with `path`), `invalid_settings` (with `issues`).
 */
export class AgentRefusedError extends Error {
  readonly code: ClientRefusalCode;
  readonly issues: AgentIssue[] | undefined;
  readonly path: string | undefined;

  constructor(code: ClientRefusalCode, detail: string, extra: { issues?: AgentIssue[]; path?: string } = {}) {
    super(`${code}: ${detail}`);
    this.name = "AgentRefusedError";
    this.code = code;
    this.issues = extra.issues;
    this.path = extra.path;
  }
}

/** No agent joined the room in time, or this client was closed. */
export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export interface AgentClient {
  /** Send an app message; resolves once the agent's handlers took it. */
  send(key: string, payload?: unknown): Promise<void>;
  /** Send an app message and resolve with what the agent's `useMessage` handler returned. */
  ask<T = unknown>(key: string, payload?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  /** Handle every agent message with `key` (`useSend().toClient(key, …)`). Returns the unsubscribe. */
  on(key: string, handler: (payload: unknown, meta: { id: string }) => void): () => void;
  /** Change live settings the agent's `<Agent adjustable={{ client: [...] }}>` allows. */
  update(settings: SessionUpdate): Promise<EffectiveSettings>;
  /** Stop listening for agent messages. Later calls reject with {@link AgentUnavailableError}. */
  close(): void;
}

export interface ConnectAgentOptions {
  /** The agent participant's identity. Default: the first remote participant of kind AGENT. */
  agentIdentity?: string;
}

const REFUSAL_BY_CODE = new Map<number, ClientRefusalCode>(
  Object.entries(CLIENT_MESSAGE_RPC_ERRORS).map(([name, code]) => [code, name as ClientRefusalCode]),
);

/**
 * Connect to the agent in `room`. Registers the handler for agent messages at once (one
 * client per room: LiveKit allows one handler per topic). The agent need not be there yet;
 * each call waits for it to join, up to its timeout.
 */
export function connectAgent(room: Room, options: ConnectAgentOptions = {}): AgentClient {
  const handlers = new Map<string, Set<(payload: unknown, meta: { id: string }) => void>>();
  const unhandledWarned = new Set<string>();
  let closed = false;

  const isAgent = (identity: string): boolean => {
    if (options.agentIdentity !== undefined) return identity === options.agentIdentity;
    return room.remoteParticipants.get(identity)?.kind === ParticipantKind.AGENT;
  };
  const findAgent = (): string | undefined => {
    if (options.agentIdentity !== undefined) {
      return room.remoteParticipants.has(options.agentIdentity) ? options.agentIdentity : undefined;
    }
    for (const participant of room.remoteParticipants.values()) {
      if (participant.kind === ParticipantKind.AGENT) return participant.identity;
    }
    return undefined;
  };
  const waitForAgent = (timeoutMs: number): Promise<string> => {
    const present = findAgent();
    if (present !== undefined) return Promise.resolve(present);
    return new Promise((resolve, reject) => {
      const onJoin = () => {
        const joined = findAgent();
        if (joined === undefined) return;
        cleanup();
        resolve(joined);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new AgentUnavailableError(
            `no agent ${options.agentIdentity === undefined ? "participant" : `"${options.agentIdentity}"`} ` +
              `joined the room within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        room.off(RoomEvent.ParticipantConnected, onJoin);
      };
      room.on(RoomEvent.ParticipantConnected, onJoin);
    });
  };

  const rpc = async (method: string, payload: string, timeoutMs: number): Promise<string> => {
    if (closed) throw new AgentUnavailableError("this agent client was closed");
    const size = new TextEncoder().encode(payload).length;
    if (size > MAX_CLIENT_MESSAGE_BYTES) {
      throw new AgentRefusedError(
        "payload_too_large",
        `the request is ${size} bytes; LiveKit RPC carries at most ${MAX_CLIENT_MESSAGE_BYTES}`,
      );
    }
    const destinationIdentity = await waitForAgent(timeoutMs);
    try {
      return await room.localParticipant.performRpc({
        destinationIdentity,
        method,
        payload,
        responseTimeout: timeoutMs,
      });
    } catch (error) {
      throw refusalFrom(error) ?? error;
    }
  };

  const message = (key: string, payload: unknown, timeoutMs: number) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) {
      return Promise.reject(new TypeError(`a message key is a string of 1 to 256 characters, got ${JSON.stringify(key)}`));
    }
    return rpc(CURB_MESSAGE_RPC_METHOD, JSON.stringify({ key, id: newId(), payload: payload ?? {} }), timeoutMs);
  };

  room.registerTextStreamHandler(CURB_MESSAGE_TOPIC, (reader: TextStreamReader, participant: { identity: string }) => {
    void receive(reader, participant.identity);
  });

  async function receive(reader: TextStreamReader, identity: string): Promise<void> {
    const text = await reader.readAll();
    if (closed) return;
    if (!isAgent(identity)) {
      console.warn(`[curb] ignored a "${CURB_MESSAGE_TOPIC}" text stream from ${identity}, which is not the agent.`);
      return;
    }
    let envelope: { key?: unknown; id?: unknown; payload?: unknown };
    try {
      envelope = JSON.parse(text) as typeof envelope;
    } catch {
      console.warn(`[curb] ignored an agent message that is not JSON: ${text.slice(0, 80)}`);
      return;
    }
    if (typeof envelope.key !== "string" || typeof envelope.id !== "string") {
      console.warn(`[curb] ignored an agent message without a key and an id: ${text.slice(0, 80)}`);
      return;
    }
    const listeners = handlers.get(envelope.key);
    if (listeners === undefined || listeners.size === 0) {
      if (!unhandledWarned.has(envelope.key)) {
        unhandledWarned.add(envelope.key);
        console.warn(`[curb] no agent.on("${envelope.key}") handler; the agent's message was dropped. Warned once per key.`);
      }
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(envelope.payload, { id: envelope.id });
      } catch (error) {
        console.error(`[curb] agent.on("${envelope.key}") handler threw:`, error);
      }
    }
  }

  return {
    async send(key, payload) {
      await message(key, payload, DEFAULT_AGENT_TIMEOUT_MS);
    },
    async ask<T>(key: string, payload?: unknown, opts: { timeoutMs?: number } = {}) {
      const answer = await message(key, payload, opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);
      return (JSON.parse(answer) as { reply?: unknown }).reply as T;
    },
    on(key, handler) {
      let set = handlers.get(key);
      if (set === undefined) {
        set = new Set();
        handlers.set(key, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    async update(settings) {
      return JSON.parse(await rpc(CURB_UPDATE_RPC_METHOD, JSON.stringify(settings), DEFAULT_AGENT_TIMEOUT_MS)) as EffectiveSettings;
    },
    close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      room.unregisterTextStreamHandler(CURB_MESSAGE_TOPIC);
    },
  };
}

/** A Curb refusal from an RpcError, or null for any other failure (a timeout, a disconnect). */
function refusalFrom(error: unknown): AgentRefusedError | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "number") return null;
  const name = REFUSAL_BY_CODE.get(code);
  if (name === undefined) return null;
  const raw = (error as { data?: unknown }).data;
  let data: { issues?: AgentIssue[]; path?: string } = {};
  if (typeof raw === "string" && raw !== "") {
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      // KEEP-JUSTIFIED: the code is the contract; `data` is detail. A refusal whose detail
      // is not JSON is still that refusal, reported with its raw text below.
    }
  }
  return new AgentRefusedError(name, typeof raw === "string" && raw !== "" ? raw : "the agent refused it", {
    ...(Array.isArray(data.issues) ? { issues: data.issues } : {}),
    ...(typeof data.path === "string" ? { path: data.path } : {}),
  });
}

function newId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.randomUUID !== undefined) return crypto.randomUUID();
  // An insecure context (plain http on a LAN address) has no randomUUID; an id only has to be
  // unique within this call.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
