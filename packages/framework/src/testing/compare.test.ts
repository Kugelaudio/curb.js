import { afterEach, describe, expect, it, vi } from "vitest";
import { record, saved, turn } from "../test-fixtures/conversations.js";
import { compare, compareRuns, fisherExact, verdictOf } from "./compare.js";
import type { TestRun } from "./record.js";

const counts = (passed: number, completed: number) => ({ passed, completed, passRate: completed === 0 ? null : passed / completed });

describe("the verdict on a pass rate then and now", () => {
  it("computes Fisher's exact test, two-sided", () => {
    expect(fisherExact(0, 4, 4, 4)).toBeCloseTo(2 / 70, 6);
    expect(fisherExact(0, 3, 3, 3)).toBeCloseTo(0.1, 6);
    expect(fisherExact(1, 5, 5, 5)).toBeCloseTo(0.0476, 4);
    expect(fisherExact(3, 5, 3, 5)).toBe(1);
    expect(fisherExact(2, 10, 8, 10)).toBeCloseTo(0.023, 3);
  });

  it("is too few runs to tell when not even all failing then and all passing now would be a clear difference", () => {
    expect(verdictOf(counts(0, 1), counts(1, 1))).toEqual({ verdict: "too_few_runs", p: null });
    expect(verdictOf(counts(1, 1), counts(1, 1))).toEqual({ verdict: "too_few_runs", p: null });
    expect(verdictOf(counts(0, 3), counts(3, 3))).toEqual({ verdict: "too_few_runs", p: null });
    // A side with no completed run (only errors) says nothing.
    expect(verdictOf(counts(0, 0), counts(5, 5))).toEqual({ verdict: "too_few_runs", p: null });
  });

  it("is better or worse only when chance would make such a difference less than one time in ten", () => {
    expect(verdictOf(counts(0, 4), counts(4, 4))).toMatchObject({ verdict: "better" });
    expect(verdictOf(counts(5, 5), counts(1, 5))).toMatchObject({ verdict: "worse" });
    expect(verdictOf(counts(2, 10), counts(8, 10))).toMatchObject({ verdict: "better" });
    // 3 of 5 to 5 of 5 could be chance; so is the same rate.
    expect(verdictOf(counts(3, 5), counts(5, 5))).toMatchObject({ verdict: "no_clear_change" });
    expect(verdictOf(counts(4, 5), counts(4, 5))).toEqual({ verdict: "no_clear_change", p: 1 });
    // 0 of 4 to 3 of 4 is p = 0.143: no clear change. One failing run then against ten passing now is p = 0.091.
    expect(verdictOf(counts(0, 4), counts(3, 4))).toEqual({ verdict: "no_clear_change", p: 0.142857 });
    expect(verdictOf(counts(0, 1), counts(10, 10))).toEqual({ verdict: "better", p: 0.090909 });
  });
});

/** A saved run with the outcomes per scenario name. */
function runOf(id: string, outcomes: Record<string, Array<"pass" | "fail" | "error">>, sources = id): TestRun {
  const conversations = Object.entries(outcomes).flatMap(([name, list]) =>
    list.map((outcome, index) => {
      const conversation = saved(index + 1, outcome);
      return { ...conversation, scenario: { ...conversation.scenario, name, file: `src/agent/${name}.scenario.ts` } };
    }),
  );
  return {
    format: "curb.test-run",
    version: 1,
    id,
    createdAt: "2030-01-01T00:00:00.000Z",
    curb: "0.0.0",
    agentVersion: { commit: "3f9c2a1d8e7b6c5a", dirty: true, sources },
    complete: true,
    models: { agent: null, caller: null, judge: null },
    callerPromptVersion: "2",
    judgePromptVersion: "3",
    maxErrorRate: 0.34,
    scenarios: Object.keys(outcomes).map((name) => ({ name, file: `src/agent/${name}.scenario.ts`, mode: "simulated", runs: outcomes[name]!.length, minPassRate: 1, expectations: [], failOn: [], style: {} })),
    conversations,
  };
}

