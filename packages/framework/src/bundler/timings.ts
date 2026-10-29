/**
 * Where `curb build` spends its wall clock, measured by the build itself.
 *
 * Whoever dispatches this build can only see how long the whole of it took, and the
 * per-stage breakdown is the thing it cannot obtain from outside. This module is that
 * breakdown.
 *
 * Two properties are deliberate:
 *
 *   - it is printed by every build, not behind a flag. A number nobody opts into is a
 *     number nobody has;
 *   - it touches nothing the artifact is made of. Every duration lives in memory and
 *     reaches stdout only after the tree is finished and hashed. A timing written into
 *     the bundle would be a build timestamp inside the digested bytes, which is exactly
 *     what reproducibility.ts checks for --
 *     two builds of one revision would stop agreeing on their treeDigest.
 */

export type StageTiming = {
  /** Stage label, as printed. */
  stage: string;
  /** Wall-clock milliseconds. */
  ms: number;
  /** What the stage did, in the words the build's own summary uses. */
  detail: string;
};

export type BuildTimer = {
  /**
   * Close the stage that has been running since the last boundary.
   *
   * A boundary marker rather than a wrapper around each stage: the build's steps share
   * a long chain of local bindings, and wrapping them in closures would restructure the
   * one file whose ORDER is the load-bearing thing about it.
   */
  mark(stage: string, detail: string): void;
  /**
   * Adopt a duration measured somewhere else, and treat the time up to now as accounted
   * for. `verify.ts` times its own phases because only it knows where one child process
   * ends and the next begins.
   */
  record(stage: string, ms: number, detail: string): void;
  /**
   * Every stage in the order it ran.
   *
   * Plus, when it is large enough to print, the remainder: total wall clock minus what
   * the stages claim. It is shown rather than folded into a neighbour because a growing
   * remainder means the boundaries have drifted from what the build now does, and a
   * breakdown that always sums to exactly 100% cannot say so.
   */
  finish(): StageTiming[];
};

/** Below this the remainder is rounding, not a stage nobody named. */
const REMAINDER_FLOOR_MS = 50;

export function startBuildTimer(now: () => number = Date.now): BuildTimer {
  const startedAt = now();
  let boundary = startedAt;
  const timings: StageTiming[] = [];

  return {
    mark(stage, detail) {
      const at = now();
      timings.push({ stage, ms: at - boundary, detail });
      boundary = at;
    },
    record(stage, ms, detail) {
      timings.push({ stage, ms, detail });
      boundary = now();
    },
    finish() {
      const total = now() - startedAt;
      const claimed = timings.reduce((sum, timing) => sum + timing.ms, 0);
      const remainder = total - claimed;
      if (remainder < REMAINDER_FLOOR_MS) return [...timings];
      return [
        ...timings,
        { stage: "other", ms: remainder, detail: "the small steps between the stages above" },
      ];
    },
  };
}

/** One decimal, because the stages that matter here are seconds and the rest are noise. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The block a build prints, in the shape of the summary that follows it: two-space
 * indent, one stage per line, longest thing on the right.
 *
 * The share is printed next to the duration because the question this exists to answer
 * -- "is verifying the artifact more than half of the build" -- is a question about
 * proportions, and a reader should not have to do the division.
 */
export function formatBuildTimings(timings: readonly StageTiming[]): string {
  const total = timings.reduce((sum, timing) => sum + timing.ms, 0);
  const width = timings.reduce((longest, timing) => Math.max(longest, timing.stage.length), 0);
  const lines = [`\ncurb build stages -> ${seconds(total)} total`];
  for (const timing of timings) {
    const share = total > 0 ? Math.round((timing.ms / total) * 100) : 0;
    lines.push(
      `  ${seconds(timing.ms).padStart(6)}  ${`${share}%`.padStart(4)}  ` +
        `${timing.stage.padEnd(width)}  ${timing.detail}`,
    );
  }
  return lines.join("\n");
}
