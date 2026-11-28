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

describe("tools and info as values in the type check", () => {
  // A billing skill that declares the order it needs and exports its tools as values, a scenario
  // that uses them correctly, and three scenarios with one mistake each.
  const scenarioFile = (body: string) =>
    `import { fake, scenario } from "curb/testing";\nimport * as Billing from "./skill.js";\nimport { findOrder, issueRefund } from "./tools.js";\n\n${body}`;
  const root = createTestProject({
    "src/agent/agent.tsx": `import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";

export function App() {
  return (
    <Agent>
      <SystemPrompt>You help with bills.</SystemPrompt>
      <Skills>
        <Skill path="/billing" description="Use for questions about a bill.">Billing</Skill>
      </Skills>
    </Agent>
  );
}

export const agent = defineAgent({ app: App });
`,
    "src/agent/billing/tools.ts": `import { defineTool, z } from "curb";

export const findOrder = defineTool({
  name: "find_order",
  description: "Look an order up.",
  schema: z.object({ order: z.string() }),
  onSubmit: async ({ order }) => ({ ok: true, data: { id: order, paid: 49 } }),
});

export const issueRefund = defineTool({
  name: "issue_refund",
  description: "Refund an order.",
  schema: z.object({ order: z.string() }),
  onSubmit: async () => ({ ok: true, data: { refunded: 49 } }),
});
`,
    "src/agent/billing/skill.tsx": `import { Instruction, Tool, useAgentInfo, z, type SkillMeta } from "curb";
import { findOrder, issueRefund } from "./tools.js";

export const meta = {
  title: "Billing",
  description: "Use for questions about a bill.",
  info: z.object({ "order.id": z.string(), "order.note": z.string().optional() }),
} satisfies SkillMeta;

export default function Billing() {
  const info = useAgentInfo(meta);
  const order: string | undefined = info["order.id"];
  return (
    <>
      <Instruction>{\`Look order \${order ?? "unknown"} up with \${findOrder.name} first.\`}</Instruction>
      <Tool {...findOrder} />
      <Tool {...issueRefund} />
    </>
  );
}
`,
    "src/agent/billing/refund.scenario.ts": scenarioFile(`export default scenario({
  start: { skills: [Billing], info: { "order.id": "A-1042" } },
  turns: ["Please refund order A-1042."],
  fakes: [fake(findOrder, { ok: true, data: { id: "A-1042", paid: 49 } }), fake(issueRefund, { ok: true, data: { refunded: 49 } })],
  expect: ({ called, notCalled, calledInOrder }) => [called(issueRefund, { order: "A-1042" }), notCalled("cancel_order"), calledInOrder(findOrder, issueRefund)],
});
`),
    "src/agent/billing/misspelled-tool.scenario.ts": scenarioFile(`export default scenario({
  turns: ["Please refund order A-1042."],
  expect: ({ called }) => [called(issueRefnd)],
});
`),
    "src/agent/billing/wrong-fake.scenario.ts": scenarioFile(`export default scenario({
  turns: ["Please refund order A-1042."],
  fakes: [fake(findOrder, { ok: true, data: { id: "A-1042", paid: "49" } })],
});
`),
    "src/agent/billing/missing-info.scenario.ts": scenarioFile(`export default scenario({
  start: { skills: [Billing], info: { "order.note": "late" } },
  turns: ["Please refund order A-1042."],
});
`),
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("fails on a misspelled tool, a fake of the wrong shape and a missing info key, and on nothing else", async () => {
    const result = await typeCheckProject(root, "agent");

    const found = result.diagnostics.map((diagnostic) => ({
      at: formatAuthoringLocation(diagnostic.location),
      code: diagnostic.code,
      message: diagnostic.message,
    }));
    expect(found.map(({ at }) => at)).toEqual([
      "src/agent/billing/missing-info.scenario.ts:6:31",
      "src/agent/billing/misspelled-tool.scenario.ts:7:35",
      "src/agent/billing/wrong-fake.scenario.ts:7:27",
    ]);
    expect(found.every(({ code }) => code === "AGENT_TYPE_ERROR")).toBe(true);
    expect(found[0].message).toContain(`Property '"order.id"' is missing`);
    expect(found[1].message).toContain("Cannot find name 'issueRefnd'. Did you mean 'issueRefund'?");
    expect(found[2].message).toContain("The types of 'data.paid' are incompatible");
  }, 120_000);
});
