import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compareRuns, loadRun, type RunComparison, type TestRun } from "../../testing/index.js";

/**
 * Did the change help? After a run, `curb test` compares it with the newest earlier run of
 * another version of the agent that played every scenario this one did, and prints a few lines:
 * per scenario its pass rate then and now, and a verdict that says no more than the counts carry.
 */

const key = (scenario: { file: string; name: string }) => `${scenario.file}\n${scenario.name}`;

/**
 * The comparison of `after`, the run just saved at `savedTo` (relative to the project), with the
 * newest earlier run that is complete, no re-judge, played every scenario `after` played (by file
 * and name), and has another hash of the agent's sources. Undefined when `after` has no hash
 * (outside a git repository) or no saved run qualifies.
 */
export function sinceLastVersion(projectRoot: string, savedTo: string, after: TestRun): RunComparison | undefined {
  const sources = after.agentVersion?.sources;
  if (!sources) return undefined;
  const directory = dirname(resolve(projectRoot, savedTo));
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    // KEEP-JUSTIFIED: no directory IS the answer "no earlier run"; nothing is printed.
    return undefined;
  }
  const ids = names.map((name) => name.slice(0, -".json".length)).filter((id) => id < after.id).sort().reverse();
  const wanted = after.scenarios.map(key);
  for (const id of ids) {
    let before: TestRun;
    try {
      before = loadRun(id, { root: projectRoot });
    } catch {
      // KEEP-JUSTIFIED: a file that is no run this version reads is no earlier version to compare with.
      continue;
    }
    const played = new Set(before.scenarios.map(key));
    const other = before.agentVersion?.sources !== undefined && before.agentVersion.sources !== sources;
    if (!before.complete || before.rejudgedFrom !== undefined || !other || !wanted.every((scenario) => played.has(scenario))) continue;
    const comparison = compareRuns(before, after);
    return comparison.scenarios.length > 0 ? comparison : undefined;
  }
  return undefined;
}

const VERDICTS: Record<RunComparison["scenarios"][number]["verdict"], string> = {
  better: "better",
  worse: "worse",
  no_clear_change: "no clear change",
  too_few_runs: "too few runs to tell",
};

/** How long ago `then` was, in the largest whole unit. */
export function ago(then: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(then)) / 60_000);
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"} ago`;
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return unit(minutes, "minute");
  if (minutes < 48 * 60) return unit(Math.floor(minutes / 60), "hour");
  return unit(Math.floor(minutes / (24 * 60)), "day");
}

/** The earlier run as the heading names it: its id, its commit or "uncommitted changes", and its age. */
function heading(comparison: RunComparison, now: number): string {
  const version = comparison.before.agentVersion;
  const what = version === null ? "no version" : version.dirty ? "uncommitted changes" : version.commit.slice(0, 7);
  return `Since ${comparison.before.id} (${what}, ${ago(comparison.before.createdAt, now)})`;
}

const rate = ({ passed, completed }: { passed: number; completed: number }) =>
  `${passed}/${completed}${completed === 0 ? "" : ` (${Math.round((passed / completed) * 100)}%)`}`;

/** The comparison as the terminal prints it: a heading, then one line per scenario. */
export function formatSince(comparison: RunComparison, now = Date.now()): string[] {
  const width = Math.max(...comparison.scenarios.map((scenario) => scenario.name.length));
  const then = Math.max(...comparison.scenarios.map((scenario) => rate(scenario.before).length));
  return [
    `${heading(comparison, now)}:`,
    ...comparison.scenarios.map(
      (scenario) => `  ${scenario.name.padEnd(width)}  ${rate(scenario.before).padEnd(then)} -> ${rate(scenario.after)}  ${VERDICTS[scenario.verdict]}`,
    ),
  ];
}

/** The comparison as the Markdown report holds it. */
export function markdownSince(comparison: RunComparison, cell: (text: string) => string, now = Date.now()): string[] {
  return [
    `### ${heading(comparison, now)}`,
    "",
    "| Scenario | Then | Now | Verdict |",
    "|---|---|---|---|",
    ...comparison.scenarios.map((scenario) => `| ${cell(scenario.name)} | ${rate(scenario.before)} | ${rate(scenario.after)} | ${VERDICTS[scenario.verdict]} |`),
    "",
  ];
}
