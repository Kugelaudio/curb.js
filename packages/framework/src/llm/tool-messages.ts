import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME } from "../types.js";
import type { ToolCallOutcome, ToolResult } from "../types.js";
import type { AgentToolCallRecord, AgentToolMessage } from "./types.js";

/** The transcript entry of a tool call's result. */
export function toolMessage(toolCall: AgentToolCallRecord, { result, contextDiff }: ToolCallOutcome): AgentToolMessage {
  return {
    role: "tool",
    at: Date.now(),
    content: formatToolMessage(toolCall.name, result),
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    contextDiff,
  };
}

/** The UI summary of a tool call ("Show tool activity"). The model reads
 * {@link toolResultPayload} instead. */
export function formatToolMessage(name: string, result: ToolResult): string {
  if (name === "read_skill") {
    if (result.ok) {
      return "Skill read.";
    }

    return `read_skill failed: ${result.message ?? "Unknown error."}`;
  }

  if (name === SKIP_TURN_TOOL_NAME) {
    return "Turn ended silently — no reply was sent.";
  }

  // A refused end_call (no goodbye, or a step that asks the caller) shows like any refusal.
  if (name === END_CALL_TOOL_NAME && result.ok) {
    return "The call ends once the goodbye has played.";
  }

  return `${name}: ${JSON.stringify(result)}`;
}

/** Tool results live in the transcript forever, so long context lines (e.g. a
 * whole unlocked document) are capped here. The full text is always available
 * in the trailing state snapshot; only deep history loses detail. */
const MAX_DIFF_LINE_LENGTH = 200;

/** Builds the JSON value for a native tool_result block: the tool's return
 * value plus the context diff the call caused, with a note on where a read
 * skill went. A result states facts; how and when to speak is the prompt's
 * business ("continue the conversation" here invited words in a step that may
 * still need the skill's own tools, and such words are never spoken). */
export function toolResultPayload(message: AgentToolMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...message.result };
  if (message.toolName === "read_skill" && message.result.ok) {
    payload.note =
      "Skill read: its instructions and tools are now in your current context (the last message). Skills are internal; the user never sees them.";
  }
  if (message.contextDiff.length > 0) {
    payload.contextChanged = message.contextDiff.map(capDiffLine);
  }
  return payload;
}

function capDiffLine(line: string): string {
  if (line.length <= MAX_DIFF_LINE_LENGTH) return line;
  return `${line.slice(0, MAX_DIFF_LINE_LENGTH)}… [truncated — full text in current context]`;
}
