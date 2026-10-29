/**
 * The messages between `curb dev`'s supervisor (`dev.ts`) and the agent server it runs as
 * a child process (`dev-child.ts`), over Node's IPC channel. Types only.
 */
import type { AuthoringDiagnostic } from "../authoring.js";
import type { AgentServerReport } from "../server/main.js";

/** Passed to the child as its one argument, as JSON. */
export type DevChildOptions = {
  projectRoot: string;
  /** The preview's base URL: the MCP OAuth callback lands there. */
  publicUrl: string;
  /** A reload, not the first start: print nothing at boot, the supervisor prints one line. */
  quiet: boolean;
};

/** Child to supervisor. */
export type ChildMessage =
  /** Serving on `port` (127.0.0.1). */
  | { type: "ready"; port: number; report: AgentServerReport }
  /** The agent did not load; the child exits after sending this. */
  | { type: "failed"; diagnostic: AuthoringDiagnostic }
  /** Live calls, running replies and MCP sign-ins in progress, on every change: a reload
   * waits for them (`ServerActivityCounts`). */
  | { type: "activity"; calls: number; turns: number; signIns: number };

/** Supervisor to child. */
export type SupervisorMessage =
  /** A reload is waiting for the call (or the reply) to end: tell every page. */
  | { type: "waiting"; until: "call_ends" | "reply_ends"; files: string[] }
  /** Reloading: tell every page, close their sockets, finish the recordings, exit. */
  | { type: "stop"; files: string[] };
