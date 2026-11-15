import type { AgentToolCallRecord } from "./llm/types.js";
import type { ToolResult } from "./types.js";

/**
 * When the session hands a call to a person on its own (`<Handoff afterFailures>`): after that
 * many of the author's tool calls failed in a row, or that many turns got no reply in a row. A
 * tool call that succeeds ends the tool streak; a turn that ends in a reply ends the turn streak.
 * Framework tools (read_skill, skip_turn, end_call) and `<Handoff>`'s own tools count for
 * neither: the session does not report them here.
 *
 * Pure: the session reports what happened and asks whether a handoff is due.
 */
export class FailureStreaks {
  private tools: Array<{ name: string; message: string }> = [];
  private turns: string[] = [];

  /** One of the author's tools ran with `result`. */
  toolRan(name: string, result: ToolResult): void {
    if (result.ok === false) this.tools.push({ name, message: result.message ?? "" });
    else this.tools = [];
  }

  /** A turn ended: in a reply, or without one, `failure` saying why (the provider failed or timed
   * out, the model answered nothing, or the turn used all its steps). */
  turnEnded(failure?: string): void {
    if (failure === undefined) this.turns = [];
    else this.turns.push(failure);
  }

  /** A handoff ran: whatever led to it is handled, so both streaks start again. */
  reset(): void {
    this.tools = [];
    this.turns = [];
  }

  /** The summary for the person taking over once `afterFailures` is reached; the streak that
   * reached it starts again. Undefined while it is not reached. */
  due(afterFailures: number): string | undefined {
    if (this.tools.length >= afterFailures) {
      const names = [...new Set(this.tools.map((tool) => tool.name))].join(", ");
      const last = this.tools.at(-1)!.message;
      this.tools = [];
      return clip(`${afterFailures} tool calls failed in a row (${names}).${last ? ` The last one said: ${last}` : ""}`);
    }
    if (this.turns.length >= afterFailures) {
      const last = this.turns.at(-1)!;
      this.turns = [];
      return clip(`The agent could not answer ${afterFailures} times in a row (${last}).`);
    }
    return undefined;
  }
}

/** The call of the handoff tool `name` the session makes on its own. */
export function handoffCall(
  id: string,
  name: string,
  summary: string,
  announce: string,
  skillPath: string | undefined,
): AgentToolCallRecord {
  return { id, name, input: { reason: "agent_failure", summary, announce }, ...(skillPath ? { skillPath } : {}) };
}

/** Whether a handoff tool's `result` says a person took the call (`<Handoff>` puts the outcome
 * in its `data`). */
export function handedOver(result: ToolResult): boolean {
  const data = result.data;
  return typeof data === "object" && data !== null && (data as { outcome?: unknown }).outcome === "answered";
}

/** A summary short enough for a call record and a person to read at a glance. */
function clip(text: string): string {
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
