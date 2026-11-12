import { SpanStatusCode, trace } from "@opentelemetry/api";

import type { AgentToolCallRecord } from "./llm/types.js";
import type { ToolCallOutcome } from "./types.js";

/**
 * Every tool run is an OpenTelemetry span, `execute_tool <name>`, named and attributed after the
 * GenAI semantic conventions. Curb only creates spans: it registers no tracer provider, so with no
 * OpenTelemetry SDK set up in the process a span costs nothing and goes nowhere. A project that
 * starts an SDK (any backend) receives them, nested under the voice pipeline's own `llm_node` span
 * when the call runs on LiveKit agents. A span never carries the tool's arguments or result: those
 * are the caller's data.
 */

const tracer = trace.getTracer("curb");

/** A tool run, and how long its handler took in whole milliseconds, as every timed record of a call. */
export type TimedOutcome = { outcome: ToolCallOutcome; durationMs: number };

export async function traceToolRun(toolCall: AgentToolCallRecord, run: () => Promise<ToolCallOutcome>): Promise<TimedOutcome> {
  return tracer.startActiveSpan(
    `execute_tool ${toolCall.name}`,
    {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolCall.name,
        "gen_ai.tool.call.id": toolCall.id,
        "gen_ai.tool.type": "function",
        ...(toolCall.skillPath ? { "curb.skill.path": toolCall.skillPath } : {}),
      },
    },
    async (span) => {
      const startedAt = performance.now();
      try {
        const outcome = await run();
        const ok = outcome.result.ok !== false;
        span.setAttribute("curb.tool.ok", ok);
        // A failed result is the tool's answer, not a crash: the model reads it and carries on.
        // The span still says it failed, so a trace shows which tool did.
        if (!ok) {
          span.setAttribute("error.type", "tool_error");
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return { outcome, durationMs: Math.round(performance.now() - startedAt) };
      } finally {
        span.end();
      }
    },
  );
}
