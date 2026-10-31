import type { AgentDefinition } from "../config.js";
import { HOOK_EVENT_TYPES, HOOK_LIMIT_MS, declaredHook, type CallEvent, type CallRecord, type HookName } from "../hooks.js";
import { invokeHook } from "../hosted/hook-runs.js";
import { CallEvent as CallEventSchema } from "../hosted/protocol.js";

/**
 * Running a hook without a platform: `runHook` for a test, and `buildCallEvent` for the event it
 * needs. Both hold an event to the rules a platform's events follow, so a test cannot pass on one
 * no real call would produce. `curb hook` goes through the same two.
 */

/** Stands in for the `call_event` id, one per type, so a test can pin `event.id`. */
const EVENT_IDS: Readonly<Record<CallEvent["type"], string>> = {
  "call.ended": "evt_00000000000040008000000000000001",
  "call.evaluated": "evt_00000000000040008000000000000002",
};

/** The version the events of a test are written against. */
const API_VERSION = "2026-11-01";

/** Why `event` is one no real call would produce, or null when it is not. */
function eventProblem(event: CallEvent): string | null {
  const parsed = CallEventSchema.safeParse(event);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(event)"}: ${issue.message}`);
    return `not a call event: ${fields.join("; ")}`;
  }
  const call = event.data.object;
  if (event.type === "call.ended" && call.goals !== null) return "goals is null on call.ended: goals are not judged yet";
  if (event.type === "call.evaluated" && call.goals === null) return "goals is an array on call.evaluated, [] for no goals";
  if (call.content === "not_stored" && (call.transcript !== null || call.call_data.length > 0)) {
    return 'content "not_stored" means transcript: null and call_data: []';
  }
  if (call.transcript_truncated && call.transcript !== null) return "transcript_truncated means transcript: null";
  return null;
}

/**
 * A valid event from the fields a test cares about. The rest is a plain completed call, the same
 * every time; `goals`, `transcript` and `call_data` follow `type` and `content` unless given.
 * Throws when the fields describe an event no real call would produce.
 */
export function buildCallEvent(type: CallEvent["type"], call: Partial<CallRecord> = {}): CallEvent {
  const stored = call.content !== "not_stored" && call.transcript_truncated !== true;
  const record: CallRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    object: "call",
    agent_id: "00000000-0000-4000-8000-000000000002",
    environment: "production",
    deployment_id: null,
    direction: "inbound",
    channel: "sip",
    status: "completed",
    terminal_reason: "caller_hangup",
    started_at: 1793366180,
    ended_at: 1793366364,
    duration_seconds: 184,
    client: {},
    experiments: {},
    content: "stored",
    transcript: stored ? { complete: true, turns: [] } : null,
    transcript_truncated: false,
    call_data: [],
    goals: type === "call.ended" ? null : [],
    livemode: false,
    ...call,
  };
  const event: CallEvent = {
    id: EVENT_IDS[type],
    object: "event",
    api_version: API_VERSION,
    created: record.ended_at ?? 1793366405,
    data: { object: record },
    livemode: record.livemode,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
  };
  const problem = eventProblem(event);
  if (problem) throw new Error(`buildCallEvent: ${problem}.`);
  return event;
}

/** Whether a fixture is a whole event, rather than the call one describes. */
function isEvent(value: Partial<CallRecord> | CallEvent): value is CallEvent {
  return value.object === "event";
}

/** The event hook `name` runs on: `call` when it is a whole event, else one built around it. */
export function hookEvent(name: HookName, call: Partial<CallRecord> | CallEvent = {}): CallEvent {
  const type = HOOK_EVENT_TYPES[name];
  if (!isEvent(call)) return buildCallEvent(type, call);
  const problem = call.type !== type ? `${name} receives ${type}, and this event is ${call.type}` : eventProblem(call);
  if (problem) throw new Error(`${name}: ${problem}.`);
  return call;
}

/**
 * Runs one of the agent's hooks, as a hosting platform would: `(call, event)`, within its limit.
 * `call` is the fields a test cares about (see {@link buildCallEvent}) or a whole event. Resolves
 * with the event the hook received, and rejects with what the hook threw.
 *
 *   const event = await runHook(agent, "afterCall", { status: "failed" });
 */
export async function runHook(
  agent: AgentDefinition,
  name: HookName,
  call: Partial<CallRecord> | CallEvent = {},
): Promise<CallEvent> {
  const hook = declaredHook(agent, name);
  const event = hookEvent(name, call);
  const outcome = await invokeHook(hook, event, HOOK_LIMIT_MS);
  if (outcome.state === "failed") throw outcome.cause;
  return event;
}
