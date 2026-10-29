/**
 * Messages between the dev page and the agent's worker. The worker is `curb dev`'s agent
 * server child (`cli/dev-child.ts`) in the browser: it speaks the same supervisor protocol
 * (`cli/dev-ipc.ts`), wrapped here, plus the page's forwarded requests and WebSockets, which
 * cross on ports of their own (`call-port.ts`).
 */

import type { AuthoringDiagnostic } from "../authoring.js";
import type { ChildMessage, SupervisorMessage } from "../cli/dev-ipc.js";
import type { ForwardedRequest } from "./builtins/virtual-http.js";

/** Read by `worker.js` before the runtime loads (the runtime reads them as its modules load). */
export type WorkerBoot = {
  env: Record<string, string>;
  /** The project as the page keeps it, path -> text (`node_modules/` included). */
  files: Record<string, string>;
  /** The files the previous workers wrote (`builtins/memory-fs.ts`). */
  volume: Record<string, string>;
  /** The port this worker's server reports: the page's name for it. */
  port: number;
  quiet: boolean;
};

/** Page -> worker. */
export type ToWorker =
  | { supervisor: SupervisorMessage }
  /** A WebSocket the preview opened to the agent. */
  | { connect: { url: string; headers: Record<string, string>; port: MessagePort } }
  /** An HTTP request on one of the agent's paths; the answer goes to `reply`. */
  | { request: ForwardedRequest; reply: MessagePort }
  /** The loaded agent's authoring diagnostics (`curb check`'s), answered on `diagnostics`. */
  | { diagnostics: MessagePort };

/** The answer on a `diagnostics` port. */
export type DiagnosticsAnswer = { diagnostics: AuthoringDiagnostic[] } | { error: string };

/** Worker -> page. */
export type FromWorker =
  | { child: ChildMessage }
  /** It stopped for a reload (`stop`) and may be terminated. */
  | { exited: number }
  /** A file it wrote changed, for the page to keep. */
  | { volume: { path: string; change: { append: string } | { text: string } } }
  /** A line the agent logged (its console), for the page's log. */
  | { log: { level: "info" | "warn" | "error"; text: string } };
