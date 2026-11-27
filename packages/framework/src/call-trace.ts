import type { Context } from "@opentelemetry/api";

import type { AgentInfoStore } from "./info-store.js";
import type { ProcedureChange } from "./blocks/procedure/progress.js";
import type { SkillChange } from "./tool-run.js";

/**
 * What a call's trace takes from the code that runs the call, and where a call's trace is found.
 * The voice host starts one per call (`call-spans.ts`) and attaches it to the runtime of the
 * call ({@link attachCallTrace}), as its transfer audio is, so the session and the transfer read
 * it without being handed it. Nothing here loads OpenTelemetry: outside a voice call there is no
 * trace, and the session and the transfer do nothing with it.
 */

/** A handoff to a person (`<Handoff>`): why, what the person taking over should know, and what
 * became of it. `outcome` is a transfer's outcome, or `closed` outside the hours; `code` a refusal's. */
export type HandoffRecord = { reason: string; summary: string; outcome: string; code?: string };

/** A callback the caller asked for when nobody could take the call (`<Handoff>`). */
export type CallbackRequestRecord = { name: string; phone: string; reason: string; summary: string };

/** One transfer under way, from the request to its end. */
export type TransferTrace = {
  /** What the dial came to: `answered`, `no_answer`, `busy`, `failed`, `refused`, or `declined`
   * after a warm transfer's consultation. Any outcome but `answered` ends the transfer. */
  outcome(outcome: string): void;
};

/**
 * One step of a warm transfer's consultation with the person at the transfer number, as the
 * call's record shows it (`curb.transfer_consult_<kind>`). `durationMs`: for `answered`, how long
 * it rang since `started`; for `ended`, how long the consultation ran since `answered`, absent
 * when nobody answered. What was said (`turn`) goes to the observer only, never onto a span.
 */
export type ConsultTraceEvent =
  | { kind: "started"; transferId: string }
  | { kind: "answered"; transferId: string; durationMs: number }
  | { kind: "turn"; transferId: string; speaker: "agent" | "target"; text: string }
  | { kind: "decision"; transferId: string; decision: string; attempt: 1 | 2 }
  | { kind: "ended"; transferId: string; decision: string; reason: string; durationMs?: number };

export type CallTrace = {
  /** The context a span of this call starts in: the active one when it already belongs to this
   * call's trace (a voice pipeline span that descends from the call), the call's own otherwise.
   * So a tool run keeps its place under the model call that asked for it, and never lands in a
   * trace of its own. */
  context(): Context;
  /** Run `fn` with the call as the active span, so spans others start in it join the trace. */
  run<T>(fn: () => T): T;
  /** The active skill changed: the stay in the one before ends, a stay in the new one starts. */
  skill(change: SkillChange): void;
  procedure(change: ProcedureChange): void;
  /** A transfer to `to`, the number as the request names it, was asked for. `warm`: the person
   * at the number is asked first. */
  transfer(to: string, options?: { warm?: boolean }): TransferTrace;
  /** A step of a warm transfer's consultation. */
  consult(event: ConsultTraceEvent): void;
  /** The transfer target is on the line and the agent stays quiet. */
  transferHandedOff(): void;
  /** The handed-off transfer is over: the agent took the call back, or it ended the call. */
  transferEnded(how: "resumed" | "ended_call"): void;
  /** A handoff was decided: a transfer was tried, or nobody was there. Its summary and the
   * caller's details go to the observer only, never onto a span. */
  handoff(record: HandoffRecord): void;
  /** The caller left a callback request. */
  callbackRequest(record: CallbackRequestRecord): void;
  /** The call could not run as it should, for example its session did not start. Said on the
   * call's span, which still ends with the call. */
  fail(error: unknown): void;
  /** The call is over. Ends every span still open; a second call does nothing. */
  end(): void;
};

/** Who else wants a fact the trace learns, such as the call's own record. */
export type CallTraceObserver = {
  /** A transfer request to `to` got its outcome, `durationMs` after it was asked for. The
   * number goes to the observer only, never onto a span. */
  transfer?(outcome: string, durationMs: number, to: string, options?: { warm?: boolean }): void;
  /** A step of a warm transfer's consultation (`curb.transfer_consult_<kind>` in the call's record). */
  consult?(event: ConsultTraceEvent): void;
  /** A handoff was decided (`curb.handoff` in the call's record). */
  handoff?(record: HandoffRecord): void;
  /** The caller left a callback request (`curb.callback_request` in the call's record). */
  callbackRequest?(record: CallbackRequestRecord): void;
};

/** Keyed by the runtime's info store, whose identity is the runtime's. */
const callTraceByRuntime = new WeakMap<AgentInfoStore, CallTrace>();

/** Attach (or detach, with `null`) a call's trace to the runtime that owns `info`. The voice
 * host calls it when a call starts, after a rewind, and at call end. */
export function attachCallTrace(info: AgentInfoStore, callTrace: CallTrace | null): void {
  if (callTrace) callTraceByRuntime.set(info, callTrace);
  else callTraceByRuntime.delete(info);
}

/** The trace of the call the runtime that owns `info` is on; undefined outside a call. */
export function callTraceOf(info: AgentInfoStore): CallTrace | undefined {
  return callTraceByRuntime.get(info);
}
