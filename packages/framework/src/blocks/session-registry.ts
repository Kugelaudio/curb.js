import type { AgentSiteRuntime } from "../runtime.js";
import { handoffSession } from "./handoff/session.js";
import { procedureSession } from "./procedure/session.js";
import { joinBlockSessions, type BlockSession, type OpenBlockSession } from "./session.js";

/**
 * Every block with a part in the conversation (`session.ts`), by its folder. This list is the
 * only place the session learns of them from: `agent-session.ts` names no block. When two
 * blocks have a call due at once, the one listed first makes it.
 */
export const blockSessions: Readonly<Record<string, OpenBlockSession>> = {
  handoff: handoffSession,
  procedure: procedureSession,
};

/** Every block's part in one new conversation on `runtime`, as one. */
export function openBlockSessions(runtime: AgentSiteRuntime): Required<BlockSession> {
  return joinBlockSessions(Object.values(blockSessions).map((open) => open(runtime)));
}
