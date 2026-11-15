import type { AgentTurnStreamEvent } from "../llm/types.js";
import type { AgentSiteRuntime } from "../runtime.js";
import type { ToolResult } from "../types.js";

/**
 * A block's part in a conversation: what the block keeps track of while the conversation runs,
 * and what it does in it on its own. `<Handoff>` counts what fails and hands the call to a
 * person; `<Procedure>` reports each step the conversation completed.
 *
 * The session (`agent-session.ts`) knows no block. For each conversation it opens every part
 * listed in `session-registry.ts`, tells them all what happens, and makes the tool call one of
 * them asks for. A block that needs this has a `session.ts` in its folder, which exports the
 * function that opens its part ({@link OpenBlockSession}), and one line in the registry.
 *
 * A part is opened for every conversation, whether the agent renders the block or not, and
 * before anything is rendered: it reads `runtime` when it is told something, never when it is
 * opened. Every method is optional.
 */
export interface BlockSession {
  /** A turn started. */
  turnStarted?(): void;
  /** A tool ran with `result`. The framework's own tools (read_skill, skip_turn, end_call) are
   * not reported, and neither is a call the session made for a block ({@link callDue}). */
  toolRan?(name: string, result: ToolResult): void;
  /** A turn ended: in a reply, or without one, `failure` saying why (the provider failed or
   * timed out, the model answered nothing, or the turn used all its steps). A cancelled turn is
   * not reported. */
  turnEnded?(failure?: string): void;
  /** The tool call the block makes now on the caller's behalf, without asking the model. Asked
   * after the tools of a step ran and after a turn that got no reply; a call that is returned is
   * made, so the part counts it as made. */
  callDue?(): BlockCall | undefined;
  /** What happened in the block since it was last asked, as events of the turn for whoever
   * follows it (the preview, a host). Asked at the start of a turn and after every tool run,
   * the moments the context can have changed. */
  events?(): AgentTurnStreamEvent[];
}

/** A tool call the session makes for a block, recorded as a call of its own. */
export type BlockCall = {
  /** The tool, by the name it is rendered with (`runtime.markedTools`). */
  name: string;
  input: Record<string, unknown>;
  /** What the caller hears after the call on a turn the model did not answer, from the call's
   * `result`: a fixed line in the agent's language, or nothing. It takes the place of the
   * apology such a turn ends in. */
  unansweredLine?(result: ToolResult): string | undefined;
};

/** Opens a block's part in one conversation on `runtime`. */
export type OpenBlockSession = (runtime: AgentSiteRuntime) => BlockSession;

/** Several parts as one: each is told everything, the first with a call due makes it, and their
 * events follow each other in the order of the parts. */
export function joinBlockSessions(parts: readonly BlockSession[]): Required<BlockSession> {
  return {
    turnStarted: () => {
      for (const part of parts) part.turnStarted?.();
    },
    toolRan: (name, result) => {
      for (const part of parts) part.toolRan?.(name, result);
    },
    turnEnded: (failure) => {
      for (const part of parts) part.turnEnded?.(failure);
    },
    callDue: () => {
      for (const part of parts) {
        const call = part.callDue?.();
        if (call) return call;
      }
      return undefined;
    },
    events: () => parts.flatMap((part) => part.events?.() ?? []),
  };
}
