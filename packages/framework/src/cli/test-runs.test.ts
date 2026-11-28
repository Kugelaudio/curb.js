import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLlmClient } from "../agent-session.js";
import type { AgentRunRequest, AgentRunResponse } from "../llm/types.js";
import { anthropic, kugelaudio, openai, openaiCompatible } from "../providers.js";
import { isJudgeRequest, judgeAnswer } from "../test-fixtures/conversations.js";
import { addTask, calls, hangUp, says, sendSummary, steps, tasksBundle } from "../test-fixtures/tasks.js";
import type { SavedTestRun } from "../testing/record.js";
import type { ScenarioResult } from "./scenarios/run.js";
import { createTestProject } from "./test-project.js";
import { modelFor, modelLabel } from "../testing/host.js";
import { TEST_OPTIONS, parseTestArgs, testCommand, type TestHost, type TestReport } from "./test.js";

type Answers = NonNullable<Parameters<typeof judgeAnswer>[1]>;

/**
 * A host on the task agent (`test-fixtures/tasks.tsx`). Every bundle plays `agent()` afresh;
 * every run's caller says `caller()` and its judge answers `judge(run)`, with run 1 first.
 */
function tasksHost(params: {
  agent: () => AgentRunResponse[];
  caller?: () => string[];
  judge?: (run: number) => Answers;
  tokens?: number;
  agentLlm?: () => AgentLlmClient;
  providerErrors?: () => number;
}) {
  const stats = { bundles: 0, callerRequests: [] as AgentRunRequest[], judgeRequests: [] as AgentRunRequest[], sends: 0 };
  let judged = 0;
  const host: TestHost = {
    async createBundle() {
      stats.bundles += 1;
      const bundle = tasksBundle(params.agentLlm?.() ?? steps(params.agent()));
      bundle.send.mockImplementation(async () => {
        stats.sends += 1;
        return { ok: true, message: "Sent." };
      });
      const tokens = params.tokens;
      return {
        runtime: bundle.runtime,
        session: bundle.session,
        ...(tokens ? { tokens: () => ({ inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) } : {}),
        ...(params.providerErrors ? { providerErrors: params.providerErrors } : {}),
      };
    },
    simulator(_llm, role) {
      if (role === "judge") {
        const run = (judged += 1);
        return async (request) => {
          stats.judgeRequests.push(request);
          return says(judgeAnswer(request, { goal: "yes", expectation_1: "yes", ...params.judge?.(run) }));
        };
      }
      const lines = [...(params.caller?.() ?? [])];
      return async (request) => {
        stats.callerRequests.push(request);
        return says(lines.shift() ?? "[hang up]");
      };
    },
    models: () => ({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" }),
  };
  return { host, stats };
}

const MILK = `import { scenario } from "curb/testing";
export default scenario({
  name: "adds milk",
  caller: { goal: "Put milk on the list" },
  expectations: ["The agent says that milk is on the list."],
  expect: ({ stateMatches }) => [stateMatches("tasks", { tasks: [{ title: "milk" }] })],
});
`;
const HELLO = `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"], expect: ({ said }) => [said("hello")] });
`;
const milkAgent = () => [calls(addTask("milk")), says("Milk is on your list."), says("Bye!")];
const milkCaller = () => ["Put milk on my list.", "Thanks, bye! [hang up: met - milk is on the list]"];

describe("curb test, repeated and saved runs", () => {
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

  async function run(args: string[], root: string, host: TestHost, env: Record<string, string | undefined> = {}) {
    const out: string[] = [];
    const code = await testCommand(args, root, { host, out: (text) => void out.push(text), env });
    return { code, printed: out.join("") };
  }
  const savedRun = (root: string): SavedTestRun => {
    const [file] = readdirSync(join(root, ".curb/test-runs"));
    return JSON.parse(readFileSync(join(root, ".curb/test-runs", file!), "utf8")) as SavedTestRun;
  };

  it("runs a simulated scenario --runs times and reports rates, the flaky scenario and the failed run's transcript", async () => {
    const root = project({ "src/agent/milk.scenario.ts": MILK, "src/agent/hello.scenario.ts": HELLO });
    const { host, stats } = tasksHost({
      agent: milkAgent,
      caller: milkCaller,
      judge: (run): Answers => (run === 2 ? { goal: "no", incoherent: { answer: "yes", turn: 2, quote: "Bye!", reason: "It says bye twice." } } : {}),
    });

    const { code, printed } = await run(["--runs", "3", "--concurrency", "1", "milk"], root, host);

    expect(code).toBe(1);
    expect(stats.bundles).toBe(3);
    expect(printed).toContain(
      [
        "--- adds milk (src/agent/milk.scenario.ts)",
        "  run 1/3  pass   (2 caller turn(s), ",
      ].join("\n"),
    );
    expect(printed).toMatch(/ {2}run 2\/3 {2}FAIL {3}the caller reaches its goal \(2 caller turn\(s\), \d+\.\ds\)\n/);
    expect(printed).toContain(
      [
        "  runs  2 of 3 completed run(s) passed (67%), needs 100%, pass^3 30%",
        "  pass  no turn errors: 3/3 (100%)",
        "  pass  no empty agent reply: 3/3 (100%)",
        "  pass  no fallback line instead of a reply: 3/3 (100%)",
        "  pass  no sentence repeated within a turn: 3/3 (100%)",
        "  pass  the conversation ends cleanly: 3/3 (100%)",
        "  pass  the agent does not hang up on a caller who still wants something: 3/3 (100%)",
        "  FAIL  the caller reaches its goal: 2/3 (67%)",
        "  pass  expectation: The agent says that milk is on the list.: 3/3 (100%)",
        '  pass  state of tasks has {"tasks":[{"title":"milk"}]}: 3/3 (100%)',
        '  find  incoherent: 1 of 3 judged run(s) (33%), e.g. run 2 turn 2 "Bye!" (It says bye twice.)',
        "  note  the caller said its goal was met, and the judge says it was not reached",
        "  --- run 2 (fail)",
        "  caller: Put milk on my list.",
        '    [tool add_task ok] {"title":"milk"}',
        "  agent:  Milk is on your list.",
        "  caller: Thanks, bye!",
        "  agent:  Bye.",
        "  FAIL  the caller reaches its goal: goal: no",
        '  find  incoherent: turn 2 "Bye!" (It says bye twice.)',
        "FAIL adds milk (flaky: 2/3 run(s) passed, ",
      ].join("\n"),
    );
    expect(printed).toContain("Style (counted from the agent's replies):\n  adds milk: words per reply p50 1, p90 5 · ends on a question 0%");
    expect(printed).toMatch(/Saved: \.curb\/test-runs\/\d{8}T\d{9}Z-[a-z0-9]{4}\.json \(check it again without running the agent: npx curb test --rejudge latest\)/);
    expect(printed).toMatch(
      /\n0 of 1 scenario\(s\) passed in \d+\.\ds\. Flaky \(passed on some runs, failed on others\): adds milk \(src\/agent\/milk\.scenario\.ts\) 2\/3\n$/,
    );
  });

  it("passes a scenario at the share it asks for, and still lists it as flaky", async () => {
    const root = project({
      "src/agent/milk.scenario.ts": MILK.replace("expectations:", "minPassRate: 0.5,\n  expectations:"),
    });
    const { host } = tasksHost({ agent: milkAgent, caller: milkCaller, judge: (run): Answers => (run === 1 ? { goal: "no" } : {}) });

    const { code, printed } = await run(["--runs", "2", "--concurrency", "1"], root, host);

    expect(code).toBe(0);
    expect(printed).toContain("  runs  1 of 2 completed run(s) passed (50%), needs 50%, pass^2 25%\n");
    expect(printed).toContain("PASS adds milk (flaky: 1/2 run(s) passed, ");
    expect(printed).toMatch(
      /\n1 of 1 scenario\(s\) passed in \d+\.\ds\. Flaky \(passed on some runs, failed on others\): adds milk \(src\/agent\/milk\.scenario\.ts\) 1\/2\n$/,
    );
  });

  it("prints a check the judge never answered as skipped, under a scenario that passes without that run", async () => {
    const root = project({ "src/agent/milk.scenario.ts": MILK });
    const { host } = tasksHost({ agent: milkAgent, caller: milkCaller });
    let judged = 0;
    const flakyJudge: TestHost = {
      ...host,
      simulator: (llm, role, onUsage) => {
        const client = host.simulator(llm, role, onUsage);
        if (role !== "judge") return client;
        const run = (judged += 1);
        // The second run's judge cannot be reached, not even on the second try.
        return run === 2 ? async () => Promise.reject(new Error("HTTP 503: the judge is down")) : client;
      },
    };

    const { code, printed } = await run(["--runs", "3", "--concurrency", "1"], root, flakyJudge);

    // One error in three runs is within what a scenario may have; the two that completed passed.
    expect(code).toBe(0);
    expect(printed).toContain("  run 2/3  error  judge: HTTP 503: the judge is down (2 caller turn(s), ");
    expect(printed).toContain("  runs  2 of 2 completed run(s) passed (100%), needs 100%, pass^3 100%, 1 error(s) (33% of 3, at most 34%)\n");
    expect(printed).toContain("  pass  the caller reaches its goal: 2/2 (100%)\n");
    expect(printed).toContain(
      [
        "  --- run 2 (error: judge)",
        "  caller: Put milk on my list.",
        '    [tool add_task ok] {"title":"milk"}',
        "  agent:  Milk is on your list.",
        "  caller: Thanks, bye!",
        "  agent:  Bye.",
        "  error judge: HTTP 503: the judge is down",
        "  skip  the caller reaches its goal: not judged: HTTP 503: the judge is down",
        "  skip  expectation: The agent says that milk is on the list.: not judged: HTTP 503: the judge is down",
        "PASS adds milk (2/2 run(s) passed, ",
      ].join("\n"),
    );
    expect(printed).not.toContain("FAIL");
  });

  it("runs every run of a simulated scenario also once one failed, and a scripted scenario --runs times too", async () => {
    const root = project({ "src/agent/milk.scenario.ts": MILK, "src/agent/hello.scenario.ts": HELLO });
    const { host, stats } = tasksHost({ agent: () => [says("Hello there.")], caller: () => ["[hang up]"], judge: () => ({ goal: "no" }) });

    const { code, printed } = await run(["--runs", "5", "--concurrency", "1", "--json"], root, host);

    expect(code).toBe(1);
    const report = JSON.parse(printed) as TestReport;
    const [hello, milk] = report.scenarios as ScenarioResult[];
    expect(hello).toMatchObject({ name: "hello", mode: "scripted", passed: true, stats: { runs: 5, ran: 5, passed: 5, minPassRate: 1 } });
    expect(milk.stats).toMatchObject({ runs: 5, ran: 5, failed: 5 });
    expect(stats.bundles).toBe(10);
  });

  it("fails a scripted scenario that --runs plays more than once on a single failed run, unless it sets minPassRate", async () => {
    const root = project({
      "src/agent/hello.scenario.ts": HELLO,
      "src/agent/lenient.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"], minPassRate: 0.5, expect: ({ said }) => [said("hello")] });
`,
    });
    // One answer in three leaves out the word the scenario checks for.
    let bundle = 0;
    const { host } = tasksHost({ agent: () => [says((bundle += 1) % 3 === 0 ? "Hi there." : "Hello there.")] });

    const { code, printed } = await run(["--runs", "3", "--concurrency", "1", "--json"], root, host);

    expect(code).toBe(1);
    const [hello, lenient] = (JSON.parse(printed) as TestReport).scenarios as ScenarioResult[];
    expect(hello).toMatchObject({ mode: "scripted", outcome: "fail", flaky: true, stats: { runs: 3, passed: 2, failed: 1 } });
    expect(lenient).toMatchObject({ mode: "scripted", outcome: "pass", flaky: true, stats: { runs: 3, passed: 2, failed: 1 } });
  });

  it("keeps every field --json had, with the values a single run always gave, and only adds to them", async () => {
    const root = project({ "src/agent/hello.scenario.ts": HELLO });
    const { host } = tasksHost({ agent: () => [says("Hello there.")] });

    const { code, printed } = await run(["--json"], root, host);

    expect(code).toBe(0);
    const report = JSON.parse(printed) as TestReport;
    expect(Object.keys(report)).toEqual([
      "passed",
      "scenarios",
      "outcome",
      "exitCode",
      "durationMs",
      "models",
      "callerPromptVersion",
      "judgePromptVersion",
      "usage",
      "savedTo",
    ]);
    const [result] = report.scenarios as ScenarioResult[];
    expect(Object.keys(result).slice(0, 9)).toEqual(["name", "file", "mode", "passed", "endedBy", "durationMs", "turns", "checks", "notes"]);
    expect(result).toMatchObject({
      name: "hello",
      file: "src/agent/hello.scenario.ts",
      mode: "scripted",
      passed: true,
      endedBy: "script",
      turns: [
        {
          turn: 1,
          caller: "Hi",
          reply: "Hello there.",
          fallback: null,
          confirmation: null,
          toolCalls: [],
          errors: [],
          contextDiff: [],
          skillPath: "",
          skipped: false,
          endedCall: false,
        },
      ],
      checks: [
        { name: "no turn errors", pass: true },
        { name: "no empty agent reply", pass: true },
        { name: "no fallback line instead of a reply", pass: true },
        { name: "no sentence repeated within a turn", pass: true },
        { name: "the conversation ends cleanly", pass: true, detail: "every scripted caller line was said (1)" },
        { name: 'said "hello"', pass: true, detail: "turn 1" },
      ],
      notes: [],
    });
    expect(typeof result.durationMs).toBe("number");
    // What is new sits beside it.
    expect(report).toMatchObject({ passed: true, outcome: "pass", exitCode: 0, callerPromptVersion: "4", judgePromptVersion: "4", usage: null });
    expect(report.models).toEqual({ agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" });
    expect(result).toMatchObject({ outcome: "pass", flaky: false, stats: { runs: 1, ran: 1, passed: 1, passRate: 1, reliability: 1 }, findings: [], variants: [] });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ run: 1, outcome: "pass", judge: null, endState: { skillPath: "" } });
  });

  it("saves every conversation of a run in one file, and re-judges it without running the agent", async () => {
    const root = project({ "src/agent/milk.scenario.ts": MILK });
    const first = tasksHost({ agent: milkAgent, caller: milkCaller, tokens: 500 });
    const ran = await run(["--runs", "2", "--json"], root, first.host);
    expect(ran.code).toBe(0);
    const report = JSON.parse(ran.printed) as TestReport;
    expect(report.savedTo).toMatch(/^\.curb\/test-runs\/.+\.json$/);
    expect(report.usage).toMatchObject({ agent: { inputTokens: 1000 }, totalTokens: 1000 });

    const saved = savedRun(root);
    expect(saved).toMatchObject({
      format: "curb.test-run",
      version: 1,
      complete: true,
      models: { agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" },
      callerPromptVersion: "4",
      judgePromptVersion: "4",
      scenarios: [{ name: "adds milk", file: "src/agent/milk.scenario.ts", mode: "simulated", runs: 2, minPassRate: 1 }],
    });
    expect(saved.conversations.map((conversation) => [conversation.format, conversation.version, conversation.scenario.run, conversation.assessment.outcome])).toEqual([
      ["curb.conversation", 1, 1, "pass"],
      ["curb.conversation", 1, 2, "pass"],
    ]);
    expect(saved.conversations[0]).toMatchObject({
      source: "scenario",
      caller: { goal: "Put milk on the list" },
      ending: { by: "caller", caller: { done: true, goalMet: true, reason: "milk is on the list" } },
      endState: { stores: { tasks: { tasks: [{ title: "milk", done: false }] } } },
    });

    // The judge now finds the expectation unmet in every run; the agent and the caller are not asked.
    const again = tasksHost({ agent: () => [], judge: () => ({ expectation_1: { answer: "no", reason: "It never says so." } }) });
    const rejudged = await run(["--rejudge", "latest", "--json"], root, again.host);

    expect(rejudged.code).toBe(1);
    expect(again.stats.callerRequests).toEqual([]);
    expect(again.stats.judgeRequests).toHaveLength(2);
    const replayed = JSON.parse(rejudged.printed) as TestReport;
    expect(replayed.rejudgedFrom).toBe(saved.id);
    const [result] = replayed.scenarios as ScenarioResult[];
    expect(result.stats).toMatchObject({ runs: 2, ran: 2, passed: 0, failed: 2 });
    expect(result.checkStats.find((check) => check.name.startsWith("expectation:"))).toMatchObject({ passed: 0, total: 2 });
    // The author's expect ran again on the saved end state, and the agent's tokens are kept.
    expect(result.checkStats.find((check) => check.name.startsWith("state of tasks"))).toMatchObject({ passed: 2, total: 2 });
    expect(result.runs[0].usage?.agent).toEqual({ inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(readdirSync(join(root, ".curb/test-runs"))).toHaveLength(2);
  });

  it("re-judges by a run's id, prints a single run's transcript, and refuses a run that is not there", async () => {
    const root = project({ "src/agent/hello.scenario.ts": HELLO });
    await run([], root, tasksHost({ agent: () => [says("Hello there.")] }).host);
    const { id } = savedRun(root);

    const { code, printed } = await run(["--rejudge", id], root, tasksHost({ agent: () => [] }).host);
    expect(code).toBe(0);
    expect(printed).toContain(
      ["--- hello (src/agent/hello.scenario.ts)", "caller: Hi", "agent:  Hello there.", "  pass  no turn errors"].join("\n"),
    );
    expect(printed).toContain('  pass  said "hello": turn 1\nPASS hello (1 caller turn(s), ');

    await expect(run(["--rejudge", "20200101T000000Z-none"], root, tasksHost({ agent: () => [] }).host)).rejects.toThrow("[CURB_TEST_RUN_NOT_FOUND]");
  });

  it("exits 2 when no scenario failed but one could not be assessed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = project({ "src/agent/hello.scenario.ts": HELLO });
    let gaveUp = 0;
    const { host } = tasksHost({
      agent: () => [],
      agentLlm: () => async () => {
        gaveUp += 1;
        throw new Error("HTTP 529: overloaded");
      },
      providerErrors: () => gaveUp,
    });

    const { code, printed } = await run([], root, host);

    expect(code).toBe(2);
    expect(printed).toContain("ERROR hello (1 caller turn(s), ");
    expect(printed).toContain("): provider: the agent's LLM provider failed, after the retries: failed: HTTP 529: overloaded\n");
    expect(printed).toMatch(/\n0 of 1 scenario\(s\) passed in \d+\.\ds\. Not assessed \(too many errors\): hello \(src\/agent\/hello\.scenario\.ts\)\n$/);
  });

  it("starts no more runs of a scenario that has too many errors to be assessed, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = project({
      "src/agent/hello.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"], runs: 5, expect: ({ said }) => [said("hello")] });
`,
    });
    let gaveUp = 0;
    const { host, stats } = tasksHost({
      agent: () => [],
      agentLlm: () => async () => {
        gaveUp += 1;
        throw new Error("The operation was aborted due to timeout (no answer within 60 s)");
      },
      providerErrors: () => gaveUp,
    });

    const { code, printed } = await run(["--concurrency", "1", "--json"], root, host);

    expect(code).toBe(2);
    const [result] = (JSON.parse(printed) as TestReport).scenarios as ScenarioResult[];
    // Two errors of five runs are more than the 34% a scenario may have: three runs never start.
    expect(stats.bundles).toBe(2);
    expect(result.stats).toMatchObject({ runs: 5, ran: 2, errors: 2 });
    expect(result.outcome).toBe("error");
    expect(result.notes).toContain(
      "3 of 5 run(s) not started: 2 error(s) already, more than the 34% of its runs a scenario may have, so it cannot be assessed",
    );
    expect(savedRun(root).conversations).toHaveLength(2);
  });

  /** Scripted scenarios that each say one line, and an agent that takes `ms(line)` to answer it. */
  function timedHost(ms: (line: string) => number) {
    const flight = { now: 0, most: 0 };
    const tracked = async <T,>(wait: number, answer: () => T): Promise<T> => {
      flight.now += 1;
      flight.most = Math.max(flight.most, flight.now);
      await new Promise((resolve) => setTimeout(resolve, wait));
      flight.now -= 1;
      return answer();
    };
    const { host } = tasksHost({
      agent: () => [],
      agentLlm: () => async (request) => {
        const line = request.messages.findLast((message) => message.role === "user")?.content ?? "";
        return tracked(ms(line), () => says(`Hello, ${line}.`));
      },
    });
    const judging: TestHost = { ...host, simulator: () => async (request) => tracked(10, () => says(judgeAnswer(request, { expectation_1: "yes" }))) };
    return { host, judging, flight };
  }
  const named = (name: string, extra = "") => `import { scenario } from "curb/testing";
export default scenario({ turns: ["${name}"], ${extra}expect: ({ said }) => [said("hello, ${name}")] });
`;

  it("runs scenarios at the same time, as many conversations as --concurrency allows, and reports them in their order", async () => {
    const root = project({
      "src/agent/a.scenario.ts": named("slow"),
      "src/agent/b.scenario.ts": named("quick"),
      "src/agent/c.scenario.ts": named("third"),
      "src/agent/d.scenario.ts": named("fourth"),
    });
    // The first scenario takes longest: every other one is done before it.
    const { host, flight } = timedHost((line) => (line === "slow" ? 60 : 5));

    const { code, printed } = await run(["--concurrency", "3"], root, host);

    expect(code).toBe(0);
    expect(flight.most).toBe(3);
    const headers = [...printed.matchAll(/^--- (\w+) \(/gm)].map((match) => match[1]);
    expect(headers).toEqual(["a", "b", "c", "d"]);
    // Each scenario's transcript and verdict stay together, under its own header.
    expect(printed).toContain("--- a (src/agent/a.scenario.ts)\ncaller: slow\nagent:  Hello, slow.\n  pass  no turn errors");
    expect(printed).toMatch(/PASS a \(1 caller turn\(s\), \d+\.\ds\)\n\n--- b \(src\/agent\/b\.scenario\.ts\)\ncaller: quick\nagent: {2}Hello, quick\./);
    expect(savedRun(root).scenarios.map((entry) => entry.name)).toEqual(["a", "b", "c", "d"]);
    expect(savedRun(root).conversations.map((conversation) => conversation.scenario.name)).toEqual(["a", "b", "c", "d"]);

    // One at a time when asked: nothing overlaps.
    const sequential = timedHost(() => 5);
    await run(["--concurrency", "1"], root, sequential.host);
    expect(sequential.flight.most).toBe(1);
  });

  it("re-judges the conversations of every scenario at the same time, within --concurrency", async () => {
    const expectation = 'expectations: ["The agent says hello."], ';
    const root = project({
      "src/agent/a.scenario.ts": named("first", expectation),
      "src/agent/b.scenario.ts": named("second", expectation),
      "src/agent/c.scenario.ts": named("third", expectation),
    });
    const first = timedHost(() => 1);
    expect((await run(["--json"], root, first.judging)).code).toBe(0);

    const again = timedHost(() => 1);
    const { code, printed } = await run(["--rejudge", "latest", "--concurrency", "2"], root, again.judging);

    expect(code).toBe(0);
    // Only the judge ran, two calls at a time, and the report keeps the scenarios' order.
    expect(again.flight.most).toBe(2);
    expect([...printed.matchAll(/^--- (\w+) \(/gm)].map((match) => match[1])).toEqual(["a", "b", "c"]);
    expect(printed).toMatch(/\n3 of 3 scenario\(s\) passed in \d+\.\ds\.\n$/);
  });

  it("runs a tool without a fake for real on every run of a repeated scenario", async () => {
    const root = project({
      "src/agent/send.scenario.ts": `import { scenario } from "curb/testing";
export default scenario({ caller: { goal: "Send my list to Sam" }, runs: 2 });
`,
    });
    const { host, stats } = tasksHost({ agent: () => [calls(sendSummary("Sam")), says("Sent to Sam."), hangUp("Goodbye.")], caller: () => ["Send my list to Sam.", "Bye! [hang up: met - sent]"] });

    const { code, printed } = await run(["--concurrency", "1"], root, host);

    expect(code).toBe(0);
    expect(stats.sends).toBe(2);
    expect(printed).toContain("PASS send (2/2 run(s) passed, ");
  });

  it("writes the report as Markdown to --report and to the GitHub job summary", async () => {
    const root = project({ "src/agent/milk.scenario.ts": MILK, "src/agent/hello.scenario.ts": HELLO });
    const { host } = tasksHost({ agent: milkAgent, caller: milkCaller, judge: (run): Answers => (run === 1 ? { goal: "no" } : {}) });
    const summary = join(root, "step-summary.md");

    await run(["--runs", "2", "--concurrency", "1", "--report", "reports/curb.md", "milk"], root, host, { GITHUB_STEP_SUMMARY: summary });

    const markdown = readFileSync(join(root, "reports/curb.md"), "utf8");
    expect(readFileSync(summary, "utf8")).toBe(`${markdown}\n`);
    expect(markdown).toContain("## curb test: failed");
    expect(markdown).toContain("| Scenario | Outcome | Runs passed | Pass rate | pass^k | Errors |\n|---|---|---|---|---|---|\n| adds milk | fail (flaky) | 1/2 | 50% | 25% | 0 |");
    expect(markdown).toContain("| Check | Runs passed |\n|---|---|\n| the caller reaches its goal | 1/2 |");
    expect(markdown).toContain("<summary>Run 1: fail</summary>");
    expect(markdown).toContain("caller: Put milk on my list.");
    expect(markdown).toContain("| adds milk | words per reply p50 1, p90 5");
    expect(markdown).toContain("models: agent openai:gpt-5.2, caller openai:gpt-5.4-mini, judge openai:gpt-5.4-mini · judge prompt 4, caller prompt 4");

    // Without either, nothing is written.
    const quiet = project({ "src/agent/hello.scenario.ts": HELLO });
    await run([], quiet, tasksHost({ agent: () => [says("Hello there.")] }).host);
    expect(existsSync(join(quiet, "reports"))).toBe(false);

    // A backslash and a pipe in a name stay inside their table cell.
    const odd = project({ "src/agent/hello.scenario.ts": HELLO.replace("turns:", String.raw`name: "a\\b|c", turns:`) });
    await run(["--report", "report.md"], odd, tasksHost({ agent: () => [says("Hello there.")] }).host);
    expect(readFileSync(join(odd, "report.md"), "utf8")).toContain(String.raw`| a\\b\|c | pass | 1/1 |`);
  });

  it("fails a scenario whose replies are above its own style limit", async () => {
    const styled = (limit: number) => `import { scenario } from "curb/testing";
export default scenario({ turns: ["Hi"], style: { wordsP90: ${limit} } });
`;
    const root = project({ "src/agent/long.scenario.ts": styled(10), "src/agent/short.scenario.ts": styled(3) });
    const { host } = tasksHost({ agent: () => [says("Hello there, how are you?")] });

    const { code, printed } = await run([], root, host);

    expect(code).toBe(1);
    expect(printed).toContain("  pass  style: wordsP90 at most 10: wordsP90 is 5, within the limit of 10\n");
    expect(printed).toContain("  FAIL  style: wordsP90 at most 3: wordsP90 is 5, above the limit of 3\n");
    expect(printed).toMatch(/1 of 2 scenario\(s\) passed in \d+\.\ds\. Failed: short \(src\/agent\/short\.scenario\.ts\)\n$/);
  });
});

describe("curb test options", () => {
  it("reads every option, with its value after a space or an equals sign", () => {
    expect(
      parseTestArgs([
        "booking",
        "--runs",
        "5",
        "--concurrency=8",
        "--caller-model",
        "openai:gpt-5.4-mini",
        "--judge-model=gpt-5.2",
        "--report",
        "report.md",
        "--json",
      ]),
    ).toEqual({
      filter: "booking",
      hermetic: false,
      json: true,
      runs: 5,
      concurrency: 8,
      callerModel: "openai:gpt-5.4-mini",
      judgeModel: "gpt-5.2",
      report: "report.md",
    });
    expect(parseTestArgs(["--rejudge", "latest"])).toEqual({ filter: "", json: false, hermetic: false, rejudge: "latest" });
    expect(parseTestArgs(["--changed=origin/main"])).toEqual({ filter: "", json: false, hermetic: false, changed: "origin/main" });
    expect(TEST_OPTIONS).toEqual(["--json", "--hermetic", "--runs", "--concurrency", "--caller-model", "--judge-model", "--report", "--rejudge", "--changed"]);
  });

  it("refuses a value out of range, naming what the option takes", () => {
    expect(() => parseTestArgs(["--runs", "0"])).toThrow("curb test: --runs must be a whole number of runs from 1 to 100; got 0.");
    expect(() => parseTestArgs(["--runs", "500"])).toThrow("from 1 to 100; got 500.");
    expect(() => parseTestArgs(["--concurrency", "64"])).toThrow('curb test: --concurrency must be a whole number from 1 to 16; got "64".');
    expect(() => parseTestArgs(["--runs"])).toThrow("curb test: --runs needs a value: --runs <n>.");
    expect(() => parseTestArgs(["--report", "--json"])).toThrow("curb test: --report needs a value: --report <file>.");
  });

  it("puts a named model on the agent's provider, or on the provider its prefix names", () => {
    const agent = openai("gpt-5.2");
    expect(modelFor(undefined, agent)).toEqual(openai("gpt-5.4-mini"));
    expect(modelFor("gpt-5.2-mini", agent)).toEqual(openai("gpt-5.2-mini"));
    expect(modelFor("anthropic:claude-haiku-5-5", agent)).toEqual(anthropic("claude-haiku-5-5"));
    expect(modelFor("kugelaudio:qwen3.8-27b", agent)).toEqual(kugelaudio.llm({ model: "qwen3.8-27b" }));
    expect(modelFor("openai:gpt-5.4-mini", kugelaudio.llm())).toEqual(openai("gpt-5.4-mini"));
    // A model of an OpenAI-compatible endpoint stays on that endpoint, colons in its name and all.
    const local = openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" });
    expect(modelFor("qwen3:8b", local)).toEqual(openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "qwen3:8b" }));
    expect(modelLabel(local)).toBe("openai-compatible:llama3.3");
    expect(modelLabel(agent)).toBe("openai:gpt-5.2");
  });
});
