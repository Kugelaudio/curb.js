import { createContext, createElement, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import type { z } from "zod";
import { AUTHORING_DIAGNOSTIC_CODES, AgentAuthoringError } from "./authoring.js";

/**
 * App messages: small keyed messages between agent code and the two parties around a call,
 * the CLIENT (the app the caller uses, over LiveKit) and the HOST (whatever runs the call,
 * over the host protocol).
 *
 *   const send = useSend();
 *   send.toClient("show-form", { form: "claim" });
 *   send.toHost("lead", { score: 0.9 });
 *   const answer = await send.askHost("human.requested", {});
 *   useMessage("claim-submitted", { from: "client", schema, onMessage });
 *
 * ONE HUB PER RUNTIME, so two calls on one runner never see each other's messages or
 * replies. The hub knows nothing about transport: a host or a LiveKit room connects a
 * function that publishes outgoing messages and calls `deliver` with incoming ones, and
 * THE TRANSPORT STAMPS THE ORIGIN, never the payload. A `from: "client"` handler never sees
 * a host message and vice versa.
 *
 * Refusals are coded, never silent (see {@link MessageRefusedError}).
 *
 * Browser-safe: no Node imports, because `src/index.ts` exports the hooks.
 */

/** Who sent a message. Stamped by the transport it arrived on. */
export type MessageOrigin = "client" | "host";

/** Keys are any non-empty string up to this many characters, used verbatim on the wire. */
export const MAX_MESSAGE_KEY_LENGTH = 256;

/** How long `askHost` waits for a reply unless told otherwise. */
export const DEFAULT_ASK_TIMEOUT_MS = 10_000;

/** Why an incoming message was refused. */
export const MESSAGE_REFUSAL_CODES = ["no_handler", "invalid_payload", "handler_failed"] as const;
export type MessageRefusalCode = (typeof MESSAGE_REFUSAL_CODES)[number];

/** One schema failure, as it is reported to the sender. */
export interface MessageIssue {
  path: Array<string | number>;
  message: string;
}

/** An incoming message, as its transport hands it over. */
export interface IncomingMessage {
  id: string;
  key: string;
  payload: unknown;
  /** Host messages only: the `askHost` this answers. */
  inReplyTo?: string;
}

/** What a handler is told besides the payload. */
export interface MessageMeta {
  id: string;
  key: string;
  from: MessageOrigin;
}

/** A message from the agent to its host, as the host transport publishes it. */
export interface OutgoingHostMessage {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  expectsReply: boolean;
}

/** A message from the agent to its client, as the client transport publishes it. */
export interface OutgoingClientMessage {
  id: string;
  key: string;
  payload: Record<string, unknown>;
}

/** Publishes one outgoing message. Returns false when it could not leave. */
export type HostTransport = (message: OutgoingHostMessage) => boolean;

/**
 * What became of a message to the client: sent, or why not. A call whose caller is a phone
 * (SIP only) has no app to reach; a call whose app has not joined YET is a different case,
 * warned about separately.
 */
export type ClientDelivery = "sent" | "no_client_yet" | "phone_call";
export type ClientTransport = (message: OutgoingClientMessage) => ClientDelivery;

/** What the agent sent to the client app, for the call record. */
export type ClientTraffic =
  | { kind: "message_to_client"; key: string; id: string; payload: Record<string, unknown> }
  | { kind: "reply_to_client"; key: string; id: string; reply: unknown };

/** Messages `toClient` / `toHost` dropped in this call, per key. */
export interface UndeliveredCounts {
  toClient: Record<string, number>;
  toHost: Record<string, number>;
}

/** `useSend()`: stable across renders; safe to call from tool handlers. */
export interface MessageSender {
  /**
   * Fire and forget to the client app. A phone call (no app), or an app that has not joined
   * yet, drops it with one warning per key and reason, and counts it in the call record.
   */
  toClient(key: string, payload?: Record<string, unknown>): void;
  /** Fire and forget to the host. With no host connected: dropped, one warning per key. */
  toHost(key: string, payload?: Record<string, unknown>): void;
  /**
   * Send to the host and wait for the host message whose `inReplyTo` is this one's id;
   * resolves with that message's payload. Rejects {@link HostUnavailableError} when no
   * host is connected and {@link HostTimeoutError} after `timeoutMs` (default 10000).
   */
  askHost(
    key: string,
    payload?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

/**
 * An incoming message was not taken. The transport returns `code` to the sender: the HTTP
 * error body over the host protocol, the RPC error over LiveKit.
 */
export class MessageRefusedError extends Error {
  readonly code: MessageRefusalCode;
  readonly key: string;
  readonly from: MessageOrigin;
  /** On `invalid_payload`: what the schema refused. */
  readonly issues: MessageIssue[] | undefined;

  constructor(
    code: MessageRefusalCode,
    message: { key: string; from: MessageOrigin },
    detail: string,
    extra: { issues?: MessageIssue[]; cause?: unknown } = {},
  ) {
    super(`${code}: ${detail}`, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "MessageRefusedError";
    this.code = code;
    this.key = message.key;
    this.from = message.from;
    this.issues = extra.issues;
  }
}

/** No host is connected, or the call ended while an `askHost` waited. */
export class HostUnavailableError extends Error {
  readonly key: string;

  constructor(key: string, why = "no host is connected to this call") {
    super(
      `host message "${key}" was not sent: ${why}. Give the caller an answer that does not ` +
        `need a host when askHost rejects with this error.`,
    );
    this.name = "HostUnavailableError";
    this.key = key;
  }
}

/** The host did not reply in time. */
export class HostTimeoutError extends Error {
  readonly key: string;
  readonly requestId: string;
  readonly timeoutMs: number;

  constructor(key: string, requestId: string, timeoutMs: number) {
    super(
      `askHost("${key}") (id ${requestId}) got no reply within ${timeoutMs} ms. A reply ` +
        `that arrives later reaches a useMessage handler for its key from the host, and is ` +
        `refused with no_handler when there is none.`,
    );
    this.name = "HostTimeoutError";
    this.key = key;
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

/** One `useMessage` registration. */
export interface MessageListener {
  schema?: z.ZodType;
  onMessage: (payload: unknown, meta: MessageMeta) => unknown;
}

type Pending = {
  key: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface AppMessagesOptions {
  /** Called after every handled incoming message, once its handlers have settled. */
  onDelivered?: () => void;
  newId?: () => string;
  warn?: (message: string) => void;
  error?: (message: string, error: unknown) => void;
}

export class AppMessages {
  #host: HostTransport | null = null;
  #client: ClientTransport | null = null;
  #recorder: ((traffic: ClientTraffic) => void) | null = null;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Map<string, Set<MessageListener>>();
  /** `origin:key` pairs already warned about as undeliverable, so each warns once. */
  readonly #warned = new Set<string>();
  readonly #undelivered: UndeliveredCounts = { toClient: {}, toHost: {} };
  readonly #onDelivered: (() => void) | undefined;
  readonly #newId: () => string;
  readonly #warn: (message: string) => void;
  readonly #error: (message: string, error: unknown) => void;
  /** Stable, so components can hold it across renders. */
  readonly send: MessageSender;

  constructor(options: AppMessagesOptions = {}) {
    this.#onDelivered = options.onDelivered;
    this.#newId = options.newId ?? (() => globalThis.crypto.randomUUID());
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#error = options.error ?? ((message, error) => console.error(message, error));
    this.send = {
      toClient: (key, payload) => this.#toClient(key, payload),
      toHost: (key, payload) => this.#toHost(key, payload),
      askHost: (key, payload, askOptions) => this.#askHost(key, payload, askOptions),
    };
  }

  /** Messages `toClient`/`toHost` dropped because nothing could carry them, per key. */
  undeliveredCounts(): UndeliveredCounts {
    return { toClient: { ...this.#undelivered.toClient }, toHost: { ...this.#undelivered.toHost } };
  }

  /** True while a host is connected to this call. */
  get hostConnected(): boolean {
    return this.#host !== null;
  }

  /**
   * Attach the host, or detach it with `null`. Detaching rejects every waiting `askHost`
   * with {@link HostUnavailableError}: the host that would have answered is gone.
   */
  connectHost(transport: HostTransport | null): void {
    this.#host = transport;
    if (transport !== null) return;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new HostUnavailableError(pending.key, "the call ended before the host replied"));
    }
  }

  /**
   * Record what the agent sends the client app (the call record), or stop with `null`. Set
   * where the call keeps a record; a call that keeps none records nothing.
   */
  connectRecorder(recorder: ((traffic: ClientTraffic) => void) | null): void {
    this.#recorder = recorder;
  }

  /** The client transport reports a reply it sent to a client's ask. */
  recordReplyToClient(key: string, id: string, reply: unknown): void {
    this.#recorder?.({ kind: "reply_to_client", key, id, reply });
  }

  /** Attach the client data channel, or detach it with `null`. */
  connectClient(transport: ClientTransport | null): void {
    this.#client = transport;
  }

  /**
   * One incoming message. A host message whose `inReplyTo` names a waiting `askHost`
   * resolves it and needs no handler. Anything else runs every `useMessage` handler for its
   * key and origin, in mount order, after every handler's schema accepted the payload.
   *
   * Resolves with `reply`, the most recently mounted handler's return value. Rejects with
   * {@link MessageRefusedError}: `no_handler`, `invalid_payload` (no handler ran), or
   * `handler_failed` (a handler threw; the others still ran).
   */
  async deliver(from: MessageOrigin, message: IncomingMessage): Promise<{ reply?: unknown }> {
    if (from === "host" && message.inReplyTo !== undefined) {
      const pending = this.#pending.get(message.inReplyTo);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(message.inReplyTo);
        pending.resolve(isRecord(message.payload) ? message.payload : {});
        this.#onDelivered?.();
        return {};
      }
    }

    const origin = { key: message.key, from };
    const listeners = [...(this.#listeners.get(slot(from, message.key)) ?? [])];
    if (listeners.length === 0) {
      throw new MessageRefusedError(
        "no_handler",
        origin,
        `no useMessage handler listens for "${message.key}" from the ${from}`,
      );
    }

    const payloads: unknown[] = [];
    for (const listener of listeners) {
      if (listener.schema === undefined) {
        payloads.push(message.payload);
        continue;
      }
      const parsed = listener.schema.safeParse(message.payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
          message: issue.message,
        }));
        throw new MessageRefusedError(
          "invalid_payload",
          origin,
          `the payload of "${message.key}" does not match its schema: ${describeIssues(issues)}`,
          { issues },
        );
      }
      payloads.push(parsed.data);
    }

    const meta: MessageMeta = { id: message.id, key: message.key, from };
    let reply: unknown;
    let failure: { error: unknown } | null = null;
    for (const [index, listener] of listeners.entries()) {
      try {
        reply = await listener.onMessage(payloads[index], meta);
      } catch (error) {
        // KEEP-JUSTIFIED: one handler's bug must not stop the others or the call. It is
        // logged with its cause here and refused as handler_failed below.
        failure ??= { error };
        this.#error(`[curb] useMessage handler for "${message.key}" from the ${from} threw:`, error);
      }
    }
    this.#onDelivered?.();
    if (failure !== null) {
      throw new MessageRefusedError(
        "handler_failed",
        origin,
        `a useMessage handler for "${message.key}" threw`,
        { cause: failure.error },
      );
    }
    return reply === undefined ? {} : { reply };
  }

  /** Used by `useMessage`. Returns the unsubscribe function. */
  subscribe(from: MessageOrigin, key: string, listener: MessageListener): () => void {
    const name = slot(from, key);
    let set = this.#listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(name, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#listeners.get(name) === set) this.#listeners.delete(name);
    };
  }

  #toClient(key: string, payload: Record<string, unknown> = {}): void {
    checkKey(key, "useSend().toClient");
    checkPayload(payload, "useSend().toClient");
    const transport = this.#client;
    const id = this.#newId();
    const outcome = transport === null ? "no_client_yet" : transport({ id, key, payload });
    if (outcome === "sent") {
      this.#recorder?.({ kind: "message_to_client", key, id, payload });
      return;
    }
    if (outcome === "phone_call") {
      this.#dropped("client", key, "this call has no client data channel (a phone call)", "phone");
    } else {
      this.#dropped("client", key, "no client app has joined this call yet", "none");
    }
  }

  #toHost(key: string, payload: Record<string, unknown> = {}): void {
    checkKey(key, "useSend().toHost");
    checkPayload(payload, "useSend().toHost");
    const transport = this.#host;
    if (transport !== null && transport({ id: this.#newId(), name: key, payload, expectsReply: false })) {
      return;
    }
    this.#dropped("host", key, "no host is connected to this call", "none");
  }

  #dropped(to: MessageOrigin, key: string, why: string, reason: "none" | "phone"): void {
    const counts = to === "client" ? this.#undelivered.toClient : this.#undelivered.toHost;
    counts[key] = (counts[key] ?? 0) + 1;
    const name = `${reason}:${slot(to, key)}`;
    if (this.#warned.has(name)) return;
    this.#warned.add(name);
    this.#warn(`[curb] send.to${to === "client" ? "Client" : "Host"}("${key}") was dropped: ${why}. Warned once per key.`);
  }

  #askHost(
    key: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    checkKey(key, "useSend().askHost");
    checkPayload(payload, "useSend().askHost");
    const timeoutMs = options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw invalid(
        "useSend().askHost",
        `timeoutMs must be a positive number of milliseconds, got ${String(timeoutMs)}.`,
        "Pass { timeoutMs: 10000 } or omit it for the 10000 ms default.",
      );
    }
    const transport = this.#host;
    if (transport === null) return Promise.reject(new HostUnavailableError(key));

    const id = this.#newId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HostTimeoutError(key, id, timeoutMs));
      }, timeoutMs);
      // Registered BEFORE publishing, so a reply that arrives synchronously is not lost.
      this.#pending.set(id, { key, resolve, reject, timer });
      if (!transport({ id, name: key, payload, expectsReply: true })) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new HostUnavailableError(key, "the host transport did not accept it"));
      }
    });
  }
}

