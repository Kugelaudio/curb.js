import { describe, expect, it } from "vitest";
import type { TestHost } from "../../testing/index.js";
import { refusedRun, withTokenLimit } from "./token-limit.js";
import type { SavedConversation } from "./types.js";

/** A host whose simulated callers answer "Bye." for 10 tokens a request. */
const host = {
  async createBundle() {
    throw new Error("no agent in this test");
  },
  simulator: (_llm, _role, onUsage) => async () => {
    onUsage({ inputTokens: 8, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    return { text: "Bye.", toolCalls: [] };
  },
} as TestHost;

const ask = (limited: TestHost) => limited.simulator({ provider: "openai", model: "m" } as never, "caller", () => {})({} as never);

describe("--max-tokens and the run a refusal came from", () => {
  it("counts a refusal against its run, even when the caller catches it", async () => {
    const limit = withTokenLimit(host, 10, () => "over the limit");
    const first = await limit.track(async () => {
      await ask(limit.host);
      return "spent";
    });
    expect(first).toEqual({ value: "spent", refused: null });
    // As a simulated caller does after the agent hung up: the request fails and nothing shows it.
    const second = await limit.track(async () => {
      await ask(limit.host).catch(() => null);
      return "caught";
    });
    expect(second).toEqual({ value: "caught", refused: "over the limit" });
    expect(limit.refused()).toBe(1);
  });

  it("keeps the runs played side by side apart", async () => {
    const limit = withTokenLimit(host, 10, () => "over the limit");
    await ask(limit.host);
    const [asked, quiet] = await Promise.all([
      limit.track(() => ask(limit.host).catch(() => null)),
      limit.track(async () => "nothing asked"),
    ]);
    expect(asked.refused).toBe("over the limit");
    expect(quiet.refused).toBeNull();
  });

  it("makes a run that needed a refused request an error, whatever its checks found", () => {
    const passed = { assessment: { outcome: "pass", checks: [], notes: [], judge: null } } as unknown as SavedConversation;
    expect(refusedRun(passed, null)).toBe(passed);
    expect(refusedRun(passed, "over the limit").assessment).toMatchObject({ outcome: "error", error: { kind: "provider", message: "over the limit" } });
  });
});
