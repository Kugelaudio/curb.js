import { agentLanguage } from "../../llm/localized.js";
import type { AgentSiteRuntime } from "../../runtime.js";
import type { ToolResult } from "../../types.js";
import type { BlockSession, OpenBlockSession } from "../session.js";
import { handoffAnnouncement, handoffUnreachedLine } from "./lines.js";
import { FailureStreaks, HANDOFF_BLOCK, type HandoffLimits, type HandoffToolMark } from "./trigger.js";

/**
 * `<Handoff>`'s part in a conversation: it counts what fails (`trigger.ts`) and, once a limit of
 * the rendered `<Handoff>` is reached, has the session call the handoff tool on the caller's
 * behalf. The model is not asked, as it may be what fails. The caller hears a fixed line in the
 * agent's language before the transfer (`lines.ts`), one that claims a fault only when there is
 * one.
 */
export const handoffSession: OpenBlockSession = (runtime): BlockSession => {
  const failures = new FailureStreaks();
  // At most one handoff of its own a turn, whenever the session asks: a second dial to the same
  // number in the same turn would only ring the same person twice.
  let calledThisTurn = false;
  const language = () => agentLanguage(runtime.settings.view());
  return {
    turnStarted() {
      calledThisTurn = false;
    },
    toolRan(name, result) {
      // `<Handoff>`'s own tools count for nothing: neither as a failure nor as a success.
      if (ownTools(runtime).some((tool) => tool.name === name)) return;
      failures.toolRan(name, result);
    },
    turnEnded(failure) {
      // A turn without a reply that already handed off does not count: the handoff was its outcome.
      if (failure === undefined || !calledThisTurn) failures.turnEnded(failure);
    },
    callDue() {
      if (calledThisTurn) return undefined;
      const tool = handoffTool(runtime);
      const due = tool ? failures.due(tool.limits) : undefined;
      if (!tool || due === undefined) return undefined;
      // Whatever led here is handled, so every count starts again.
      calledThisTurn = true;
      failures.reset();
      return {
        name: tool.name,
        input: { ...due, announce: handoffAnnouncement(language(), due.reason) },
        // A person took the call: the agent says nothing more. Nobody did: the model is not
        // answering, so the caller hears the callback offer rather than silence.
        unansweredLine: (result) => (handedOver(result) ? undefined : handoffUnreachedLine(language())),
      };
    },
  };
};

/** The tools the rendered `<Handoff>` marked as its own: the handoff, and the callback request
 * while one is offered. */
function ownTools(runtime: AgentSiteRuntime): Array<{ name: string; mark: HandoffToolMark }> {
  return runtime.markedTools(HANDOFF_BLOCK) as Array<{ name: string; mark: HandoffToolMark }>;
}

/** The handoff tool the session calls on its own, with its limits, when a `<Handoff>` with at
 * least one limit is rendered now. */
function handoffTool(runtime: AgentSiteRuntime): { name: string; limits: HandoffLimits } | undefined {
  for (const { name, mark } of ownTools(runtime)) {
    if (mark.kind !== "handoff") continue;
    const { afterErrors, afterFailedAttempts } = mark;
    if (afterErrors !== null || afterFailedAttempts !== null) return { name, limits: { afterErrors, afterFailedAttempts } };
  }
  return undefined;
}

/** Whether the handoff tool's `result` says a person took the call (`<Handoff>` puts the outcome
 * in its `data`). */
function handedOver(result: ToolResult): boolean {
  const data = result.data;
  return typeof data === "object" && data !== null && (data as { outcome?: unknown }).outcome === "answered";
}
