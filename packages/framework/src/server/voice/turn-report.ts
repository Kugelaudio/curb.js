/**
 * What a call's record says about a turn Curb ran: its tools, how long each one that ran took, and
 * its failure.
 *
 * Every voice call reports its turns through here, whichever way it runs: the cascaded pipeline's
 * spoken turns (`livekit-host/curb-agent.ts`) and the back-office turns behind a speech-to-speech
 * model (`s2s/back-office.ts`). So a tool call reads the same in a call's record either way.
 */

import type { CallReporter } from "../../hosted/call-reporter.js";
import type { AgentTurnStreamEvent } from "../../llm/types.js";
import { logError } from "../log.js";

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
  }, event.durationMs);
}
