import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HOSTED_WORKER_JOB_SOURCE, workerEntrySource } from "./generated-entries.js";

/**
 * The worker-mode job body `curb build` writes into the artifact, run as TEXT against
 * stand-ins: no build, no LiveKit.
 *
 * A built artifact in worker mode serves a dispatched call exactly as `curb start` does,
 * because it runs the same job: `runVoiceWorkerJob` (`server/voice/livekit-host/worker.ts`,
 * tested in `worker.test.tsx`). Hence the agent-first greeting, the call identity, the caller
 * and dispatch info and the conversation recording's end are the same there too. It also
 * registers under the same name (`server/voice/worker-name.ts`).
 */

type JobDeps = {
  defineAgent: (definition: unknown) => unknown;
  runVoiceWorkerJob: (ctx: unknown) => Promise<void>;
};

const jobDir = mkdtempSync(join(tmpdir(), "curb-hosted-worker-job-"));
afterAll(() => rmSync(jobDir, { recursive: true, force: true }));
let jobFiles = 0;

/** Imports the generated job body as the artifact does, as a module of its own: its free
 * names (`defineAgent`, `runVoiceWorkerJob`) are bound from this test's stand-ins. */
async function loadJob(runVoiceWorkerJob: JobDeps["runVoiceWorkerJob"]) {
  expect(HOSTED_WORKER_JOB_SOURCE.startsWith("export default ")).toBe(true);
  const key = `__curbHostedWorkerJobDeps${jobFiles}`;
  (globalThis as Record<string, unknown>)[key] = {
    defineAgent: (definition: unknown) => definition,
    runVoiceWorkerJob,
  } satisfies JobDeps;
  const file = join(jobDir, `job-${jobFiles++}.mjs`);
  writeFileSync(file, `const { defineAgent, runVoiceWorkerJob } = globalThis.${key};\n${HOSTED_WORKER_JOB_SOURCE}`);
  const module = (await import(pathToFileURL(file).href)) as { default: { entry: (ctx: unknown) => Promise<void> } };
  return module.default;
}

describe("the hosted worker job", () => {
  it("hands every dispatched job to curb start's job, unchanged", async () => {
    const runVoiceWorkerJob = vi.fn(async () => undefined);
    const ctx = { room: { name: "room-1" } };

    await (await loadJob(runVoiceWorkerJob)).entry(ctx);
    expect(runVoiceWorkerJob).toHaveBeenCalledExactlyOnceWith(ctx);
  });

  it("fails the job when the call fails to start", async () => {
    const agent = await loadJob(async () => {
      throw new Error("no STT key");
    });
    await expect(agent.entry({})).rejects.toThrow(/no STT key/);
  });

  const frameworkSrc = join("/framework", "src");
  const entry = (projectName?: string) =>
    workerEntrySource({
      contextRegistryPath: "/build/context-registry.mjs",
      registryPath: "/build/agent-registry.mjs",
      frameworkSrc,
      livekitAgentsEntry: "/framework/node_modules/@livekit/agents/dist/index.js",
      ...(projectName === undefined ? {} : { projectName }),
    });

  it("imports the job and the name rule from the framework's worker modules", () => {
    const source = entry("concierge");
    const workerModule = join(frameworkSrc, "server", "voice", "livekit-host", "worker.ts");
    const nameModule = join(frameworkSrc, "server", "voice", "worker-name.ts");
    expect(source).toContain(`import { runVoiceWorkerJob } from ${JSON.stringify(workerModule)};`);
    expect(source).toContain(`import { voiceWorkerAgentName } from ${JSON.stringify(nameModule)};`);
    expect(source.endsWith(HOSTED_WORKER_JOB_SOURCE)).toBe(true);
  });

  it("registers under the package name baked in at build time, as curb start does", () => {
    expect(entry("concierge")).toContain('const agentName = voiceWorkerAgentName(process.env, "concierge");');
    // A project without a name falls back to the rule's own default.
    expect(entry()).toContain('const agentName = voiceWorkerAgentName(process.env, "");');
    // Quoted as data: a name can never become code in the entry.
    expect(entry('a"b')).toContain('voiceWorkerAgentName(process.env, "a\\"b");');
  });
});
