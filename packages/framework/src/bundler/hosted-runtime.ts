/**
 * What the entry `curb build` generates imports from the framework (`generated-entries.ts`,
 * `context-registry.ts`), gathered in one module so the generated files name one framework
 * file in either form it runs in (`layout.ts`): `src/bundler/hosted-runtime.ts` or
 * `dist/hosted-runtime.js`.
 */
export { defineAgent } from "../orchestration.js";
export { setBundledAgentRegistry } from "../agent-registry.node.js";
export { setBundledPublicMarkdown } from "../public-context.js";
export { runVoiceWorkerJob } from "../server/voice/livekit-host/worker.js";
export { voiceWorkerAgentName } from "../server/voice/worker-name.js";
export { setBundledSynchronizerModule } from "../server/voice/local-host/synchronizer.js";
export { runHostedRenderCheck } from "./render-check.js";
export { readDirectJoinConfig, runHostedDirectJoin } from "./direct-join.js";
export { readManagedConfig, runManaged } from "./managed-runner.js";
