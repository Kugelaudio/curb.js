import { describe, expect, it } from "vitest";
import { TokenCounter, runUsage, sumUsage } from "./usage.js";

describe("token usage", () => {
  it("adds up what the provider reports, and is null while it reported nothing", () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined });
    expect(counter.total()).toBeNull();
    counter.add({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: undefined });
    counter.add({ inputTokens: 50, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: 10 });
    expect(counter.total()).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 300, cacheWriteTokens: 10 });
  });

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
