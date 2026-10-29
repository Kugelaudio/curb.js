import { describe, expect, it } from "vitest";
import { formatBuildTimings, startBuildTimer } from "./timings.js";

/**
 * The timer is fed a fake clock rather than measured against a real one: a test that
 * asserts on wall clock asserts on the machine it runs on, and this file is about the
 * bookkeeping -- boundaries, the remainder, the shares -- not about how fast anything is.
 */
function clockFrom(ticks: number[]): () => number {
  let index = 0;
  return () => ticks[Math.min(index++, ticks.length - 1)];
}

describe("startBuildTimer", () => {
  it("attributes each stage the time since the previous boundary", () => {
    // start, mark a, mark b, finish
    const timer = startBuildTimer(clockFrom([0, 1_000, 3_500, 3_500]));
    timer.mark("a", "first");
    timer.mark("b", "second");
    expect(timer.finish()).toEqual([
      { stage: "a", ms: 1_000, detail: "first" },
      { stage: "b", ms: 2_500, detail: "second" },
    ]);
  });

  it("adopts a duration measured elsewhere without double counting the next stage", () => {
    // start, record (boundary <- 5_000), mark c, finish
    const timer = startBuildTimer(clockFrom([0, 5_000, 6_000, 6_000]));
    timer.record("verify", 4_000, "measured inside verify.ts");
    timer.mark("c", "after");
    expect(timer.finish()).toEqual([
      { stage: "verify", ms: 4_000, detail: "measured inside verify.ts" },
      { stage: "c", ms: 1_000, detail: "after" },
      // 6_000 total, 5_000 claimed: the second the recorded phases did not account for
      // is shown rather than folded into a neighbour.
      { stage: "other", ms: 1_000, detail: "the small steps between the stages above" },
    ]);
  });

});
