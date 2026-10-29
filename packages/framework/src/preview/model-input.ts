import type { LlmCallRecord, LlmMessage } from "../llm/types.js";

/**
 * Which recorded model call wrote a reply, and what the framework put into it. The
 * session records each call's input before it starts (`LlmCallRecord.at`) and stamps a
 * reply when it lands, so the reply's call is the last one that started before it; a
 * session runs one call at a time.
 */
export function callForReply(
  trace: readonly LlmCallRecord[],
  replyAt: number | undefined,
): LlmCallRecord | null {
  if (replyAt === undefined) return trace.at(-1) ?? null;
  let found: LlmCallRecord | null = null;
  for (const call of trace) {
    const started = Date.parse(call.at);
    if (Number.isFinite(started) && started <= replyAt) found = call;
  }
  return found;
}

/** The context block the framework appends as a call's last message. */
const CONTEXT_OPEN = "<current_context";

function textOf(message: LlmMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/**
 * The date and time line a call carried: the framework puts it first in the context block
 * at the end of every call (`AgentSession.buildRequest`), in the agent's time zone and
 * language. Null when the call has no such block.
 */
export function dateLineOf(call: LlmCallRecord | null | undefined): string | null {
  if (!call) return null;
  for (let index = call.input.messages.length - 1; index >= 0; index -= 1) {
    const message = call.input.messages[index];
    if (message.role !== "user") continue;
    const text = textOf(message);
    if (!text.startsWith(CONTEXT_OPEN)) continue;
    const line = text.split("\n")[1]?.trim();
    return line && !line.startsWith("</") ? line : null;
  }
  return null;
}
