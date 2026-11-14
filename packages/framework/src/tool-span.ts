import { context, SpanStatusCode, trace } from "@opentelemetry/api";

import { thrownClass, type ToolRunTracer } from "./tool-run.js";

/**
 * Every tool run is an OpenTelemetry span, `execute_tool <name>`, named and attributed after the
 * GenAI semantic conventions. Curb only creates spans: it registers no tracer provider, so with no
 * OpenTelemetry SDK set up in the process a span costs nothing and goes nowhere. A project that
 * starts an SDK (any backend) receives them as children of whatever span is active when the tool
 * runs, and inside a call's trace on a call (`call-spans.ts`). A span never carries the tool's
 * arguments or result: those are the caller's data.
 *
 * The server hands this tracer to the sessions it creates (`server/bootstrap.ts`). The session
 * itself imports no OpenTelemetry, so an agent's module loads without it.
 */

/** The one tracer of every span Curb creates. */
export const tracer = trace.getTracer("curb");

export const traceToolRun: ToolRunTracer = (toolCall, session, run, activeSkill, parent = context.active()) =>
  tracer.startActiveSpan(
    `execute_tool ${toolCall.name}`,
    {
      attributes: {
        ...session,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolCall.name,
        "gen_ai.tool.call.id": toolCall.id,
        "gen_ai.tool.type": "function",
        ...(toolCall.skillPath ? { "curb.skill.path": toolCall.skillPath } : {}),
      },
    },
    parent,
    async (span) => {
      const startedAt = performance.now();
      const before = activeSkill();
      try {
        const outcome = await run();
        // The run that changed the active skill says so on its own span.
        const after = activeSkill();
        if (after !== before) span.setAttribute(after ? "curb.skill.entered" : "curb.skill.exited", after || before);
        const ok = outcome.result.ok !== false;
        span.setAttribute("curb.tool.ok", ok);
        // A failed result is the tool's answer, and the model reads it and carries on. The span
        // still says it failed, so a trace shows which tool did, and whether its handler threw.
        if (!ok) {
          const errorClass = thrownClass(outcome.result);
          if (errorClass) span.addEvent("exception", { "exception.type": errorClass });
          span.setAttribute("error.type", errorClass ?? "tool_error");
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return { outcome, durationMs: Math.round(performance.now() - startedAt) };
      } finally {
        span.end();
      }
    },
  );
