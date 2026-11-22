import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRequest, AgentRunResponse } from "../llm/types.js";
import { isJudgeRequest, judgeAnswer, record, turn } from "../test-fixtures/conversations.js";
import { addTask, calls, says, steps, tasksBundle } from "../test-fixtures/tasks.js";
import { checksOf, scenario, type ScenarioDefinition } from "../testing/index.js";
import { judgePrompt, judgeQuestions } from "../testing/judge.js";
import type { SavedTestRun } from "../testing/record.js";
import type { ScenarioResult } from "./scenarios/run.js";
import { createTestProject } from "./test-project.js";
import { testCommand, type TestHost, type TestReport } from "./test.js";

/**
 * The openings of a scenario onto the building blocks of `curb/testing`: findings of its own,
 * `ask`, `model` and `note` in `expect`, checks across runs (`expectRuns`), and a caller of its
 * own; and `curb review` asking a project's own findings. Hermetic: the task agent plays a
 * script, and every model request is answered here.
 */

type Answers = NonNullable<Parameters<typeof judgeAnswer>[1]>;

/** A host on the task agent: each bundle plays `agent()`, a judge request is answered with
 * `judge(request)`, any other model request (a caller's, an author's own) with `model`. */
function host(params: { agent: () => AgentRunResponse[]; judge?: (request: AgentRunRequest) => Answers; model?: (request: AgentRunRequest) => string }) {
  const requests: AgentRunRequest[] = [];
  const testHost: TestHost = {
    async createBundle() {
      const { runtime, session } = tasksBundle(steps(params.agent()));
      return { runtime, session };
    },
    simulator: () => async (request) => {
      requests.push(request);
      if (isJudgeRequest(request)) return says(judgeAnswer(request, { goal: "yes", ...params.judge?.(request) }));
      return says(params.model?.(request) ?? "[hang up]");
    },
    models: () => ({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" }),
  };
  return { host: testHost, requests, judged: () => requests.filter(isJudgeRequest) };
}

const asked = (request: AgentRunRequest) => [...request.systemPrompt.matchAll(/^- ([a-z_0-9]+): /gm)].map((match) => match[1]);

const NATURAL = `export const natural = {
  canned_closing: 'The agent ends a reply with a stock line such as "Is there anything else I can help you with?"',
  missed_mood: "The caller sounded annoyed or rushed and the agent carried on as if they had not.",
};
`;
const canned = { answer: "yes" as const, turn: 1, quote: "Anything else?", reason: "It closes with a stock line." };
const milkAgent = () => [calls(addTask("milk")), says("Milk is on your list. Anything else?"), says("Bye!")];

describe("a scenario's openings onto curb/testing", () => {
  const projects: string[] = [];
  const project = (files: Record<string, string>) => {
    const root = createTestProject(files);
    projects.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function run(args: string[], root: string, testHost: TestHost, env: Record<string, string | undefined> = {}) {
    const out: string[] = [];
    const code = await testCommand(args, root, { host: testHost, out: (text) => void out.push(text), env });
    return { code, printed: out.join("") };
  }
  const json = (printed: string) => JSON.parse(printed) as TestReport & { scenarios: ScenarioResult[] };

  it("refuses findings, failOn and callers it cannot run, naming each", () => {
    const refused = (definition: Record<string, unknown>) => () => scenario({ turns: ["Hi"], ...definition } as ScenarioDefinition);
    expect(refused({ findings: { "Canned closing": "x" } })).toThrow('findings: "Canned closing" is no finding id; write it in lowercase words joined by underscores');
    expect(refused({ findings: { incoherent: "The agent rambles." } })).toThrow("findings.incoherent is a built-in finding, which the judge already asks");
    expect(refused({ findings: { goal: "x", expectation_1: "y" } })).toThrow(/findings\.goal: the judge asks a question of its own.*findings\.expectation_1: the judge asks/);
    expect(refused({ findings: { canned_closing: "  " } })).toThrow("findings.canned_closing must be one sentence");
    expect(refused({ findings: ["canned_closing"] })).toThrow("findings must be an object of id to one sentence");
    expect(refused({ failOn: ["canned_closing"] })).toThrow('failOn names "canned_closing", which is no judge finding');
    expect(refused({ expectRuns: [] })).toThrow("expectRuns must be a function of the runs that returns checks");
    // A team's own finding may fail a run, and a caller may be any function.
    expect(() => scenario({ turns: ["Hi"], findings: { canned_closing: "The agent ends on a stock line." }, failOn: ["canned_closing", "incoherent"] })).not.toThrow();
    expect(() => scenario({ caller: () => null, runs: 3 })).not.toThrow();
  });

  it("asks the judge about a scripted scenario whose only judged check is a built-in finding in failOn", async () => {
    const root = project({
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ name: "adds milk", turns: ["Put milk on my list."], failOn: ["incoherent"] });
`,
    });
    const said = { answer: "yes" as const, turn: 1, quote: "Milk is on your list", reason: "It says it twice." };
    const { host: testHost, judged } = host({ agent: milkAgent, judge: () => ({ incoherent: said }) });

    const { code, printed } = await run(["--json"], root, testHost);

    expect(judged()).toHaveLength(1);
    expect(code).toBe(1);
    expect(json(printed).scenarios[0]!.checks.at(-1)).toMatchObject({ name: "no judge finding: incoherent", pass: false });
  });

  it("asks a scenario's own findings in the judge's request, counts and reports them like the built-in ones, and fails on the one failOn names", async () => {
    const root = project({
      "src/agent/natural.ts": NATURAL,
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
import { natural } from "./natural.js";
export default scenario({
  name: "adds milk",
  turns: ["Put milk on my list."],
  findings: natural,
  failOn: ["canned_closing"],
});
`,
    });
    const { host: testHost, judged } = host({ agent: milkAgent, judge: () => ({ canned_closing: canned }) });

    const { code, printed } = await run(["--json"], root, testHost);

    expect(code).toBe(1);
    const [request] = judged();
    // The built-in findings in their words, then the team's own as their sentence.
    expect(asked(request!)).toEqual(["asked_again", "claimed_without_tool", "ignored_caller", "incoherent", "wrong_tool_use", "ended_early", "canned_closing", "missed_mood"]);
    expect(request!.systemPrompt).toContain('- canned_closing: Is this true of the call? The agent ends a reply with a stock line such as "Is there anything else I can help you with?"');
    const [result] = json(printed).scenarios;
    expect(result!.checks.at(-1)).toEqual({
      name: "no judge finding: canned_closing",
      pass: false,
      detail: "It closes with a stock line.",
      evidence: { answer: "yes", turn: 1, quote: "Anything else?" },
    });
    expect(result!.findings.map((finding) => [finding.id, finding.found, finding.total])).toEqual([
      ["asked_again", 0, 1],
      ["claimed_without_tool", 0, 1],
      ["ignored_caller", 0, 1],
      ["incoherent", 0, 1],
      ["wrong_tool_use", 0, 1],
      ["ended_early", 0, 1],
      ["canned_closing", 1, 1],
      ["missed_mood", 0, 1],
    ]);
    expect(result!.findings.at(-1)?.question).toBe("The caller sounded annoyed or rushed and the agent carried on as if they had not.");

    // The terminal and the Markdown report show it as they show a built-in finding.
    const terminal = await run(["--report", "report.md"], root, testHost);
    expect(terminal.printed).toContain('  find  canned_closing: turn 1 "Anything else?" (It closes with a stock line.)\n');
    expect(readFileSync(join(root, "report.md"), "utf8")).toContain('| canned_closing | 1/1 | run 1 turn 1 "Anything else?": It closes with a stock line. |');

    // The run file keeps the findings with the scenario, so a re-judge without it asks them too.
    const saved = readdirSync(join(root, ".curb/test-runs")).sort().map((file) => JSON.parse(readFileSync(join(root, ".curb/test-runs", file), "utf8")) as SavedTestRun);
    expect(saved[0]!.scenarios[0]).toMatchObject({ findings: { canned_closing: expect.any(String), missed_mood: expect.any(String) }, failOn: ["canned_closing"] });
  });

  it("re-judges a scenario's own findings and its ask, without running the agent", async () => {
    const root = project({
      "src/agent/natural.ts": NATURAL,
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
import { natural } from "./natural.js";
export default scenario({
  name: "adds milk",
  turns: ["Put milk on my list."],
  findings: natural,
  expect: async ({ ask, note }) => [note(await ask("The agent sounds like a person on the phone, not a form being read out."))],
});
`,
    });
    await run([], root, host({ agent: milkAgent }).host);

    const again = host({
      agent: () => [],
      judge: (request): Answers => (asked(request).includes("question") ? { question: { answer: "no", turn: 1, quote: "Anything else?", reason: "It reads like a form." } } : { canned_closing: canned }),
    });
    const { code, printed } = await run(["--rejudge", "latest", "--json"], root, again.host);

    expect(code).toBe(0);
    expect(again.judged().map(asked)).toEqual([
      ["asked_again", "claimed_without_tool", "ignored_caller", "incoherent", "wrong_tool_use", "ended_early", "canned_closing", "missed_mood"],
      ["question"],
    ]);
    const [result] = json(printed).scenarios;
    expect(result!.findings.find((finding) => finding.id === "canned_closing")).toMatchObject({ found: 1, total: 1 });
    expect(result!.checks.at(-1)).toEqual({
      name: "The agent sounds like a person on the phone, not a form being read out.",
      pass: false,
      detail: "It reads like a form.",
      evidence: { answer: "no", turn: 1, quote: "Anything else?" },
      reportOnly: true,
    });
    expect(result!.outcome).toBe("pass");
  });

  it("sends the judge the prompt it always sent when a scenario gives no findings of its own", async () => {
    const root = project({
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Put milk on my list."], expectations: ["The agent says that milk is on the list."] });
`,
    });
    const { host: testHost, judged } = host({ agent: milkAgent });
    await run([], root, testHost);
    expect(judged().map((request) => request.systemPrompt)).toEqual([judgePrompt(judgeQuestions(null, ["The agent says that milk is on the list."]))]);
  });

  it("gives expect ask, model and the transcript as the judge reads it, and a note fails nothing", async () => {
    const root = project({
      "src/agent/milk.scenario.ts": `import { scenario, type ScenarioDefinition } from "curb/testing";
const expect: ScenarioDefinition["expect"] = async ({ ask, model, note, check, transcriptText }) => {
  const rated = await model("Rate the call: does the agent sound warm? Answer yes or no.", transcriptText);
  return [
    note(check("sounds warm", rated.startsWith("yes"), rated)),
    note(await ask("The agent greets the caller by name.")),
    await ask("The agent says that milk is on the list."),
  ];
};
export default scenario({ name: "adds milk", turns: ["Put milk on my list."], runs: 2, expect });
export const once = scenario({ turns: ["Put milk on my list."], expect });
`,
    });
    const { host: testHost, requests } = host({
      agent: milkAgent,
      judge: (request): Answers => (request.systemPrompt.includes("greets the caller") ? { question: "no" } : { question: { answer: "yes", turn: 1, quote: "Milk is on your list", reason: "It says so." } }),
      model: (request) => (request.systemPrompt.startsWith("Rate the call") ? "no: it is curt" : "[hang up]"),
    });

    const { code, printed } = await run(["adds milk"], root, testHost);

    expect(code).toBe(0);
    const rating = requests.find((request) => request.systemPrompt.startsWith("Rate the call"))!;
    expect(rating.stateSnapshot.join("\n")).toContain('[turn 1] (The agent called the tool add_task: ok. Input: {"title":"milk"}.)');
    expect(rating.stateSnapshot.join("\n")).toContain("<<<TRANSCRIPT");
    expect(printed).toContain("  info  sounds warm: 0/2 (0%)\n");
    expect(printed).toContain("  info  The agent greets the caller by name.: 0/2 (0%)\n");
    expect(printed).toContain("  pass  The agent says that milk is on the list.: 2/2 (100%)\n");
    expect(printed).toContain("PASS adds milk (2/2 run(s) passed");

    // Run once, a note that did not pass is shown as info, never as FAIL.
    const once = await run(["once"], root, testHost);
    expect(once.printed).toContain("  info  sounds warm (did not pass): no: it is curt\n");
    expect(once.printed).not.toContain("FAIL");
  });

  it("makes a run an error, not a failure, when model() of expect cannot be asked", async () => {
    const root = project({
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Put milk on my list."], expect: async ({ model, check }) => [check("rated", (await model("Rate it.", "x")) === "yes")] });
`,
    });
    const failing: TestHost = {
      ...host({ agent: milkAgent }).host,
      simulator: () => async () => {
        throw new Error("HTTP 401: invalid key");
      },
    };
    const { code, printed } = await run(["--json"], root, failing);
    expect(code).toBe(2);
    const [result] = json(printed).scenarios;
    expect(result!.runs[0]!.error).toMatchObject({ kind: "judge", message: expect.stringContaining("HTTP 401: invalid key") });
    expect(result!.checks.at(-1)).toMatchObject({ name: "expect", notJudged: true });
  });

  it("refuses ask and model where no judge model was given", async () => {
    const conversation = record([turn({ turn: 1, caller: "Hi", reply: "Hello." })]);
    const { ask, model, transcriptText } = checksOf(conversation);
    await expect(ask("The agent greets the caller.")).rejects.toThrow("ask() asks a judge model, and none was given here. Fix: checksOf(record, { model: await testModel() })");
    await expect(model("Rate it.", transcriptText)).rejects.toThrow("model() asks a judge model, and none was given here.");
    expect(transcriptText).toContain("[turn 1] Agent: Hello.");
    await expect(checksOf(conversation, { model: async () => "" }).ask("  ")).rejects.toThrow("ask() takes one sentence about the call");
  });

  it("checks across all runs once they are done: a failed check fails the scenario, a note does not, and both run again on a re-judge", async () => {
    const goodbyes = ["Bye!", "Bye!", "Bye!"];
    const root = project({
      "src/agent/milk.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({
  name: "adds milk",
  turns: ["Put milk on my list.", "That's all."],
  runs: 3,
  expectRuns: (runs, { check, note }) => {
    const goodbyes = new Set(runs.map((run) => run.transcript.at(-1)?.reply));
    const added = runs.filter((run) => run.called("add_task").pass).length;
    return [
      check("the goodbye is not the same in every run", goodbyes.size > 1, \`\${goodbyes.size} goodbye(s) in \${runs.length} run(s)\`),
      note(check("adds the task on every run", added === runs.length, \`\${added} of \${runs.length}\`)),
    ];
  },
});
`,
    });
    const agent = () => [calls(addTask("milk")), says("Milk is on your list."), says(goodbyes.shift() ?? "Bye!")];

    const { code, printed } = await run([], root, host({ agent }).host);

    expect(code).toBe(1);
    expect(printed).toContain("  FAIL  across runs: the goodbye is not the same in every run: 1 goodbye(s) in 3 run(s)\n");
    expect(printed).toContain("  info  across runs: adds the task on every run: 3 of 3\n");
    expect(printed).toContain("FAIL adds milk (3/3 run(s) passed");

    const markdown = await run(["--report", "report.md", "--rejudge", "latest", "--json"], root, host({ agent: () => [] }).host);
    expect(markdown.code).toBe(1);
    const [result] = json(markdown.printed).scenarios;
    expect(result!.checks.filter((check) => check.name.startsWith("across runs: ")).map((check) => [check.name, check.pass, check.reportOnly])).toEqual([
      ["across runs: the goodbye is not the same in every run", false, undefined],
      ["across runs: adds the task on every run", true, true],
    ]);
    expect(readFileSync(join(root, "report.md"), "utf8")).toContain(
      ["| Across runs | Result |", "|---|---|", "| the goodbye is not the same in every run | FAIL: 1 goodbye(s) in 3 run(s) |", "| adds the task on every run | info: 3 of 3 |"].join("\n"),
    );
  });

  it("plays a caller of the scenario's own: no goal and no invented fact, judged like a simulated caller, run as often as runs says", async () => {
    const root = project({
      "src/agent/own.scenario.ts": `import { scenario, type Caller } from "curb/testing";
const caller: Caller = (turns) => (turns.length === 0 ? "Put milk on my list, my number is 0151 2345678." : null);
export default scenario({ name: "own caller", caller, runs: 2 });
`,
    });
    const { host: testHost, judged } = host({ agent: milkAgent });

    const { code, printed } = await run(["--json"], root, testHost);

    expect(code).toBe(0);
    const [result] = json(printed).scenarios;
    expect(result).toMatchObject({ mode: "simulated", outcome: "pass", stats: { runs: 2, passed: 2 } });
    expect(result!.runs.map((entry) => entry.endedBy)).toEqual(["caller", "caller"]);
    expect(result!.checks.map((check) => check.name)).not.toContain("the caller reaches its goal");
    // Asked of each run, as a simulated caller's conversation is, without the goal.
    expect(judged().map((request) => asked(request)[0])).toEqual(["asked_again", "asked_again"]);
  });

  it("makes a run an error when a caller of the scenario's own throws", async () => {
    const root = project({
      "src/agent/own.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ caller: async () => { throw new Error("no more lines in the fixture"); } });
`,
    });
    const { code, printed } = await run(["--json"], root, host({ agent: milkAgent }).host);
    expect(code).toBe(2);
    const [result] = json(printed).scenarios;
    expect(result!.runs[0]).toMatchObject({ outcome: "error", endedBy: "simulator", error: { kind: "simulator", message: "the caller could not go on: no more lines in the fixture" } });
  });
});