function slot(from: MessageOrigin, key: string): string {
  return `${from}:${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `claimId: Invalid input; (payload): ...`, the same shape the host protocol uses. */
export function describeIssues(issues: readonly MessageIssue[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "(payload)"}: ${issue.message}`).join("; ");
}

/** True for a key the wire accepts: any non-empty string up to 256 characters. */
export function isMessageKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= MAX_MESSAGE_KEY_LENGTH;
}

function invalid(component: string, message: string, fix: string): AgentAuthoringError {
  return new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message,
    location: { component },
    fix,
  });
}

function checkKey(key: unknown, component: string): void {
  if (isMessageKey(key)) return;
  throw invalid(
    component,
    `${JSON.stringify(key)} is not a message key.`,
    `Use a non-empty string of at most ${MAX_MESSAGE_KEY_LENGTH} characters, for example "claim-submitted".`,
  );
}

function checkPayload(payload: unknown, component: string): void {
  if (isRecord(payload)) return;
  throw invalid(
    component,
    `the payload must be a plain object, got ${Array.isArray(payload) ? "an array" : typeof payload}.`,
    "Wrap the value in an object, for example { value }.",
  );
}

const AppMessagesContext = createContext<AppMessages | null>(null);

/** Mounted by `AgentSiteRuntime` around every site; authors never render this. */
export function AppMessagesProvider({
  messages,
  children,
}: {
  messages: AppMessages;
  children?: ReactNode;
}) {
  return createElement(AppMessagesContext.Provider, { value: messages }, children);
}

