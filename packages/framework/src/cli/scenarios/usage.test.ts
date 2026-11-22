import { describe, expect, it } from "vitest";
import { runUsage, sumUsage } from "./usage.js";

describe("token usage", () => {
  it("sums a run per role, and several runs together", () => {
    const agent = { inputTokens: 150, outputTokens: 25, cacheReadTokens: 300, cacheWriteTokens: 10 };
    const judge = { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const run = runUsage({ agent, caller: null, judge });
    expect(run).toEqual({ agent, caller: null, judge, totalTokens: 535 });
    expect(runUsage({ agent: null, caller: null, judge: null })).toBeNull();
    expect(sumUsage([run, null, run])).toMatchObject({ agent: { inputTokens: 300 }, caller: null, judge: { outputTokens: 20 }, totalTokens: 1070 });
    expect(sumUsage([null])).toBeNull();
  });
});
