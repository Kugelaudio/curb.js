import { context, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";

import type { AgentInfoStore } from "./info-store.js";
import type { ProcedureChange } from "./procedure-progress.js";
import type { SkillChange } from "./tool-span.js";

/**
 * One call as one OpenTelemetry trace. The call is the root span, `invoke_agent <agent>` after
 * the GenAI semantic conventions, and everything that lasts inside it is a span under it: each
 * stay in a skill, each procedure, each transfer, each tool run (`tool-span.ts`). Like there,
 * Curb only creates spans: with no OpenTelemetry SDK in the process they cost nothing.
 *
 * A call's trace is attached to the runtime of the call ({@link attachCallTrace}), as its
 * transfer audio is, so the session and the transfer read it without being handed it.
 */

const tracer = trace.getTracer("curb");

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
  /** A transfer was asked for. */
  transfer(): TransferTrace;
  /** The transfer target is on the line and the agent stays quiet. */
  transferHandedOff(): void;
  /** The handed-off transfer is over: the agent took the call back, or it ended the call. */
  transferEnded(how: "resumed" | "ended_call"): void;
  /** The call is over. Ends every span still open; a second call does nothing. */
  end(): void;
};

/** Who else wants a fact the trace learns, such as the call's own record. */
export type CallTraceObserver = {
  /** A transfer request got its outcome, `durationMs` after it was asked for. */
  transfer?(outcome: string, durationMs: number): void;
};

/**
 * Start a call's trace. `attributes` is read whenever a span starts and once more when the call
 * ends: `gen_ai.agent.name`, and `gen_ai.conversation.id` once the conversation has one.
 */
export function startCallTrace(
  attributes: () => Attributes,
  call: Attributes = {},
  observer: CallTraceObserver = {},
): CallTrace {
  const named = attributes();
  const agent = named["gen_ai.agent.name"];
  const root = tracer.startSpan(typeof agent === "string" ? `invoke_agent ${agent}` : "invoke_agent", {
    attributes: { ...named, ...call, "gen_ai.operation.name": "invoke_agent" },
  });
  const rootContext = trace.setSpan(context.active(), root);
  const start = (name: string, own: Attributes) => tracer.startSpan(name, { attributes: { ...attributes(), ...own } }, rootContext);

  let ended = false;
  let skill: Span | null = null;
  let transfer: Span | null = null;
  const procedures = new Map<string, Span>();

  const endProcedure = (title: string, completed: boolean) => {
    const span = procedures.get(title);
    if (!span) return;
    span.setAttribute("curb.procedure.completed", completed);
    span.end();
    procedures.delete(title);
  };
  const endTransfer = (how: string) => {
    if (!transfer) return;
    transfer.setAttribute("curb.transfer.ended", how);
    transfer.end();
    transfer = null;
  };

  return {
    context: () => {
      const active = trace.getSpan(context.active());
      return active?.spanContext().traceId === root.spanContext().traceId ? context.active() : rootContext;
    },
    run: (fn) => context.with(rootContext, fn),

    skill: (change) => {
      if (ended) return;
      skill?.end();
      skill =
        change.action === "loaded"
          ? start(`curb.skill ${change.path}`, { "curb.skill.path": change.path, "curb.skill.title": change.title })
          : null;
    },

    procedure: (change) => {
      if (ended) return;
      if (change.action === "started") {
        if (procedures.has(change.title)) return;
        procedures.set(
          change.title,
          start(`curb.procedure ${change.title}`, {
            "curb.procedure.title": change.title,
            "curb.procedure.steps": change.steps,
            "curb.procedure.step": change.step,
          }),
        );
        return;
      }
      const span = procedures.get(change.title);
      if (!span) return;
      if (change.action === "step_completed") {
        span.addEvent("step_completed", {
          "curb.procedure.step": change.step,
          ...(change.stepTitle ? { "curb.procedure.step.title": change.stepTitle } : {}),
        });
        // The step the caller is on now; past the last one it stays there.
        span.setAttribute("curb.procedure.step", Math.min(change.step + 1, change.steps));
        return;
      }
      endProcedure(change.title, change.action === "completed");
    },

    transfer: () => {
      if (ended) return { outcome: () => {} };
      const askedAt = Date.now();
      const observed = (outcome: string) => observer.transfer?.(outcome, Date.now() - askedAt);
      if (transfer) {
        // A request while a transfer is under way is refused by its host: an event on that one.
        const open = transfer;
        return {
          outcome: (outcome) => {
            observed(outcome);
            if (transfer === open) open.addEvent("transfer_requested_again", { "curb.transfer.outcome": outcome });
          },
        };
      }
      const span = start("curb.transfer", {});
      transfer = span;
      return {
        outcome: (outcome) => {
          observed(outcome);
          if (transfer !== span) return;
          span.setAttribute("curb.transfer.outcome", outcome);
          if (outcome !== "answered") {
            span.end();
            transfer = null;
          }
        },
      };
    },
    transferHandedOff: () => {
      // The target can be on the line before the dial's own result arrives.
      transfer?.setAttribute("curb.transfer.outcome", "answered");
      transfer?.addEvent("handed_off");
    },
    transferEnded: endTransfer,

    end: () => {
      if (ended) return;
      ended = true;
      skill?.end();
      skill = null;
      for (const title of [...procedures.keys()]) endProcedure(title, false);
      endTransfer("call_ended");
      root.setAttributes(attributes());
      root.end();
    },
  };
}

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
