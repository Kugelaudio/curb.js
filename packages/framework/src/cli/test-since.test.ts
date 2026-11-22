import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgeAnswer } from "../test-fixtures/conversations.js";
import { says, steps, tasksBundle } from "../test-fixtures/tasks.js";
import type { RunComparison } from "../testing/index.js";
import { ago, formatSince } from "./scenarios/since.js";
import { createTestProject } from "./test-project.js";
import { testCommand, type TestHost, type TestReport } from "./test.js";

/** A host whose agent answers every line with `reply()`, and whose judge finds nothing. */
function replyingHost(reply: () => string): TestHost {
  return {
    async createBundle() {
      const { runtime, session } = tasksBundle(steps([says(reply())]));
      return { runtime, session };
    },
    simulator: () => async (request) => says(judgeAnswer(request, {})),
    models: () => ({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" }),
  };
}

const HELLO = `import { scenario } from "curb/testing";
export default scenario({ name: "says hello", turns: ["Hi"], runs: 5, expect: ({ said }) => [said("hello")] });
`;
const GREETS = `import { scenario } from "curb/testing";
export default scenario({ name: "greets", turns: ["Good morning"], expect: ({ said }) => [said("hello")] });
`;

describe("curb test after a change of the agent", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A project in a git repository of its own, with one commit. */
  function repository(): { root: string; commit: string } {
    const root = createTestProject({
      "src/agent/agent.tsx": "export const reply = 'Sorry.';\n",
      "src/agent/hello.scenario.ts": HELLO,
      "src/agent/greets.scenario.ts": GREETS,
      ".gitignore": "node_modules\n.curb/\n",
    });
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "v1");
    return { root, commit: git("rev-parse", "HEAD").trim() };
  }

  async function test(args: string[], root: string, reply: string) {
    const out: string[] = [];
    const code = await testCommand(args, root, { host: replyingHost(() => reply), out: (text) => void out.push(text), env: {} });
    return { code, printed: out.join("") };
  }
  const savedId = (printed: string) => /Saved: \.curb\/test-runs\/(\S+)\.json/.exec(printed)?.[1] ?? JSON.parse(printed).savedTo.slice(".curb/test-runs/".length, -".json".length);

  it("prints the pass rates since the last run of another version of the agent, and the same in JSON and Markdown", async () => {
    const { root, commit } = repository();

    // The first run has nothing to compare with.
    const first = await test(["--concurrency", "4"], root, "Sorry.");
    expect(first.code).toBe(1);
    expect(first.printed).not.toContain("Since ");
    const firstId = savedId(first.printed);

    // An edit of the agent, not committed: another version.
    writeFileSync(join(root, "src/agent/agent.tsx"), "export const reply = 'Hello there.';\n");
    const second = await test(["--concurrency", "4", "--report", "report.md"], root, "Hello there.");

    expect(second.code).toBe(0);
    const block = [`Since ${firstId} (${commit.slice(0, 7)}, just now):`, "  greets      0/1 (0%) -> 1/1 (100%)  too few runs to tell", "  says hello  0/5 (0%) -> 5/5 (100%)  better", ""].join("\n");
    expect(second.printed).toContain(`(check it again without running the agent: npx curb test --rejudge latest)\n${block}\n2 of 2 scenario(s) passed`);
    expect(readFileSync(join(root, "report.md"), "utf8")).toContain(
      [`### Since ${firstId} (${commit.slice(0, 7)}, just now)`, "", "| Scenario | Then | Now | Verdict |", "|---|---|---|---|", "| greets | 0/1 (0%) | 1/1 (100%) | too few runs to tell |", "| says hello | 0/5 (0%) | 5/5 (100%) | better |", ""].join("\n"),
    );

    // A scenario edited, not the agent: the same version as the second run, so it is again compared with the first.
    writeFileSync(join(root, "src/agent/hello.scenario.ts"), `${HELLO}// read the hello back\n`);
    const third = await test(["--json"], root, "Hello there.");
    const report = JSON.parse(third.printed) as TestReport;
    expect(report.since).toEqual({
      before: { id: firstId, createdAt: expect.any(String), agentVersion: { commit, dirty: false, sources: expect.stringMatching(/^[0-9a-f]{16}$/) } },
      after: { id: savedId(third.printed), createdAt: expect.any(String), agentVersion: { commit, dirty: true, sources: expect.stringMatching(/^[0-9a-f]{16}$/) } },
      scenarios: [
        { name: "greets", file: "src/agent/greets.scenario.ts", before: { passed: 0, completed: 1, passRate: 0 }, after: { passed: 1, completed: 1, passRate: 1 }, verdict: "too_few_runs", p: null },
        { name: "says hello", file: "src/agent/hello.scenario.ts", before: { passed: 0, completed: 5, passRate: 0 }, after: { passed: 5, completed: 5, passRate: 1 }, verdict: "better", p: expect.closeTo(0.0079, 4) },
      ],
    } satisfies RunComparison);
    expect(report.since!.before.agentVersion!.sources).not.toBe(report.since!.after.agentVersion!.sources);

    // A re-judge played no new version: nothing to compare.
    const rejudged = await test(["--rejudge", "latest"], root, "Hello there.");
    expect(rejudged.printed).not.toContain("Since ");
  });

  it("compares only with a run that played every scenario of this one", async () => {
    const { root } = repository();
    await test(["says hello"], root, "Sorry.");
    writeFileSync(join(root, "src/agent/agent.tsx"), "export const reply = 'Hello there.';\n");

    // The earlier run did not play greets.
    expect((await test([], root, "Hello there.")).printed).not.toContain("Since ");
    // Filtered to what it played, it compares.
    expect((await test(["says hello"], root, "Hello there.")).printed).toContain("  says hello  0/5 (0%) -> 5/5 (100%)  better\n");
  });

  it("names an earlier version with uncommitted changes as such, and says how long ago it ran", () => {
    const comparison: RunComparison = {
      before: { id: "20301001T080000000Z-k3f9", createdAt: "2030-10-01T08:00:00.000Z", agentVersion: { commit: "3f9c2a1d8e7b", dirty: true, sources: "a" } },
      after: { id: "20301003T090000000Z-p2x7", createdAt: "2030-10-03T09:00:00.000Z", agentVersion: { commit: "3f9c2a1d8e7b", dirty: true, sources: "b" } },
      scenarios: [{ name: "books", file: "src/agent/books.scenario.ts", before: { passed: 4, completed: 5, passRate: 0.8 }, after: { passed: 3, completed: 5, passRate: 0.6 }, verdict: "no_clear_change", p: 1 }],
    };
    expect(formatSince(comparison, Date.parse("2030-10-03T09:00:00.000Z"))).toEqual(["Since 20301001T080000000Z-k3f9 (uncommitted changes, 2 days ago):", "  books  4/5 (80%) -> 3/5 (60%)  no clear change"]);
    const now = Date.parse("2030-10-03T09:00:00.000Z");
    expect([ago("2030-10-03T08:59:30.000Z", now), ago("2030-10-03T08:59:00.000Z", now), ago("2030-10-03T07:00:00.000Z", now), ago("2030-10-01T10:00:00.000Z", now)]).toEqual(["just now", "1 minute ago", "2 hours ago", "47 hours ago"]);
  });
});
