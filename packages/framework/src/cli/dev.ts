import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { formatAuthoringDiagnostic } from "../authoring.js";
import { isAgentHttpPath } from "../server/agent-http-paths.js";
import { printBootBanner } from "../server/banner.js";
import { VITE_HMR_PATH } from "../server/hmr-path.js";
import { listenPlan, listenWithPortWalk } from "../server/listen.js";
import { logError, logInfo } from "../server/log.js";
import { livekitCredentials, realtimeSessionUrl } from "../server/voice/livekit-host/rooms.js";
import type { ChildMessage, DevChildOptions } from "./dev-ipc.js";
import { AgentForwarder } from "./dev-proxy.js";
import { AgentServerSupervisor, type AgentProcess } from "./dev-supervisor.js";
import { watchProject } from "./dev-watch.js";
import { openBrowser } from "./open-browser.js";
import { notifyIfUpdateAvailable } from "./upgrade.js";

/**
 * `curb dev`: the preview on one port, and the agent server behind it in a child process
 * that is started again whenever the project's agent changes on disk (`src/`, the markdown
 * in `context/`, `.env`). This process owns what must outlive a reload: the port, Vite and
 * the page's HMR socket, the watcher and the terminal. Calls are the agent server's own: on
 * the page's socket, or on the LiveKit the .env names (`server/voice/livekit-host/rooms.ts`).
 *
 * `baseEnv`: the environment before the project's .env was loaded. Each agent server loads
 * the .env itself, so a changed key applies on save.
 */
export async function runDev(options: { projectRoot: string; baseEnv: NodeJS.ProcessEnv; open: boolean }): Promise<void> {
  const { projectRoot, baseEnv } = options;
  // A realtime session replaces every LiveKit key, and a LiveKit needs all three of its
  // variables: a misconfiguration is refused before anything starts, not at the first call.
  // Each call checks the .env as it is then again.
  const env = projectEnv(projectRoot, baseEnv);
  if (!realtimeSessionUrl(env)) livekitCredentials(env);
  const forwarder = new AgentForwarder();
  // ONE port: the agent's paths and sockets go to the agent server, everything else is the
  // preview app (Vite in middleware mode, its HMR socket on its own path of this server).
  let preview: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const httpServer = createServer((req, res) => {
    if (isAgentHttpPath(new URL(req.url ?? "/", "http://localhost").pathname)) {
      forwarder.request(req, res);
      return;
    }
    if (preview) {
      preview(req, res);
      return;
    }
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("The preview is starting.");
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname === VITE_HMR_PATH) return; // Vite's own listener
    forwarder.upgrade(request, socket, head);
  });
  const { createServer: createViteServer } = await import("vite");
  const { createPreviewConfig } = await import("../vite/preview-config.js");
  const vite = await createViteServer(createPreviewConfig({ projectRoot, attachTo: httpServer }));
  preview = vite.middlewares;

  const plan = listenPlan();
  const port = await listenWithPortWalk(httpServer, plan);
  const url = `http://${plan.host}:${port}`;

  const supervisor = new AgentServerSupervisor({
    spawn: ({ quiet }) =>
      spawnAgentServer({ projectRoot, publicUrl: url, quiet }, { ...baseEnv, AGENT_PROJECT_DIR: projectRoot }),
    target: (target, files) => forwarder.setTarget(target, files),
    firstStart: (outcome) => {
      if ("report" in outcome) {
        printBootBanner({ url, preview: true, banner: outcome.report.banner });
      } else {
        for (const diagnostic of outcome.failure.diagnostics) console.error(formatAuthoringDiagnostic(diagnostic));
        printBootBanner({ url, preview: true, banner: { failed: `${outcome.failure.message} The preview shows where; save a fix to reload.` } });
      }
      // Land the human in the preview.
      if (options.open) openBrowser(url);
      notifyIfUpdateAvailable(projectRoot);
    },
    log: (level, message) => (level === "error" ? logError("dev", message) : logInfo("dev", message)),
  });
  const watcher = watchProject(projectRoot, (paths) => supervisor.filesChanged(paths), {
    onError: (message) => logError("dev", message),
  });
  supervisor.start();

  process.once("exit", () => {
    watcher.close();
    supervisor.close();
  });
  // A signal ends the process without "exit" unless it is handled.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));
  }
}

/** The agent server, in a child process that loads TypeScript the way this one does. */
function spawnAgentServer(options: DevChildOptions, env: NodeJS.ProcessEnv): AgentProcess {
  const child = fork(fileURLToPath(new URL("./dev-child.ts", import.meta.url)), [JSON.stringify(options)], {
    env,
    // The bin shim registers tsx in-process; the child gets it as a loader. An inspector
    // flag would make the child fight this process for the inspector's port.
    execArgv: [...process.execArgv.filter((flag) => !flag.startsWith("--inspect")), "--import", import.meta.resolve("tsx")],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return agentProcess(child);
}

function agentProcess(child: ChildProcess): AgentProcess {
  return {
    send: (message) => {
      // A child that is exiting has closed its channel; it is being replaced anyway.
      if (child.connected) child.send(message);
    },
    kill: (signal = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    onMessage: (listener) => {
      child.on("message", (message) => listener(message as ChildMessage));
    },
    onExit: (listener) => {
      let reported = false;
      const report = (code: number | null) => {
        if (reported) return;
        reported = true;
        listener(code);
      };
      child.once("exit", (code) => report(code));
      // "error": the process could not be started at all (then no "exit" follows), or a
      // message could not be sent because it was already going away.
      child.on("error", (error) => {
        logError("dev", `the agent server process: ${error.message}`);
        if (child.pid === undefined) report(null);
      });
    },
  };
}

/** The environment the agent server sees: the project's .env under the real environment. */
function projectEnv(projectRoot: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const envFile = join(projectRoot, ".env");
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  return { ...fromFile, ...baseEnv };
}
