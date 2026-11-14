import { context, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

import type { CallTrace, CallTraceObserver } from "./call-trace.js";
import { errorClass } from "./tool-run.js";
import { tracer } from "./tool-span.js";

/**
 * One call as one OpenTelemetry span, `invoke_agent <agent>` after the GenAI semantic
 * conventions, from the call's start to its end. Everything that lasts inside the call is a span
 * under it: each stay in a skill, each procedure, each transfer, each tool run (`tool-span.ts`).
 * The call's span starts in the active context, so it is the root of its trace unless the host
 * already runs the call inside a span of its own. Like the tool spans, Curb only creates spans:
 * with no OpenTelemetry SDK in the process they cost nothing.
 */

/**
 * Start a call's trace. `attributes` is read whenever a span starts and once more when the call
 * ends: `gen_ai.agent.name`, and `gen_ai.conversation.id` once the conversation has one. `call`
 * is what only the call's own span says. It is read at the start and again at the end, because
 * a call learns who its caller is after it has started.
 */
export function startCallTrace(
  attributes: () => Attributes,
  call: () => Attributes = () => ({}),
  observer: CallTraceObserver = {},
): CallTrace {
  const named = attributes();
  const agent = named["gen_ai.agent.name"];
  const root = tracer.startSpan(typeof agent === "string" ? `invoke_agent ${agent}` : "invoke_agent", {
    attributes: { ...named, ...call(), "gen_ai.operation.name": "invoke_agent" },
  });
  const rootContext = trace.setSpan(context.active(), root);
  const start = (name: string, own: Attributes) => tracer.startSpan(name, { attributes: { ...attributes(), ...own } }, rootContext);

  let ended = false;
  let skill: { path: string; span: Span } | null = null;
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
      // The stay the call is already in: it opened inside this skill, or a rewind kept it.
      if (change.action === "loaded" && skill?.path === change.path) return;
      skill?.span.end();
      skill =
        change.action === "loaded"
          ? {
              path: change.path,
              span: start(`curb.skill ${change.path}`, { "curb.skill.path": change.path, "curb.skill.title": change.title }),
            }
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
          ...(change.stepTitle ? { "curb.procedure.step_title": change.stepTitle } : {}),
        });
        // The step the caller is on now; past the last one it stays there.
        span.setAttribute("curb.procedure.step", Math.min(change.step + 1, change.steps));
        return;
      }
      endProcedure(change.title, change.action === "completed");
    },

    transfer: (to) => {
      if (ended) return { outcome: () => {} };
      const askedAt = Date.now();
      const observed = (outcome: string) => observer.transfer?.(outcome, Date.now() - askedAt, to);
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
          // Nobody answering is an outcome. A dial that failed is an error.
          if (outcome === "failed") {
            span.setAttribute("error.type", "transfer_failed");
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
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

    fail: (error) => {
      if (ended) return;
      // The class only, as for a tool that threw: a message can name a room or a number, and no
      // span carries either. Whoever failed the call has the message in the log.
      const type = errorClass(error);
      root.addEvent("exception", { "exception.type": type });
      root.setAttribute("error.type", type);
      root.setStatus({ code: SpanStatusCode.ERROR });
    },

    end: () => {
      if (ended) return;
      ended = true;
      skill?.span.end();
      skill = null;
      for (const title of [...procedures.keys()]) endProcedure(title, false);
      endTransfer("call_ended");
      root.setAttributes({ ...attributes(), ...call() });
      root.end();
    },
  };
}

/** How long a process about to exit waits for its exporter to take the spans of the call. */
const FLUSH_TIMEOUT_MS = 3000;

/**
 * Hand the ended spans to their exporter before a process that served one call exits. Curb
 * starts no SDK: when the project registered a tracer provider that can flush, this asks it to,
 * because a batching exporter would otherwise still hold the call's own span at the exit. With
 * no provider it does nothing. Never rejects, and never waits past `timeoutMs`: a backend that
 * cannot be reached must not hold a call's teardown.
 */
export async function flushSpans(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  type Flushable = { getDelegate?: () => Flushable; forceFlush?: () => Promise<void> };
  const registered = trace.getTracerProvider() as Flushable;
  const provider = registered.getDelegate?.() ?? registered;
  if (typeof provider.forceFlush !== "function") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      provider.forceFlush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (error) {
    // KEEP-JUSTIFIED: tracing must never break the end of a call; the exporter's failure is said.
    console.error("[curb] the call's spans could not be flushed:", error);
  } finally {
    clearTimeout(timer);
  }
}
