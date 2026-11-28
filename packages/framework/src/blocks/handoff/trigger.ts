import { thrownClass } from "../../tool-run.js";
import type { ToolResult } from "../../types.js";

/** Why the session hands a call off on its own: something is not working (`agent_failure`), or
 * the agent keeps getting an answer of no (`agent_stuck`). */
export type OwnHandoff = { reason: "agent_failure" | "agent_stuck"; summary: string };

/** After how many in a row `<Handoff>` hands off on its own; null: never for that one. */
export type HandoffLimits = { afterErrors: number | null; afterFailedAttempts: number | null };

/** The id `<Handoff>` marks its tools with (`ToolMark`). */
export const HANDOFF_BLOCK = "handoff";

/** The names `<Handoff>` gives its tools when its props name none. The callback tool is rendered
 * only once a handoff did not reach anybody, so `curb check` knows it from here. */
export const HANDOFF_TOOL_NAMES = { name: "handoff", callbackName: "request_callback" } as const;

/** How `<Handoff>` marks its tools, so its part in the conversation (`session.ts`) knows them:
 * the handoff itself, with the limits it was rendered with, and the callback request it offers
 * when nobody could take the call. */
export type HandoffToolMark = { block: typeof HANDOFF_BLOCK } & (({ kind: "handoff" } & HandoffLimits) | { kind: "callback" });

type FailedCall = { name: string; message: string };

/**
 * When the session hands a call to a person on its own (`<Handoff>`). Three counts, each of what
 * happened in a row:
 *
 * - errors (`afterErrors`): the author's tool calls whose handler threw, a `ToolUnavailableError`
 *   or anything else but a `ToolInputError`;
 * - turns that got no reply (`afterErrors` too);
 * - failed attempts (`afterFailedAttempts`): tool calls that answered `ok: false` without
 *   throwing, or threw a `ToolInputError`. The tool worked and its answer was no: the slot is
 *   taken, there is no such order.
 *
 * A tool call that succeeds ends both tool counts; a turn that ends in a reply ends the turn
 * count. Framework tools (read_skill, skip_turn, end_call) and `<Handoff>`'s own tools count for
 * none: they are not reported here.
 *
 * Pure: `session.ts` reports what happened and asks whether a handoff is due.
 */
export class FailureStreaks {
  private errors: FailedCall[] = [];
  private attempts: FailedCall[] = [];
  private turns: string[] = [];

  /** One of the author's tools ran with `result`. */
  toolRan(name: string, result: ToolResult): void {
    if (result.ok !== false) {
      this.errors = [];
      this.attempts = [];
      return;
    }
    const call = { name, message: result.message ?? "" };
    // A handler that threw is marked on its result (`markThrown`); a `ToolInputError` is not.
    if (thrownClass(result) !== undefined) this.errors.push(call);
    else this.attempts.push(call);
  }

  /** A turn ended: in a reply, or without one, `failure` saying why (the provider failed or timed
   * out, the model answered nothing, or the turn used all its steps). */
  turnEnded(failure?: string): void {
    if (failure === undefined) this.turns = [];
    else this.turns.push(failure);
  }

  /** A handoff ran: whatever led to it is handled, so every count starts again. */
  reset(): void {
    this.errors = [];
    this.attempts = [];
    this.turns = [];
  }

  /** The reason and the summary for the person taking over once a limit is reached (null: that
   * limit is off); the count that reached it starts again. Undefined while none is reached.
   * Something not working is said before an answer of no. */
  due(limits: HandoffLimits): OwnHandoff | undefined {
    const { afterErrors, afterFailedAttempts } = limits;
    if (afterErrors !== null && this.errors.length >= afterErrors) {
      const summary = `${afterErrors} tool calls failed in a row (${names(this.errors)}).${lastSaid(this.errors)}`;
      this.errors = [];
      return { reason: "agent_failure", summary: clip(summary) };
    }
    if (afterErrors !== null && this.turns.length >= afterErrors) {
      const last = this.turns.at(-1)!;
      this.turns = [];
      return { reason: "agent_failure", summary: clip(`The agent could not answer ${afterErrors} times in a row (${last}).`) };
    }
    if (afterFailedAttempts !== null && this.attempts.length >= afterFailedAttempts) {
      const summary = `${afterFailedAttempts} attempts in a row did not work (${names(this.attempts)}).${lastSaid(this.attempts)}`;
      this.attempts = [];
      return { reason: "agent_stuck", summary: clip(summary) };
    }
    return undefined;
  }
}

const names = (calls: FailedCall[]) => [...new Set(calls.map((call) => call.name))].join(", ");

function lastSaid(calls: FailedCall[]): string {
  const last = calls.at(-1)!.message;
  return last ? ` The last one said: ${last}` : "";
}

/** A summary short enough for a call record and a person to read at a glance. */
function clip(text: string): string {
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
