import { callTraceOf } from "../../call-trace.js";
import type { BlockSession, OpenBlockSession } from "../session.js";
import { procedureChanges, proceduresOf, type ProcedureProgress } from "./progress.js";

/**
 * `<Procedure>`'s part in a conversation: it reports what moved in the context's procedures
 * since it last looked (`progress.ts`), as `procedure` events of the turn and, on a call, to the
 * call's trace. A procedure already in the context when the conversation opens starts at the
 * first look.
 */
export const procedureSession: OpenBlockSession = (runtime): BlockSession => {
  let seen: ReadonlyMap<string, ProcedureProgress> = new Map();
  return {
    events() {
      const now = proceduresOf(runtime.snapshot().context.blocks);
      const changes = procedureChanges(seen, now);
      seen = now;
      const callTrace = callTraceOf(runtime.info);
      for (const change of changes) callTrace?.procedure(change);
      return changes.map((change) => ({ type: "procedure" as const, ...change }));
    },
  };
};
