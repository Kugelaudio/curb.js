/**
 * What a call's record says about a turn Curb ran: its tools, what each one answered, how long
 * each one that ran took, and its failure.
 *
 * Every voice call reports its turns through here, whichever way it runs: the cascaded pipeline's
 * spoken turns (`livekit-host/curb-agent.ts`) and the back-office turns behind a speech-to-speech
 * model (`s2s/back-office.ts`). So a tool call reads the same in a call's record either way.
 */

import { firstUtf8Bytes, MAX_RECORDED_MESSAGE_BYTES, utf8Bytes, type CallReporter } from "../../hosted/call-reporter.js";
import type { AgentTurnStreamEvent } from "../../llm/types.js";
import type { ToolResult } from "../../types.js";
import { logError } from "../log.js";

/**
 * How much of a tool result's `message` a call's record keeps, in bytes of UTF-8, the marker of a
 * cut one included: half of what the record keeps of one message's payload
 * ({@link MAX_RECORDED_MESSAGE_BYTES}).
 */
export const MAX_TOOL_RESULT_MESSAGE_BYTES = MAX_RECORDED_MESSAGE_BYTES / 2;

/** The largest `data` of a tool result a call's record keeps, in bytes of its JSON: a quarter of
 * what it keeps of one message's payload. Larger `data` is left out, never cut. */
export const MAX_TOOL_RESULT_DATA_BYTES = MAX_RECORDED_MESSAGE_BYTES / 4;

/** How a `message` that was cut ends. */
export const TOOL_RESULT_CUT_MARK = "… [truncated]";

/** What a tool event says of the tool's result ({@link reportedToolResult}). */
export type ReportedToolResult = { message?: string; data?: unknown; truncated?: true };

/**
 * A tool's result as a call's record carries it: the `message` the model read, cut to
 * {@link MAX_TOOL_RESULT_MESSAGE_BYTES} and then ending in {@link TOOL_RESULT_CUT_MARK}, and its
 * `data` while that is at most {@link MAX_TOOL_RESULT_DATA_BYTES} of JSON. `truncated` says the
 * message was cut or the data left out. Undefined for a result with neither. One large result
 * therefore adds at most a few KiB to its event.
 */
export function reportedToolResult(result: ToolResult): ReportedToolResult | undefined {
  const kept: ReportedToolResult = {};
  if (typeof result.message === "string" && result.message !== "") {
    if (utf8Bytes(result.message) <= MAX_TOOL_RESULT_MESSAGE_BYTES) kept.message = result.message;
    else {
      const room = MAX_TOOL_RESULT_MESSAGE_BYTES - utf8Bytes(TOOL_RESULT_CUT_MARK);
      kept.message = `${firstUtf8Bytes(result.message, room)}${TOOL_RESULT_CUT_MARK}`;
      kept.truncated = true;
    }
  }
  if (result.data !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(result.data);
    } catch {
      // KEEP-JUSTIFIED: data that is not JSON cannot be on the stream; the record says it was left out.
      kept.truncated = true;
    }
    if (json !== undefined) {
      // The copy is exactly what was measured, whatever the tool does with its object later.
      if (utf8Bytes(json) <= MAX_TOOL_RESULT_DATA_BYTES) kept.data = JSON.parse(json) as unknown;
      else kept.truncated = true;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Report one event of a running turn. Words are reported by whoever knows what was said. */
export function reportTurnEvent(reporter: CallReporter | undefined, event: AgentTurnStreamEvent): void {
  if (event.type === "error") {
    // The caller hears the session's fixed apology; the cause is for us.
    logError("voice", `turn ${event.error.kind}: ${event.error.message}`);
    reporter?.event("error", { kind: event.error.kind, message: event.error.message });
    return;
  }
  if (event.type === "skill") {
    // Which skill the call is in from here on: the time between two of these is the time spent
    // in a skill.
    reporter?.event("skill", { action: event.action, path: event.path, ...(event.title ? { title: event.title } : {}) });
    return;
  }
  if (event.type === "procedure") {
    // Where a caller got to in a procedure, and whether they finished it.
    const { type: _type, ...change } = event;
    reporter?.event("procedure", change);
    return;
  }
  if (event.type !== "tool") return;
  // What the model was answered, bounded: "booked" and "refused: that slot is taken" are
  // different calls, and `ok` alone does not say which. It can hold the caller's data, as the
  // arguments do, so it goes to the record and nowhere else: never to a log.
  const result = reporter && event.result ? reportedToolResult(event.result) : undefined;
  // Every tool, including skip_turn: "the agent chose to say nothing" is a
  // fact worth seeing in a transcript, not an absence to infer.
  reporter?.event("tool", {
    name: event.toolCall.name,
    arguments: event.toolCall.input,
    ok: event.ok,
    // The skill that owned the tool, when one did. This is what lets a reader
    // say "the agent entered Billing, then looked the invoice up" rather than
    // showing a tool call with no idea where it came from.
    ...(event.toolCall.skillPath ? { skillPath: event.toolCall.skillPath } : {}),
    // Held for the caller's yes (`<Tool confirm>`): `ok` is false because it did not
    // run, not because it failed. The read-back says what the caller was asked.
    ...(event.toolCall.heldFor ? { heldFor: event.toolCall.heldFor } : {}),
    ...(result ? { result } : {}),
  }, event.durationMs);
}
