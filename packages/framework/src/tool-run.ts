import type { Attributes, Context } from "@opentelemetry/api";

import type { AgentToolCallRecord } from "./llm/types.js";
import type { ToolCallOutcome, ToolResult } from "./types.js";

/**
 * A tool run as the session sees it: who traces it, how long it took, what it left behind.
 * Nothing here loads OpenTelemetry. A session times its tool runs itself ({@link timeToolRun});
 * the server's sessions are handed a tracer that also makes each run a span (`tool-span.ts`).
 */

/** What every span of a session carries: `gen_ai.agent.name`, and `gen_ai.conversation.id` once
 * the conversation has one, so a backend can group a call's spans and tell agents apart. */
export type SpanAttributes = Attributes;

/** A tool run, and how long its handler took in whole milliseconds, as every timed record of a call. */
export type TimedOutcome = { outcome: ToolCallOutcome; durationMs: number };

/** The active skill changed: `loaded` names the one now active, `exited` the one left for the
 * agent level. */
export type SkillChange = { action: "loaded" | "exited"; path: string; title: string };

/**
 * Runs one tool call and times it. `session` is what the session's spans carry, `activeSkill`
 * the path of the active skill (none is the agent level), and `parent` the context a span of
 * this run starts in when it is not the active one.
 */
export type ToolRunTracer = (
  toolCall: AgentToolCallRecord,
  session: SpanAttributes,
  run: () => Promise<ToolCallOutcome>,
  activeSkill: () => string,
  parent?: Context,
) => Promise<TimedOutcome>;

/** A tool run timed and not traced: what a session does when it was handed no tracer. */
export const timeToolRun: ToolRunTracer = async (_toolCall, _session, run) => {
  const startedAt = performance.now();
  const outcome = await run();
  return { outcome, durationMs: Math.round(performance.now() - startedAt) };
};

/** The failed results that stand for a handler that threw, with the error's class. */
const thrown = new WeakMap<ToolResult, string>();

/**
 * `result` is what the model reads in place of `error`, which a tool's handler threw. The tool's
 * span then names the error's class, so a crash can be told from an answer of `ok: false`. The
 * class only: an error's message can quote the caller, and stays in the log.
 */
export function markThrown(result: ToolResult, error: unknown): void {
  thrown.set(result, errorClass(error));
}

/** What a span's `error.type` says of something thrown: an error's class, and `_OTHER` for a
 * value that is no error, as the OpenTelemetry conventions name it. */
export function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "_OTHER";
}

/** The class of the error `result` stands for, when a handler threw it. */
export function thrownClass(result: ToolResult): string | undefined {
  return thrown.get(result);
}
