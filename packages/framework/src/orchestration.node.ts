import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./project.node.js";
import { readProjectPackageName, voiceWorkerAgentName } from "./server/voice/worker-name.js";

export type VoiceWorkerConfig = {
  /** The module LiveKit forks a job process for and runs per call: always the framework's. */
  entry: string;
  agentName: string;
};

/** The framework's own worker module (`server/voice/livekit-host/worker.ts`). */
const FRAMEWORK_WORKER_ENTRY = fileURLToPath(
  new URL("./server/voice/livekit-host/worker.ts", import.meta.url),
);

/**
 * What `curb start` registers with LiveKit: the framework's worker, under `CURB_AGENT_NAME`,
 * else the project's package name, else `curb-agent` (the name a built artifact bakes in too).
 *
 * Every route runs the framework's voice session; a project's `src/orchestration/` is never
 * imported (`curb check` warns that it is ignored).
 */
export async function loadVoiceWorkerConfig(
  projectRoot: string = resolveProjectRoot(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<VoiceWorkerConfig> {
  return {
    entry: FRAMEWORK_WORKER_ENTRY,
    agentName: voiceWorkerAgentName(env, readProjectPackageName(projectRoot)),
  };
}
