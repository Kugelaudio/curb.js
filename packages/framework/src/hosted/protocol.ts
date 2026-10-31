import { z } from "zod";
import { AdjustablePath, EffectiveSettings, SessionUpdate } from "../settings-update.js";

/**
 * The host protocol, version 1: everything a host (an orchestrator that starts runners and
 * places calls on them) and a Curb runner say to each other.
 *
 * These schemas are the single source. The TypeScript types below are inferred from them,
 * `protocol.schema.json` is emitted from them (`npx tsx src/hosted/emit-protocol-schema.ts`),
 * and `protocol-fixtures/` holds examples every implementation can decode. A host written
 * in another language generates its types from the JSON Schema.
 *
 * Forward compatibility: readers ignore fields they do not know, so the emitted schema
 * never forbids additional properties. A journal reader also skips record classes it does
 * not know, and counts them.
 */

export const PROTOCOL_VERSION = 1;

/** Every version this runner speaks, as `/health` and a wrong-version 404 report it. */
export const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];

const nonEmpty = z.string().min(1);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
/** Milliseconds since the Unix epoch. */
const epochMs = nonNegativeInt;
const payload = z.record(z.string(), z.unknown());

// --- HTTP ---------------------------------------------------------------------------------

export const Health = z.object({
  ok: z.literal(true),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  versions: z.array(positiveInt),
});

/** Hosts classify a failure by this code, never by `detail`. */
export const ErrorCode = z.enum([
  "unauthorized",
  "unknown_version",
  "not_found",
  "invalid_request",
  "session_not_found",
  "runner_at_capacity",
  "generation_mismatch",
  "runner_draining",
  "start_failed",
  "runner_takes_no_calls",
  "cursor_too_old",
  "no_journal",
  "internal",
  // A host message the agent refused (`POST /v1/sessions/{id}/messages`, HTTP 422).
  "no_handler",
  "invalid_payload",
  "handler_failed",
  // A settings change the agent refused (`PATCH /v1/sessions/{id}`): HTTP 403 for a path its
  // `<Agent adjustable>` does not give the host, HTTP 422 for a value that does not fit.
  "not_adjustable",
  "invalid_settings",
  // A hook this runner cannot run (`/v1/hooks/...`): HTTP 501 on a runner that is not a hook
  // runner, 404 for a hook this build does not declare or a run it does not hold, and 413 for
  // an event over the route's body limit.
  "runner_takes_no_hooks",
  "hook_not_declared",
  "hook_run_not_found",
  "payload_too_large",
]);

/** The body of every non-2xx answer. */
export const ErrorBody = z.object({
  error: ErrorCode,
  detail: z.string().optional(),
  /** On `unknown_version`: the versions this runner speaks. */
  versions: z.array(positiveInt).optional(),
  /** On `cursor_too_old`: the cursor asked for and the oldest envelope still held. */
  requested: nonNegativeInt.optional(),
  oldestRetained: nonNegativeInt.optional(),
  /** On `not_adjustable`: the first path in the update the host may not change. */
  path: z.string().optional(),
  /**
   * On `invalid_payload`: what the agent's schema refused, `path` into the payload. On
   * `invalid_settings`: what is wrong with the update, `path` into its body.
   */
  issues: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
});

/**
 * Starts one call. Carries no customer secrets: the runner already holds its environment.
 *
 * `deploymentId` and `configurationVersion` pin the call to a runner generation. Each is
 * compared only when both the runner and the request state it.
 *
 * `clientContext` is what the caller's page or API client said about the call, one flat
 * string per key. The agent reads each entry as `client.<key>` from before its first turn.
 * FORGEABLE: the host passes on what a browser sent, so nothing in it is an identity or a
 * permission. The host decides its limits; absent and empty mean the same.
 *
 * `direction` is who placed the call: `outbound` when the host dialed the caller (a
 * requested callback), `inbound` when the caller reached the agent. The agent reads it as
 * `call.direction`; absent means inbound.
 *
 * `experiments` is the variant the host assigned this call in each of the agent's experiments
 * (the bundle manifest's `experiments`), experiment name to variant name. The agent reads each
 * as `experiment.<name>` (`useVariant`) from before its first turn. TRUSTED, unlike
 * `clientContext`: the host assigned it, so the runner applies it as sent. Absent and empty mean
 * the same.
 */
export const StartCallRequest = z.object({
  sessionId: nonEmpty,
  realtimeUrl: nonEmpty,
  realtimeToken: nonEmpty,
  deploymentId: nonEmpty.optional(),
  configurationVersion: positiveInt.optional(),
  clientContext: z.record(z.string(), z.string()).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  experiments: z.record(z.string(), z.string()).optional(),
});