describe("compareRuns", () => {
  it("puts every scenario both runs played side by side, errors left out of the counts", () => {
    const before = runOf("a", { books: ["fail", "fail", "fail", "fail", "pass"], hello: ["pass"], gone: ["pass"] });
    const after = runOf("b", { books: ["pass", "pass", "pass", "pass", "pass", "error"], hello: ["pass"], added: ["fail"] });

    expect(compareRuns(before, after)).toEqual({
      before: { id: "a", createdAt: "2030-01-01T00:00:00.000Z", agentVersion: { commit: "3f9c2a1d8e7b6c5a", dirty: true, sources: "a" } },
      after: { id: "b", createdAt: "2030-01-01T00:00:00.000Z", agentVersion: { commit: "3f9c2a1d8e7b6c5a", dirty: true, sources: "b" } },
      scenarios: [
        { name: "books", file: "src/agent/books.scenario.ts", before: counts(1, 5), after: counts(5, 5), verdict: "better", p: expect.closeTo(0.0476, 4) },
        { name: "hello", file: "src/agent/hello.scenario.ts", before: counts(1, 1), after: counts(1, 1), verdict: "too_few_runs", p: null },
      ],
    });
  });
});

describe("compare", () => {
  afterEach(() => vi.restoreAllMocks());

  const call = (id: string, reply: string) => ({ ...record([turn({ turn: 1, caller: "My kitchen is flooded.", reply })]), id });
  const stiff = [call("old-1", "Your request has been registered."), call("old-2", "Your request has been registered."), call("old-3", "Hello.")];
  const warm = [call("new-1", "Oh no, I'm sorry."), call("new-2", "Oh no, I'm sorry."), call("new-3", "Hello.")];
  /** Prefers the call that says sorry, whichever side it is on; the same when both say the same. */
  const prefersSorry = Object.assign(
    async (system: string, input: string) => {
      const [first, second] = input.split("<<<CALL 2");
      const sorry = [first!.includes("sorry"), second!.includes("sorry")];
      return JSON.stringify({ better: sorry[0] === sorry[1] ? "same" : sorry[0] ? "1" : "2", reason: system.includes("The question: Which sounds kinder?") ? "kinder" : "?" });
    },
    { model: "test:judge" },
  );

  it("counts the wins of each side whichever order the calls are shown in", async () => {
    for (const random of [0.1, 0.9]) {
      vi.spyOn(Math, "random").mockReturnValue(random);
      const result = await compare(stiff, warm, "Which sounds kinder?", { model: prefersSorry });
      expect(result).toEqual({
        a: 0,
        b: 2,
        ties: 1,
        pairs: [
          { a: "old-1", b: "new-1", winner: "b", reason: "kinder" },
          { a: "old-2", b: "new-2", winner: "b", reason: "kinder" },
          { a: "old-3", b: "new-3", winner: "tie", reason: "kinder" },
        ],
      });
      vi.restoreAllMocks();
    }
  });

  it("shows the calls in a random order, fenced, and does not say which side is which", async () => {
    const inputs: string[] = [];
    const model = async (_system: string, input: string) => {
      inputs.push(input);
      return '{"better":"1","reason":"-"}';
    };
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const result = await compare(stiff.slice(0, 1).concat(warm.slice(0, 1)), warm.slice(0, 1).concat(stiff.slice(0, 1)), "Which sounds kinder?", { model });

    // Shown flipped first, then not: "1" is B's call, then A's.
    expect(result.pairs.map((pair) => pair.winner)).toEqual(["b", "a"]);
    expect(inputs[0]).toBe(["<<<CALL 1", "[turn 1] Caller: My kitchen is flooded.", "[turn 1] Agent: Oh no, I'm sorry.", "CALL 1>>>", "<<<CALL 2", "[turn 1] Caller: My kitchen is flooded.", "[turn 1] Agent: Your request has been registered.", "CALL 2>>>"].join("\n"));
    expect(inputs.join("\n")).not.toMatch(/old-|new-|before|after/);
  });

  it("asks once more for an answer it cannot read, then rejects; and pairs only as many calls as the shorter list holds", async () => {
    let asked = 0;
    const late = async () => (asked++ === 0 ? "hmm" : '{"better":"same","reason":"alike"}');
    expect(await compare(stiff, warm.slice(0, 1), "Which sounds kinder?", { model: late })).toMatchObject({ a: 0, b: 0, ties: 1 });
    expect(asked).toBe(2);
    await expect(compare(stiff.slice(0, 1), warm, "Which sounds kinder?", { model: async () => "no" })).rejects.toThrow("compare(): the model's answer could not be read: \"no\"");
    await expect(compare(stiff, warm, " ", { model: prefersSorry })).rejects.toThrow("compare(): give the question");
  });
});