/** The hub of the runtime rendering this component, for the framework's own hooks
 * (`useTransferCall`). Throws outside a runtime render. */
export function useAppMessages(hook: string): AppMessages {
  const messages = useContext(AppMessagesContext);
  if (messages === null) {
    throw new Error(`${hook} must be used inside an agent runtime render.`);
  }
  return messages;
}

/** Send to the client app or the host. Stable across renders; safe in tool handlers. */
export function useSend(): MessageSender {
  return useAppMessages("useSend").send;
}

/** `useMessage` with a schema: the handler gets the parsed payload. */
export interface UseMessageWithSchema<S extends z.ZodType> {
  from: MessageOrigin;
  schema: S;
  /** The return value (or what its promise resolves to) is the reply to a client's ask. */
  onMessage: (payload: z.output<S>, meta: MessageMeta) => unknown;
}

/** `useMessage` without a schema: the payload is `unknown`. */
export interface UseMessageWithoutSchema {
  from: MessageOrigin;
  schema?: undefined;
  onMessage: (payload: unknown, meta: MessageMeta) => unknown;
}

/**
 * Handle every message with `key` from `from` for as long as the component is mounted.
 * A payload the schema refuses is answered `invalid_payload` and never reaches `onMessage`.
 */
export function useMessage<S extends z.ZodType>(key: string, options: UseMessageWithSchema<S>): void;
export function useMessage(key: string, options: UseMessageWithoutSchema): void;
export function useMessage(
  key: string,
  options: UseMessageWithSchema<z.ZodType> | UseMessageWithoutSchema,
): void {
  const messages = useAppMessages("useMessage");
  checkKey(key, "useMessage");
  if (options.from !== "client" && options.from !== "host") {
    throw invalid(
      "useMessage",
      `from must be "client" or "host", got ${JSON.stringify(options.from)}.`,
      'Say who sends this message: { from: "client" } for the caller\'s app, { from: "host" } for the host.',
    );
  }
  const latest = useRef(options);
  latest.current = options;
  const { from } = options;
  // A layout effect: the runtime commits synchronously, so the subscription exists as soon
  // as the render that mounted it returns.
  useLayoutEffect(
    () =>
      messages.subscribe(from, key, {
        get schema() {
          return latest.current.schema;
        },
        onMessage: (payload, meta) => latest.current.onMessage(payload as never, meta),
      }),
    [messages, from, key],
  );
}
