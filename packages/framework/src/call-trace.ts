import type { Context } from "@opentelemetry/api";

import type { AgentInfoStore } from "./info-store.js";
import type { ProcedureChange } from "./procedure-progress.js";
import type { SkillChange } from "./tool-run.js";

/**
 * What a call's trace takes from the code that runs the call, and where a call's trace is found.
 * The voice host starts one per call (`call-spans.ts`) and attaches it to the runtime of the
 * call ({@link attachCallTrace}), as its transfer audio is, so the session and the transfer read
 * it without being handed it. Nothing here loads OpenTelemetry: outside a voice call there is no
 * trace, and the session and the transfer do nothing with it.
 */

/** One transfer under way, from the request to its end. */
export type TransferTrace = {
  /** What the dial came to: `answered`, `no_answer`, `busy`, `failed`, `refused`. Any outcome
   * but `answered` ends the transfer. */
  outcome(outcome: string): void;
};

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
  /** A transfer to `to`, the number as the request names it, was asked for. */
  transfer(to: string): TransferTrace;
  /** The transfer target is on the line and the agent stays quiet. */
  transferHandedOff(): void;
  /** The handed-off transfer is over: the agent took the call back, or it ended the call. */
  transferEnded(how: "resumed" | "ended_call"): void;
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
  transfer?(outcome: string, durationMs: number, to: string): void;
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
