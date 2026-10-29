import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAgent } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { loadVoiceWorkerConfig } from "./orchestration.node.js";

/**
 * What `curb start` registers with LiveKit. The voice session is the framework's on every
 * route, so the worker module is too: a project's `src/orchestration/` is never imported,
 * not even to read a name from it.
 */

const FRAMEWORK_WORKER = fileURLToPath(new URL("./server/voice/livekit-host/worker.ts", import.meta.url));

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "curb-worker-config-"));
  for (const [path, source] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}

/** A leftover project worker that would fail `curb start` if anything imported it. */
const LEFTOVER_ORCHESTRATION = {
  "src/orchestration/worker.js": "throw new Error('the project worker was imported');\n",
  "src/orchestration/session.js": "throw new Error('the project session was imported');\n",
};

describe("curb start's worker", () => {
  it("is the framework's worker, whatever the project has in src/orchestration", async () => {
    const root = project({
      ...LEFTOVER_ORCHESTRATION,
      "package.json": JSON.stringify({ name: "concierge" }),
    });
    await expect(loadVoiceWorkerConfig(root, {})).resolves.toEqual({
      entry: FRAMEWORK_WORKER,
      agentName: "concierge",
    });
  });

  it("is a module LiveKit can fork a job process for", async () => {
    const { entry } = await loadVoiceWorkerConfig(project(), {});
    const module = (await import(pathToFileURL(entry).href)) as { default: unknown };
    expect(isAgent(module.default)).toBe(true);
  });

  it("registers under CURB_AGENT_NAME, else the package name, else curb-agent", async () => {
    const named = project({ "package.json": JSON.stringify({ name: "concierge" }) });
    expect((await loadVoiceWorkerConfig(named, { CURB_AGENT_NAME: " front-desk " })).agentName).toBe(
      "front-desk",
    );
    expect((await loadVoiceWorkerConfig(named, { CURB_AGENT_NAME: "  " })).agentName).toBe("concierge");
    expect((await loadVoiceWorkerConfig(project(), {})).agentName).toBe("curb-agent");
    const unnamed = project({ "package.json": JSON.stringify({ private: true }) });
    expect((await loadVoiceWorkerConfig(unnamed, {})).agentName).toBe("curb-agent");
  });

  it("names the package.json it cannot read rather than registering under a guess", async () => {
    const root = project({ "package.json": "{ not json" });
    await expect(loadVoiceWorkerConfig(root, {})).rejects.toThrow(/package\.json is not valid JSON/);
  });
});
