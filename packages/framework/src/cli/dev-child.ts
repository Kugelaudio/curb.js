/**
 * `curb dev`'s agent server: the child process the supervisor (`dev.ts`) starts, and starts
 * again when the project's files change. Every start is a fresh process, so the project's
 * modules, everything they import and the `.env` are read as they are on disk now, while
 * curb, React and node_modules still load once per process (one React, one curb, so React
 * context holds).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentLoadFailure } from "../agent.node.js";
import { keepHostModelKeyFresh, useHostModelKey } from "./cloud/host-model-key.js";
import type { AgentServer } from "../server/main.js";
import type { ChildMessage, DevChildOptions, SupervisorMessage } from "./dev-ipc.js";
import { surviveLivekitTeardown } from "./livekit-teardown.js";

const options = JSON.parse(process.argv[2] ?? "") as DevChildOptions;

function send(message: ChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

// The supervisor is gone (killed, crashed): an agent server nobody can reach must not
// keep a port and a call open.
process.on("disconnect", () => process.exit(0));
surviveLivekitTeardown();

// The environment came without the project's .env: read it now, as it is on disk. Values
// already in the environment win, as they do for every other command.
const envFile = join(options.projectRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
// A hosted workspace supplies the model key beside its platform token and renews it; this
// server re-reads it, since it may outlive one key (cloud/host-model-key.ts).
useHostModelKey();
keepHostModelKeyFresh();

let server: AgentServer | null = null;
let stopping = false;

process.on("message", (raw) => {
  const message = raw as SupervisorMessage;
  if (message.type === "waiting") {
    server?.broadcast({ type: "dev_reload", state: "waiting", until: message.until, files: message.files });
    return;
  }
  if (message.type === "stop") void stop(message.files);
});

async function stop(files: string[]): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server?.reload(files);
  process.exit(0);
}

try {
  const { createAgentServer } = await import("../server/main.js");
  server = await createAgentServer({
    dev: {
      publicUrl: options.publicUrl,
      onActivity: (counts) => void send({ type: "activity", ...counts }),
      quiet: options.quiet,
    },
  });
  await server.listen();
} catch (error) {
  if (process.env.DEBUG) console.error(error);
  await send({ type: "failed", diagnostic: agentLoadFailure(error, options.projectRoot) });
  process.exit(1);
}
await send({ type: "ready", port: server.port(), report: server.report() });
