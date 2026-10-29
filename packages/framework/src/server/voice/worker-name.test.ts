import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProjectPackageName, voiceWorkerAgentName } from "./worker-name.js";

/**
 * The name a voice worker registers under. `curb start` and a built artifact apply the same
 * rule to the same package name, so dispatch finds the worker however the project runs.
 */

function project(packageJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), "curb-worker-name-"));
  if (packageJson !== undefined) writeFileSync(join(root, "package.json"), packageJson);
  return root;
}

describe("voiceWorkerAgentName", () => {
  it("is CURB_AGENT_NAME, else the project's name, else curb-agent", () => {
    expect(voiceWorkerAgentName({ CURB_AGENT_NAME: " front-desk " }, "concierge")).toBe("front-desk");
    expect(voiceWorkerAgentName({}, "concierge")).toBe("concierge");
    expect(voiceWorkerAgentName({})).toBe("curb-agent");
  });

  it("never registers under a blank name, which LiveKit would dispatch into every room", () => {
    expect(voiceWorkerAgentName({ CURB_AGENT_NAME: " " }, " ")).toBe("curb-agent");
    expect(voiceWorkerAgentName({ CURB_AGENT_NAME: "" }, "")).toBe("curb-agent");
  });
});

describe("readProjectPackageName", () => {
  it("reads the package name, and nothing when there is none", () => {
    expect(readProjectPackageName(project(JSON.stringify({ name: " concierge " })))).toBe("concierge");
    expect(readProjectPackageName(project(JSON.stringify({ private: true })))).toBeUndefined();
    expect(readProjectPackageName(project())).toBeUndefined();
  });

  it("names the package.json it cannot parse", () => {
    expect(() => readProjectPackageName(project("{ not json"))).toThrow(/package\.json is not valid JSON/);
  });
});
