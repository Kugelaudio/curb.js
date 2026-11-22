/** The most runs one scenario may ask for, in its `runs` or through `curb test --runs`. */
export const MAX_RUNS = 100;

/** What is wrong with `value` as a number of runs, or undefined. */
export function runsProblem(value: unknown): string | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_RUNS
    ? undefined
    : `must be a whole number of runs from 1 to ${MAX_RUNS}; got ${JSON.stringify(value) ?? String(value)}.`;
}
