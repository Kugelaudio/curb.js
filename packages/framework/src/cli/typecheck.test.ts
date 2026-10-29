import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatAuthoringLocation } from "../authoring.js";
import { createTestProject, SEEDED_FAULT_FILES } from "./test-project.js";
import { typeCheckProject } from "./typecheck.js";

describe("typeCheckProject", () => {
  const root = createTestProject({
    ...SEEDED_FAULT_FILES,
    // Not loaded by the framework (AGENT_ORCHESTRATION_IGNORED), so not type-checked either.
    "src/orchestration/session.ts": 'export const port: number = "4000";\n',
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports the project's own type errors, including code a render never reaches", async () => {
    const result = await typeCheckProject(root, "agent");

    expect(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.severity,
        diagnostic.message,
        formatAuthoringLocation(diagnostic.location),
      ]),
    ).toEqual([
      [
        "AGENT_TYPE_ERROR",
        "error",
        "Cannot find name 'finsh'. Did you mean 'finish'? (TS2552)",
        "src/agent/tasks/skill.tsx:13:9",
      ],
      ["AGENT_TYPE_ERROR", "error", "Cannot find name 'summary'. (TS2304)", "src/agent/tasks/skill.tsx:17:16"],
    ]);
    expect(result.diagnostics[0].fix).toContain("Declare or import this name");
    // agent.tsx and tasks/skill.tsx; the framework source it imports and src/orchestration/ are not counted.
    expect(result.checkedFiles).toBe(2);
    expect(result.unlisted).toBe(0);
  }, 120_000);

  it("says so instead of passing silently when TypeScript is not installed", async () => {
    const result = await typeCheckProject(root, "agent", { loadTypeScript: async () => null });

    expect(result.checkedFiles).toBe(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "AGENT_TYPECHECK_UNAVAILABLE",
        severity: "warning",
        fix: "Run `npm install --save-dev typescript`, then run check again.",
      }),
    ]);
  });
});

describe("Node's types in the type check", () => {
  // A project with no node_modules at all: whatever Node types the check finds are curb's own.
  const root = mkdtempSync(join(tmpdir(), "curb-node-types-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
      },
      include: ["src"],
    }),
  );
  writeFileSync(
    join(root, "src", "tool.ts"),
    'export function apiKey(): string {\n  return process.env.SOME_KEY ?? Buffer.from("none").toString("base64");\n}\n',
  );
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("types process.env and Buffer with the @types/node curb depends on", async () => {
    const result = await typeCheckProject(root, "agent");

    expect(result.diagnostics).toEqual([]);
    expect(result.checkedFiles).toBe(1);
  });

  it("turns Node names into one warning, never an error, when no Node types exist", async () => {
    const result = await typeCheckProject(root, "agent", { resolveNodeTypes: () => null });

    expect(result.diagnostics).toEqual([
      {
        code: "AGENT_NODE_TYPES_MISSING",
        severity: "warning",
        message:
          "Node's type definitions are not installed, so the type check cannot see `process`, `Buffer` (2 use(s) under src/). The code runs; only those lines go unchecked.",
        location: { agentId: "agent", source: "src/tool.ts", line: 2, column: 10 },
        fix: 'Run `npm install --save-dev @types/node`. For your editor, also add "types": ["node"] to compilerOptions in tsconfig.json.',
      },
    ]);
  });
});