/** `accepted: false` is an idempotent repeat of a call this runner already holds. */
export const StartCallResponse = z.object({
  sessionId: nonEmpty,
  accepted: z.boolean(),
});

/** `stopped: false` means the runner held no such call, which is still success. */
export const StopCallResponse = z.object({
  sessionId: nonEmpty,
  stopped: z.boolean(),
});

export const DrainResponse = z.object({
  draining: z.literal(true),
  activeSessions: nonNegativeInt,
});

export const CallState = z.enum(["starting", "connected", "ending", "ended"]);

export const LiveCall = z.object({
  sessionId: nonEmpty,
  state: CallState,
  startedAtMs: epochMs,
});

export const SessionList = z.object({
  sessions: z.array(LiveCall),
});

/** What a runner is for: serving `calls`, or running an agent's `hooks` after them. */
export const RunnerRole = z.enum(["calls", "hooks"]);

/** `role` is absent on a runner started with no role, which is a `calls` runner. */
export const RunnerStatus = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  deploymentId: nonEmpty.optional(),
  configurationVersion: positiveInt.optional(),
  maxSessions: positiveInt,
  activeSessions: nonNegativeInt,
  draining: z.boolean(),
  sessions: z.array(LiveCall),
  role: RunnerRole.optional(),
});

/** Bounds of the `graceMs` query parameter on `DELETE /v1/sessions/{id}`. */
export const MAX_STOP_GRACE_MS = 60_000;

// --- live settings ------------------------------------------------------------------------

/**
 * `PATCH /v1/sessions/{id}` takes a {@link SessionUpdate} (the same body as a client's
 * `curb.update` RPC) and answers with the call's effective settings. Every path in the body
 * must be adjustable for the host, or nothing changes.
 */
export { AdjustablePath, EffectiveSettings, SessionUpdate };

export const SessionUpdateResponse = z.object({
  sessionId: nonEmpty,
  settings: EffectiveSettings,
});

// --- host messages ------------------------------------------------------------------------

const messageId = z.string().min(1).max(128);

/**
 * A message key: any non-empty string up to 256 characters, used verbatim. Dotted names such
 * as `human.requested` remain the convention for a host's own vocabulary.
 */
const messageName = z.string().min(1).max(256);

/** Host to agent. `inReplyTo` names the agent request this answers. Idempotent by `id`. */
export const HostMessage = z.object({
  id: messageId,
  name: messageName,
  payload,
  inReplyTo: messageId.optional(),
});

/** `delivered: false` means this `id` was already delivered to the call. */
export const HostMessageResponse = z.object({
  id: messageId,
  delivered: z.boolean(),
});

// --- after-call hooks ---------------------------------------------------------------------

/** Seconds since the Unix epoch, as every timestamp of a call event is. */
const epochSeconds = nonNegativeInt;

/**
 * The call a call event describes. Every field is always present, null when it has no value.
 * Field names are snake_case, as the webhook body that carries the same object has them.
 *
 * `goals` is null on `call.ended` and an array on `call.evaluated`, empty when the agent
 * declares none. `content: "not_stored"` means `transcript: null` and `call_data: []`.
 * `transcript_truncated` is true when the transcript was too long to send, so null for that
 * reason, not because the call stores nothing.
 */
export const CallRecord = z.object({
  id: nonEmpty,
  object: z.literal("call"),
  agent_id: nonEmpty,
  environment: nonEmpty,
  deployment_id: nonEmpty.nullable(),
  direction: z.enum(["inbound", "outbound"]),
  channel: nonEmpty.nullable(),
  status: z.enum(["completed", "failed"]),
  terminal_reason: nonEmpty.nullable(),
  started_at: epochSeconds.nullable(),
  ended_at: epochSeconds.nullable(),
  duration_seconds: z.number().nonnegative().nullable(),
  client: z.record(z.string(), z.string()),
  experiments: z.record(z.string(), z.string()),
  content: z.enum(["stored", "not_stored"]),
  transcript: z
    .object({
      complete: z.boolean(),
      turns: z.array(z.object({ role: nonEmpty, text: z.string(), created: epochSeconds })),
    })
    .nullable(),
  transcript_truncated: z.boolean(),
  call_data: z.array(z.object({ name: nonEmpty, payload })),
  goals: z
    .array(
      z.object({
        name: nonEmpty,
        status: z.enum(["reached", "not_reached", "not_judged", "not_evaluable"]),
        detail: z.string().nullable(),
      }),
    )
    .nullable(),
  livemode: z.boolean(),
});

/**
 * One moment of a call, in the same JSON a webhook receives. `id` is stable across retries,
 * which is what makes it an idempotency key: a hook runs at least once for an event.
 */
