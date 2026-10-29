/**
 * The agent's worker: `curb dev`'s agent server child (`cli/dev-child.ts`) in the browser. It
 * compiles the project the page handed it (`project-compile.ts`),
 * installs the result as the agent registry and starts the framework's own agent server
 * (`server/main.ts`) on it, which listens on the worker's virtual HTTP server
 * (`builtins/virtual-http.ts`). The page's supervisor starts a new worker for every reload,
 * so nothing a previous build left in module state reaches the next one.
 *
 * Loaded by `page/worker.js`, which sets the boot globals first: this module's imports run
 * before its own code and read them as they load.
 */

import { agentLoadFailure } from "../agent.node.js";
import { setBundledAgentRegistry, type BundledAgentRegistry } from "../agent-registry.node.js";
import type { ChildMessage } from "../cli/dev-ipc.js";
import { setBundledPublicMarkdown } from "../public-context.js";
import { ensureHostPrerequisites } from "../server/bootstrap.js";
import { createAgentServer, type AgentServer } from "../server/main.js";
import { onVolumeChange } from "./builtins/memory-fs.js";
import { dispatchRequest, dispatchUpgrade } from "./builtins/virtual-http.js";
import { compileProject, contextMarkdown, initializeCompiler, type ProjectFiles } from "./project-compile.js";
import type { DiagnosticsAnswer, FromWorker, ToWorker } from "./worker-protocol.js";

const scope = globalThis as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  __CURB_QUIET__?: boolean;
  __CURB_FILES__?: ProjectFiles;
};
const send = (child: ChildMessage) => scope.postMessage({ child });
onVolumeChange((path, change) => scope.postMessage({ volume: { path, change } }));

/** Everything the agent logs also goes to the page, which keeps the log the coding agent reads. */
function logLine(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
for (const method of ["log", "info", "warn", "error"] as const) {
  const original = console[method].bind(console);
  const level = method === "log" ? "info" : method;
  console[method] = (...values: unknown[]) => {
    original(...values);
    // Colours are for a terminal (`server/log.ts`): the page keeps plain text.
    scope.postMessage({ log: { level, text: values.map(logLine).join(" ").replace(/\u001b\[[0-9;]*m/g, "") } });
  };
}

let server: AgentServer | null = null;
let stopping = false;

scope.onmessage = (event) => {
  const message = event.data;
  if ("supervisor" in message) {
    const order = message.supervisor;
    if (order.type === "waiting") {
      server?.broadcast({ type: "dev_reload", state: "waiting", until: order.until, files: order.files });
    } else if (!stopping) {
      stopping = true;
      void (server?.reload(order.files) ?? Promise.resolve()).finally(() => scope.postMessage({ exited: 0 }));
    }
    return;
  }
  if ("diagnostics" in message) {
    const port = message.diagnostics;
    const answer = (value: DiagnosticsAnswer) => {
      port.postMessage(value);
      port.close();
    };
    // The agents this worker loaded, with the diagnostics computed then (cached by bootstrap).
    ensureHostPrerequisites({ quiet: true }).then(
      (agents) => answer({ diagnostics: JSON.parse(JSON.stringify(agents.flatMap((agent) => agent.diagnostics))) }),
      (error: unknown) => answer({ error: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  if ("connect" in message) {
    const { url, headers, port } = message.connect;
    if (!server || stopping) {
      port.postMessage({ close: { code: 1012, reason: "The agent is reloading." } });
      return port.close();
    }
    return dispatchUpgrade(url, headers, port);
  }
  const { request, reply } = message;
  dispatchRequest(request, (response) => {
    reply.postMessage(response, [response.body]);
    reply.close();
  });
};

async function loadProject(): Promise<void> {
  const files = scope.__CURB_FILES__ ?? {};
  await initializeCompiler("/esbuild/esbuild.wasm");
  const code = await compileProject(files, self.location.origin);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    setBundledAgentRegistry((await import(/* @vite-ignore */ url)) as BundledAgentRegistry);
  } finally {
    URL.revokeObjectURL(url);
  }
  setBundledPublicMarkdown(contextMarkdown(files));
}

try {
  await loadProject();
  server = await createAgentServer({
    dev: {
      publicUrl: self.location.origin,
      onActivity: (counts) => send({ type: "activity", ...counts }),
      quiet: scope.__CURB_QUIET__ ?? false,
    },
  });
  await server.listen();
  send({ type: "ready", port: server.port(), report: server.report() });
} catch (error) {
  console.error(error);
  send({ type: "failed", diagnostic: agentLoadFailure(error, "/") });
}
