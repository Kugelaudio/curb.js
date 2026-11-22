import { describe, expect, it } from "vitest";
import { TokenCounter } from "./usage.js";

describe("token usage", () => {
  it("adds up what the provider reports, and is null while it reported nothing", () => {
    const counter = new TokenCounter();
    counter.add({ inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined });
    expect(counter.total()).toBeNull();
    counter.add({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: undefined });
    counter.add({ inputTokens: 50, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: 10 });
    expect(counter.total()).toEqual({ inputTokens: 150, outputTokens: 25, cacheReadTokens: 300, cacheWriteTokens: 10 });
  });
});