export const CallEvent = z.object({
  id: z.string().regex(/^evt_\S+$/),
  object: z.literal("event"),
  api_version: nonEmpty,
  created: epochSeconds,
  data: z.object({ object: CallRecord }),
  livemode: z.boolean(),
  pending_webhooks: nonNegativeInt,
  request: z.object({ id: z.string().nullable(), idempotency_key: z.string().nullable() }),
  type: z.enum(["call.ended", "call.evaluated"]),
});

/** The largest `deadlineMs`: Node's timers fire at once past this, so it could never hold. */
export const MAX_HOOK_DEADLINE_MS = 2_147_483_647;

/**
 * Runs one hook (`POST /v1/hooks/{name}`). Idempotent by `runId`: a repeat answers the same and
 * never runs the hook twice. `deadlineMs` is relative to the runner's acceptance; past it the
 * run reads `failed` with `error.message` `timeout`.
 */
export const HookRunRequest = z.object({
  runId: messageId,
  event: CallEvent,
  deadlineMs: positiveInt.max(MAX_HOOK_DEADLINE_MS),
});

/** The run is taken, which says nothing of how it ends: read `GET /v1/hooks/runs/{runId}`. */
export const HookRunResponse = z.object({
  runId: messageId,
  accepted: z.literal(true),
});

export const HookRunState = z.enum(["running", "succeeded", "failed"]);

/** `error` is present on a `failed` run: the message alone, never a stack or an environment value. */
export const HookRunStatus = z.object({
  runId: messageId,
  state: HookRunState,
  error: z.object({ message: z.string() }).optional(),
});

// --- the events stream --------------------------------------------------------------------

export const ConversationTurn = z.object({
  type: z.literal("turn"),
  seq: positiveInt,
  at: epochMs,
  speaker: z.enum(["caller", "agent"]),
  text: z.string(),
  final: z.boolean(),
});

/** `kind` is `curb.<name>`. The terminal record is `curb.ended` with `payload.reason`. */
export const ConversationEvent = z.object({
  type: z.literal("event"),
  seq: positiveInt,
  at: epochMs,
  kind: z.string().regex(/^curb\.\S+$/),
  durationMs: z.number().nonnegative().optional(),
  payload,
});

export const ConversationBody = z.discriminatedUnion("type", [ConversationTurn, ConversationEvent]);

/** Agent to host. `seq` comes from the same per-call counter as the conversation. */
export const HostRecordBody = z.object({
  type: z.literal("host"),
  seq: positiveInt,
  at: epochMs,
  id: messageId,
  name: messageName,
  payload,
  expectsReply: z.boolean(),
  inReplyTo: messageId.optional(),
});

export const LifecycleReady = z.object({
  event: z.literal("ready"),
  address: nonEmpty,
  maxSessions: positiveInt,
  warmupMs: nonNegativeInt,
});

export const LifecycleCallStarted = z.object({
  event: z.literal("call-started"),
  session: nonEmpty,
  room: nonEmpty,
});

export const LifecycleCallStopping = z.object({
  event: z.literal("call-stopping"),
  session: nonEmpty,
  reason: z.string(),
});

/** Monotonic clock values: `sinceStartMs` is from the start request to first agent audio. */
export const LifecycleFirstAudio = z.object({
  event: z.literal("first-audio"),
  session: nonEmpty,
  monotonicMs: z.number().int(),
  sinceStartMs: z.number().int(),
});

/** `signal` is present when a process signal, not `POST /v1/runner/drain`, began the drain. */
export const LifecycleDraining = z.object({
  event: z.literal("draining"),
  signal: z.string().optional(),
  active: nonNegativeInt,
});

/** The runner's terminal record. EOF without it means the stream was cut. */
export const LifecycleEnded = z.object({
  event: z.literal("ended"),
  reason: z.string(),
});

export const LifecycleBody = z.discriminatedUnion("event", [
  LifecycleReady,
  LifecycleCallStarted,
  LifecycleCallStopping,
  LifecycleFirstAudio,
  LifecycleDraining,
  LifecycleEnded,
]);

/**
 * One record on the stream. `envelope` is runner-wide and gapless: the resume cursor
 * (`from` is exclusive). `producer` + `seq` identify the record within its producer, for
 * deduplication.
 */
function record<P extends z.ZodType, C extends string, B extends z.ZodType>(
  producer: P,
  recordClass: C,
  body: B,
) {
  return z.object({
    envelope: positiveInt,
    producer,
    seq: positiveInt,
    class: z.literal(recordClass),
    at: epochMs,
    body,
  });
}

/** One call's conversation. `producer` is the session id. */
export const ConversationRecord = record(nonEmpty, "conversation", ConversationBody);

/** What the runner says about itself. */
export const LifecycleRecord = record(z.literal("runner"), "lifecycle", LifecycleBody);

