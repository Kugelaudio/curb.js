import { describe, expect, it } from "vitest";
import { saved, turn } from "../test-fixtures/conversations.js";
import { aggregateScenario } from "./aggregate.js";
import type { JudgeAnswer } from "./judge.js";
import type { SavedConversation, SavedScenarioSettings } from "./record.js";

const settings: SavedScenarioSettings = {
  name: "books",
  file: "src/agent/books.scenario.ts",
  mode: "simulated",
  runs: 5,
  minPassRate: 1,
  expectations: [],
  failOn: [],
  style: {},
};

const aggregate = (conversations: SavedConversation[], overrides: Partial<SavedScenarioSettings> = {}, maxErrorRate = 0.2) =>
  aggregateScenario({ settings: { ...settings, ...overrides }, conversations, maxErrorRate, durationMs: 4200 });

const outcomes = (...list: Array<"pass" | "fail" | "error">) => list.map((outcome, index) => saved(index + 1, outcome));

describe("a scenario's runs as one result", () => {
  it("counts passed over completed runs, and says how reliable that makes it", () => {
    const result = aggregate(outcomes("pass", "pass", "fail", "pass", "pass"));
    expect(result.stats).toEqual({
      runs: 5,
      ran: 5,
      passed: 4,
      failed: 1,
      errors: 0,
      passRate: 0.8,
      // 0.8 to the power of 5: the chance that all five runs pass.
      reliability: 0.328,
      errorRate: 0,
      minPassRate: 1,
      maxErrorRate: 0.2,
    });
    expect(result).toMatchObject({ outcome: "fail", passed: false, flaky: true, durationMs: 4200 });
    expect(result.checkStats).toEqual([{ name: "the caller reaches its goal", passed: 4, total: 5, passRate: 0.8, unknown: 0 }]);
    // The run a reader is shown first is one that failed.
    expect(result.runs.map((run) => [run.run, run.outcome])).toEqual([[1, "pass"], [2, "pass"], [3, "fail"], [4, "pass"], [5, "pass"]]);
    expect(result.checks).toEqual([{ name: "the caller reaches its goal", pass: false }]);
  });

  it("passes at the share the scenario asks for, and still says it is flaky", () => {
    const result = aggregate(outcomes("pass", "pass", "fail", "pass", "pass"), { minPassRate: 0.8 });
    expect(result).toMatchObject({ outcome: "pass", passed: true, flaky: true });
    expect(aggregate(outcomes("fail", "fail", "fail"))).toMatchObject({ outcome: "fail", flaky: false, stats: { passRate: 0, reliability: 0 } });
    expect(aggregate(outcomes("pass", "pass", "pass", "pass", "pass"))).toMatchObject({ outcome: "pass", flaky: false, stats: { passRate: 1, reliability: 1 } });
  });

  it("leaves errors out of the pass rate, and is an error itself when too many runs are", () => {
    const one = aggregate(outcomes("pass", "error", "pass", "pass", "pass"));
    expect(one.stats).toMatchObject({ passed: 4, failed: 0, errors: 1, passRate: 1, errorRate: 0.2 });
    expect(one.outcome).toBe("pass");
    // Errors are not checked: a check's rate is over the runs that completed.
    expect(one.checkStats[0]).toMatchObject({ passed: 4, total: 4 });

    const two = aggregate(outcomes("pass", "error", "pass", "error", "pass"));
    expect(two).toMatchObject({ outcome: "error", passed: false, stats: { passRate: 1, errorRate: 0.4 } });
    expect(aggregate(outcomes("error"), { runs: 1 })).toMatchObject({ outcome: "error", stats: { passRate: null, reliability: null, errorRate: 1 } });
    // A run that failed is evidence, however many others could not be assessed.
    expect(aggregate(outcomes("fail", "error", "error")).outcome).toBe("fail");
  });

  it("reports the judge's findings with their rate and the evidence of the first runs", () => {
    const answer = (answer: JudgeAnswer["answer"], turn: number | null, quote: string | null): JudgeAnswer => ({
      id: "asked_again",
      kind: "finding",
      text: "The agent asked the caller for a piece of information the caller had already stated.",
      answer,
      turn,
      quote,
      reason: "The caller had given the name.",
    });
    const judged = (run: number, given: JudgeAnswer) => {
      const conversation = saved(run, "pass");
      return { ...conversation, assessment: { ...conversation.assessment, judge: { promptVersion: "1", model: null, answers: [given] } } };
    };
    const result = aggregate([judged(1, answer("yes", 2, "What is your name?")), judged(2, answer("no", null, null)), judged(3, answer("unknown", null, null)), saved(4, "error")]);

    const asked = result.findings.find((finding) => finding.id === "asked_again");
    expect(asked).toEqual({
      id: "asked_again",
      question: "The agent asked the caller for a piece of information the caller had already stated.",
      found: 1,
      unknown: 1,
      // Over the runs the judge read.
      total: 3,
      rate: 0.333,
      examples: [{ run: 1, turn: 2, quote: "What is your name?", reason: "The caller had given the name." }],
    });
    expect(result.findings.map((finding) => finding.id)).toHaveLength(6);
    // No run was judged: there is nothing to report.
    expect(aggregate(outcomes("pass")).findings).toEqual([]);
  });

  it("reports every variant of every experiment on its own, as well as overall", () => {
    const withVariant = (run: number, outcome: "pass" | "fail" | "error", greeting: string) => saved(run, outcome, { experiments: { greeting, pacing: "slow" } });
    const result = aggregate([withVariant(1, "pass", "casual"), withVariant(2, "fail", "formal"), withVariant(3, "pass", "casual"), withVariant(4, "error", "formal")], { minPassRate: 0.5 }, 0.5);
    expect(result.variants).toEqual([
      { experiment: "greeting", variant: "casual", runs: 2, passed: 2, failed: 0, errors: 0, passRate: 1 },
      { experiment: "greeting", variant: "formal", runs: 2, passed: 0, failed: 1, errors: 1, passRate: 0 },
      { experiment: "pacing", variant: "slow", runs: 4, passed: 2, failed: 1, errors: 1, passRate: 0.667 },
    ]);
    expect(result.stats).toMatchObject({ passed: 2, failed: 1, errors: 1 });
    expect(aggregate(outcomes("pass")).variants).toEqual([]);
  });

  it("fails on a style limit the runs are above, and reports the numbers either way", () => {
    const long = saved(1, "pass", { turns: [turn({ turn: 1, reply: "One two three four five six seven eight nine ten eleven twelve." })] });
    const result = aggregate([long], { runs: 1, style: { wordsP90: 10 } });
    expect(result).toMatchObject({ outcome: "fail", style: { wordsP90: 12, replies: 1 } });
    expect(result.checks.at(-1)).toEqual({ name: "style: wordsP90 at most 10", pass: false, detail: "wordsP90 is 12, above the limit of 10" });
    expect(aggregate([long], { runs: 1 })).toMatchObject({ outcome: "pass", style: { wordsP90: 12, limits: [] } });
  });

  it("is an error, with nothing to show, when it has no run", () => {
    expect(aggregate([])).toMatchObject({ outcome: "error", passed: false, turns: [], checks: [], runs: [], stats: { ran: 0, passRate: null } });
  });
});
