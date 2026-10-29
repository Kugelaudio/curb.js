import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentLoadFailure } from "./agent.node.js";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";

describe("agentLoadFailure", () => {
  const root = mkdtempSync(join(tmpdir(), "curb-load-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("places a compile error at the line and 1-based column the compiler reports, under the real path", () => {
    // tsx's message for esbuild's error: an absolute, symlink-resolved path, 0-based column.
    const error = Object.assign(
      new Error(`Transform failed with 1 error:\n${realpathSync(root)}/src/lib/helper.ts:1:42: ERROR: Unexpected ";"`),
      { name: "TransformError" },
    );
    expect(agentLoadFailure(error, root)).toEqual({
      code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
      severity: "error",
      message: 'The agent could not be loaded: its code does not compile: Unexpected ";"',
      location: { agentId: "agent", source: "src/lib/helper.ts", line: 1, column: 43 },
      fix: "Fix the code at this line. `curb check` lists every type and syntax error under src/.",
    });
  });

  it("keeps an authoring error's own code, location and fix", () => {
    const diagnostic = {
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error" as const,
      message: "defineAgent needs an app.",
      location: { source: "src/agent/agent.tsx", line: 3 },
      fix: "Pass app: YourApp.",
    };
    expect(agentLoadFailure(new AgentAuthoringError(diagnostic), root)).toEqual({
      ...diagnostic,
      location: { agentId: "agent", source: "src/agent/agent.tsx", line: 3 },
    });
  });

  it("places any other error at the project line it was thrown from", () => {
    const error = new Error("KEY is not set");
    error.stack = `Error: KEY is not set\n    at file://${realpathSync(root)}/src/lib/config.ts:4:9`;
    expect(agentLoadFailure(error, realpathSync(root))).toMatchObject({
      message: "The agent could not be loaded: KEY is not set",
      location: { agentId: "agent", source: "src/lib/config.ts", line: 4, column: 9 },
    });
  });
});