/** A message from the agent to its host. `producer` is the session id. */
export const HostRecord = record(nonEmpty, "host", HostRecordBody);

/** One NDJSON line of `GET /v1/runner/events`. */
export const JournalRecord = z.discriminatedUnion("class", [
  ConversationRecord,
  LifecycleRecord,
  HostRecord,
]);

/** Keepalive on an idle stream. Not a record: no envelope, never advances a cursor. */
export const Ping = z.object({
  ping: epochMs,
});

// --- types --------------------------------------------------------------------------------

export type Health = z.infer<typeof Health>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ErrorBody = z.infer<typeof ErrorBody>;
export type StartCallRequest = z.infer<typeof StartCallRequest>;
/** Who placed a call, as the agent reads it on `call.direction`. */
export type CallDirection = NonNullable<StartCallRequest["direction"]>;
export type StartCallResponse = z.infer<typeof StartCallResponse>;
export type StopCallResponse = z.infer<typeof StopCallResponse>;
export type DrainResponse = z.infer<typeof DrainResponse>;
export type CallState = z.infer<typeof CallState>;
export type LiveCall = z.infer<typeof LiveCall>;
export type SessionList = z.infer<typeof SessionList>;
export type RunnerRole = z.infer<typeof RunnerRole>;
export type RunnerStatus = z.infer<typeof RunnerStatus>;
export type SessionUpdateResponse = z.infer<typeof SessionUpdateResponse>;
export type HostMessage = z.infer<typeof HostMessage>;
export type HostMessageResponse = z.infer<typeof HostMessageResponse>;
export type CallRecord = z.infer<typeof CallRecord>;
export type CallEvent = z.infer<typeof CallEvent>;
export type HookRunRequest = z.infer<typeof HookRunRequest>;
export type HookRunResponse = z.infer<typeof HookRunResponse>;
export type HookRunState = z.infer<typeof HookRunState>;
export type HookRunStatus = z.infer<typeof HookRunStatus>;
export type ConversationBody = z.infer<typeof ConversationBody>;
export type HostRecordBody = z.infer<typeof HostRecordBody>;
export type LifecycleBody = z.infer<typeof LifecycleBody>;
export type JournalRecord = z.infer<typeof JournalRecord>;
export type Ping = z.infer<typeof Ping>;

// --- the bundled JSON Schema --------------------------------------------------------------

/**
 * Every named type, keyed by its `$defs` name. The key is also the `<Type>` in a fixture's
 * file name, so the two cannot drift apart.
 */
export const PROTOCOL_SCHEMAS = {
  Health,
  ErrorCode,
  ErrorBody,
  StartCallRequest,
  StartCallResponse,
  StopCallResponse,
  DrainResponse,
  CallState,
  LiveCall,
  SessionList,
  RunnerRole,
  RunnerStatus,
  AdjustablePath,
  SessionUpdate,
  EffectiveSettings,
  SessionUpdateResponse,
  HostMessage,
  HostMessageResponse,
  CallRecord,
  CallEvent,
  HookRunRequest,
  HookRunResponse,
  HookRunState,
  HookRunStatus,
  ConversationTurn,
  ConversationEvent,
  ConversationBody,
  HostRecordBody,
  LifecycleReady,
  LifecycleCallStarted,
  LifecycleCallStopping,
  LifecycleFirstAudio,
  LifecycleDraining,
  LifecycleEnded,
  LifecycleBody,
  ConversationRecord,
  LifecycleRecord,
  HostRecord,
  JournalRecord,
  Ping,
} as const;

export type ProtocolTypeName = keyof typeof PROTOCOL_SCHEMAS;

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * The whole protocol as one JSON Schema 2020-12 document, every type under `$defs`.
 *
 * Emitted in input mode so no object forbids additional properties: a reader built from
 * this schema must keep accepting what a newer runner adds.
 */
export function protocolJsonSchema(): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    registry.add(schema as z.ZodType, { id });
  }

  const { schemas } = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io: "input",
    uri: (id) => `#/$defs/${id}`,
  });

  const defs: Record<string, unknown> = {};
  for (const id of Object.keys(PROTOCOL_SCHEMAS)) {
    // Each entry comes back as a standalone document. Inside `$defs` its own `$schema` and
    // `$id` would change how the `#/$defs/...` references resolve, so they are dropped.
    const { $schema: _dialect, $id: _id, ...definition } = schemas[id] as Record<string, unknown>;
    defs[id] = definition;
  }
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: `Curb host protocol v${PROTOCOL_VERSION}`,
    $defs: defs,
  };
}

/** The committed file's exact text: two-space indent and a trailing newline. */
export function renderProtocolJsonSchema(): string {
  return `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`;
}
