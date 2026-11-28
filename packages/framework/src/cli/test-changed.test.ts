import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { says, tasksBundle, steps } from "../test-fixtures/tasks.js";
import { createTestProject } from "./test-project.js";
import { parseTestArgs, testCommand, type TestHost, type TestReport } from "./test.js";

/** A host whose agent says hello to every scripted line; no caller, no judge. */
const host: TestHost = {
  async createBundle() {
    const bundle = tasksBundle(steps([says("Hello there."), says("Hello there."), says("Hello there.")]));
    return { runtime: bundle.runtime, session: bundle.session };
  },
  simulator() {
    throw new Error("a scripted scenario asks no simulator");
  },
  models: () => ({ agent: "openai:gpt-5.2", caller: null, judge: null }),
};

const SCRIPTED = (name: string) => `import { scenario } from "curb/testing";
export default scenario({ name: ${JSON.stringify(name)}, turns: ["Hi"], expect: ({ said }) => [said("hello")] });
`;
const META = `export const meta = { title: "Orders", description: "Use for orders." };\n`;

describe("curb test --changed", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A project in git, with one commit: the agent, a skill "orders" with its scenario, and a
   * scenario at the agent level. */
  function repository() {
    const root = createTestProject({
      ".gitignore": "node_modules\n.curb\n",
      "src/agent/agent.tsx": "export default function App() { return null; }\n",
      "src/agent/orders/skill.tsx": `${META}export default function Orders() { return null; }\n`,
      "src/agent/orders/orders.scenario.ts": SCRIPTED("orders"),
      "src/agent/greets.scenario.ts": SCRIPTED("greets"),
    });
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "empty");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "agent");
    return { root, write: (path: string, text: string) => writeFileSync(join(root, path), text) };
  }

  async function test(root: string, args: string[]) {
    const out: string[] = [];
    const code = await testCommand(args, root, { host, out: (text) => void out.push(text), env: {} });
    return { code, printed: out.join("") };
  }
  const picked = (report: TestReport) => ({
    ran: report.changed?.ran.map((entry) => `${entry.name}: ${entry.why}`),
    skipped: report.changed?.skipped.map((entry) => `${entry.name}: ${entry.why}`),
  });

  it("runs nothing when nothing the agent runs on changed, and passes", async () => {
    const { root, write } = repository();
    write("README.md", "# notes\n");
    const { code, printed } = await test(root, ["--changed", "HEAD", "--json"]);
    const report = JSON.parse(printed) as TestReport;
    expect(code).toBe(0);
    expect(report).toMatchObject({ passed: true, scenarios: [], changed: { since: "HEAD", files: ["README.md"] } });
    expect(report.changed?.base).toMatch(/^[0-9a-f]{40}$/);
    expect(picked(report).skipped).toEqual(["greets: nothing it runs on changed", "orders: nothing it runs on changed"]);
  });

  it("runs a changed skill's scenarios, and those no saved run played, then only those its saved runs opened", async () => {
    const { root, write } = repository();
    // Changed since the commit before: everything, and no scenario has a saved run yet.
    const first = JSON.parse((await test(root, ["--changed", "HEAD~1", "--json"])).printed) as TestReport;
    expect(first.scenarios.map((entry) => entry.name)).toEqual(["greets", "orders"]);

    // A new file in the skill's folder, not committed: the skill's scenario runs; the other one
    // played only at the agent level in the run just saved, so it is skipped.
    write("src/agent/orders/lookup.ts", "export const lookup = 1;\n");
    const { code, printed } = await test(root, ["--changed", "HEAD", "--json"]);
    const report = JSON.parse(printed) as TestReport;
    expect(code).toBe(0);
    expect(report.scenarios.map((entry) => entry.name)).toEqual(["orders"]);
    expect(picked(report)).toEqual({
      ran: ["orders: it sits in src/agent/orders, which changed"],
      skipped: ["greets: its saved runs opened no skill"],
    });
    expect(report.changed?.files).toEqual(["src/agent/orders/lookup.ts"]);

    // The text report says what ran and what was skipped, and why.
    const text = (await test(root, ["--changed", "HEAD"])).printed;
    expect(text).toMatch(/Changed since HEAD \([0-9a-f]{7}\): 1 file\(s\); ran 1 of 2 scenario\(s\)\./);
    expect(text).toContain("  skipped  greets (src/agent/greets.scenario.ts): its saved runs opened no skill");
  });

  it("runs every scenario when the agent level or a skill's meta changed, and only the skill's when its body did", async () => {
    const { root, write } = repository();
    await test(root, []);
    write("src/agent/orders/skill.tsx", `${META}export default function Orders() { return "changed"; }\n`);
    expect((JSON.parse((await test(root, ["--changed", "HEAD", "--json"])).printed) as TestReport).scenarios.map((entry) => entry.name)).toEqual(["orders"]);

    write("src/agent/orders/skill.tsx", `${META.replace("Use for orders.", "Use for orders and returns.")}export default function Orders() { return null; }\n`);
    const meta = JSON.parse((await test(root, ["--changed", "HEAD", "--json"])).printed) as TestReport;
    expect(picked(meta).ran).toEqual([
      "greets: src/agent/orders/skill.tsx (its meta) changed, which every conversation runs on",
      "orders: src/agent/orders/skill.tsx (its meta) changed, which every conversation runs on",
    ]);

    write("src/agent/orders/skill.tsx", `${META}export default function Orders() { return null; }\n`);
    write("src/agent/agent.tsx", "export default function App() { return 'changed'; }\n");
    expect((JSON.parse((await test(root, ["--changed", "HEAD", "--json"])).printed) as TestReport).scenarios.map((entry) => entry.name)).toEqual(["greets", "orders"]);
  });

  it("keeps the filter, and says how to fix a ref git cannot find", async () => {
    const { root, write } = repository();
    write("src/agent/agent.tsx", "export default function App() { return 'changed'; }\n");
    const filtered = JSON.parse((await test(root, ["orders", "--changed", "HEAD", "--json"])).printed) as TestReport;
    expect(filtered.scenarios.map((entry) => entry.name)).toEqual(["orders"]);

    await expect(test(root, ["--changed", "origin/main"])).rejects.toThrow(
      /--changed origin\/main: git cannot find where this branch left "origin\/main"\.\nFix: .*fetch-depth: 0/,
    );
    expect(() => parseTestArgs(["--changed", "main", "--rejudge", "latest"])).toThrow("curb test: --changed cannot be combined with --rejudge");
  });
});
