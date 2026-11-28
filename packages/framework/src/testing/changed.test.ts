import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { affectedScenarios } from "./changed.js";
import type { TestRun } from "./record.js";

const META = `export const meta = {\n  title: "Orders",\n  description: "Use for orders.",\n};\n`;

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "curb-changed-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A saved run in which each scenario opened the skills listed for it, one turn each. */
function savedRun(opened: Record<string, string[]>): TestRun {
  const conversations = Object.entries(opened).map(([file, paths]) => ({
    scenario: { name: file.split("/").pop()!.replace(".scenario.ts", ""), file, mode: "simulated", run: 1 },
    turns: paths.map((skillPath, turn) => ({ turn, skillPath, toolCalls: [] })),
    endState: null,
  }));
  return { conversations } as unknown as TestRun;
}

const scenarios = [
  { name: "greets", file: "src/agent/greets.scenario.ts" },
  { name: "orders", file: "src/agent/orders/orders.scenario.ts" },
  { name: "refunds", file: "src/agent/billing/refunds.scenario.ts" },
  { name: "never-played", file: "src/agent/never-played.scenario.ts" },
];
const runs = [
  savedRun({
    "src/agent/greets.scenario.ts": ["", ""],
    "src/agent/orders/orders.scenario.ts": ["", "orders"],
    "src/agent/billing/refunds.scenario.ts": ["billing", "billing/refunds"],
  }),
];

const files = {
  "src/agent/agent.tsx": "export default function App() {}\n",
  "src/agent/orders/skill.tsx": `${META}export default function Orders() {}\n`,
  "src/agent/billing/skill.tsx": `${META.replace("Orders", "Billing")}export default function Billing() {}\n`,
  "src/agent/billing/refunds/skill.tsx": `${META.replace("Orders", "Refunds")}export default function Refunds() {}\n`,
};

const picked = (changed: string[], options: Parameters<typeof affectedScenarios>[2] = {}) =>
  Object.fromEntries(affectedScenarios(changed, scenarios, { root: project(files), runs, ...options }).map((entry) => [entry.name, entry.affected ? `ran: ${entry.why}` : `skipped: ${entry.why}`]));

describe("affectedScenarios", () => {
  it("runs, for a change in a skill's folder, the scenarios in it, those whose saved runs opened it, and those no run played", () => {
    expect(picked(["src/agent/orders/lookup.ts"])).toEqual({
      greets: "skipped: its saved runs opened no skill",
      orders: "ran: it sits in src/agent/orders, which changed",
      refunds: "skipped: its saved runs opened only billing, billing/refunds",
      "never-played": "ran: no saved run says which skills it opens",
    });
  });

  it("takes the deepest folder with a skill.tsx as the skill, and a skill as holding the skills under it", () => {
    // A nested skill: refunds opened it.
    expect(picked(["src/agent/billing/refunds/policy.md"]).refunds).toBe("ran: a saved run of it opened billing/refunds, which changed");
    // Its parent: a scenario that opened a skill under it is affected too, wherever its file sits.
    const parent = affectedScenarios(["src/agent/billing/rates.ts"], [{ name: "orders", file: "src/agent/orders/orders.scenario.ts" }], {
      root: project(files),
      runs: [savedRun({ "src/agent/orders/orders.scenario.ts": ["billing/refunds"] })],
    });
    expect(parent[0]).toMatchObject({ affected: true, why: "a saved run of it opened billing, which changed" });
  });

  it("runs every scenario when the agent level changed: agent.tsx, a module outside a skill, context/, package.json", () => {
    for (const file of ["src/agent/agent.tsx", "src/lib/prices.ts", "context/faq.md", "package.json", "package-lock.json"]) {
      const result = picked([file]);
      expect(Object.values(result).every((verdict) => verdict.startsWith("ran: "))).toBe(true);
      expect(result.greets).toBe(`ran: ${file} changed, which every conversation runs on`);
    }
  });

  it("runs nothing for files the agent does not run on, and a scenario whose own file changed", () => {
    expect(Object.values(picked(["README.md", ".github/workflows/curb-test.yml", "src/agent/orders/lookup.test.ts", ".env.example"]))).toEqual(
      Array(4).fill("skipped: nothing it runs on changed"),
    );
    expect(picked(["./src/agent/greets.scenario.ts"])).toMatchObject({ greets: "ran: its file changed", orders: "skipped: nothing it runs on changed" });
  });

  it("counts a skill.tsx as the agent level unless its meta, which every conversation is offered, is the same as before", () => {
    const root = project(files);
    const changed = ["src/agent/orders/skill.tsx"];
    const unchanged = affectedScenarios(changed, scenarios, { root, runs, before: () => `${META}export default function Orders() { return null; }\n` });
    expect(unchanged.map((entry) => entry.affected)).toEqual([false, true, false, true]);
    const retitled = affectedScenarios(changed, scenarios, { root, runs, before: () => META.replace("Use for orders.", "Orders and returns.") });
    expect(retitled[0]).toMatchObject({ affected: true, why: "src/agent/orders/skill.tsx (its meta) changed, which every conversation runs on" });
    // A new skill, and no way to tell what the file held before, are offers that changed too.
    expect(affectedScenarios(changed, scenarios, { root, runs, before: () => null })[0]?.affected).toBe(true);
    expect(affectedScenarios(changed, scenarios, { root, runs })[0]?.affected).toBe(true);
  });

  it("reads the skills of src/agents/<id>/ the same way, and a deleted skill as the agent level", () => {
    const root = project({ "src/agents/sales/agent.tsx": "", "src/agents/sales/quotes/skill.tsx": META });
    const sales = [{ name: "quotes", file: "src/agents/sales/quotes/quotes.scenario.ts" }];
    expect(affectedScenarios(["src/agents/sales/quotes/prices.ts"], sales, { root, runs: [] })[0]).toMatchObject({ affected: true, why: "it sits in src/agents/sales/quotes, which changed" });
    expect(affectedScenarios(["src/agents/sales/gone/skill.tsx"], sales, { root, runs: [] })[0]?.why).toBe("src/agents/sales/gone/skill.tsx changed, which every conversation runs on");
  });
});
