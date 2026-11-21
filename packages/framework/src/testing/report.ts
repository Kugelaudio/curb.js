import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME } from "../types.js";
import type { FindingStats, ScenarioResult, ScenarioRun } from "./aggregate.js";
import type { TestModels } from "./record.js";
import type { ThrottleStats } from "./resilience.js";
import { confirmationLine, toolCallLine } from "./run.js";
import type { ScenarioCheck, ScenarioTurn } from "./scenario.js";
import { styleLine } from "./style.js";
import type { RunUsage } from "./usage.js";

/**
 * A test run as people read it: the terminal report `curb test` prints, and the Markdown report
 * it writes to a file (`--report`) and to a GitHub job summary. Pure: every function turns
 * results into text.
 */

/** A scenario file that could not be loaded: reported as a failed scenario, never skipped. */
export type LoadFailure = { name: string; file: string; passed: false; error: string };

export type ScenarioReport = ScenarioResult | LoadFailure;

/** How a whole `curb test` ended, and the exit code that says so. */
export const TEST_EXIT_CODES = {
  /** Every scenario passed. */
  pass: 0,
  /** A scenario failed or could not be loaded; or there was none to run. */
  fail: 1,
  /** None failed, but too many runs of a scenario were errors to say that it passes. */
  error: 2,
} as const;

export type TestOutcome = keyof typeof TEST_EXIT_CODES;

/** What `curb test --json` prints. `passed` and `scenarios` are as they always were. */
export type TestReport = {
  passed: boolean;
  scenarios: ScenarioReport[];
  outcome: TestOutcome;
  exitCode: number;
  durationMs: number;
  /** Which model played each part, as `provider:model`. */
  models: TestModels;
  callerPromptVersion: string;
  judgePromptVersion: string;
  /** Tokens of all runs together; null when no provider reported any. */
  usage: RunUsage | null;
  /** The saved run, relative to the project; null when there was nothing to save. */
  savedTo: string | null;
  /** The run whose conversations were checked again (`--rejudge`). */
  rejudgedFrom?: string;
  /** Set when the provider's rate limit slowed the run down: how often and how long it waited,
   * and how many conversations at a time it ended on. */
  throttled?: ThrottleStats & { concurrency: number };
};

export const isResult = (report: ScenarioReport): report is ScenarioResult => "runs" in report;

/** How the whole run ended: a failure before errors. */
export function testOutcome(scenarios: readonly ScenarioReport[]): TestOutcome {
  const failed = scenarios.some((report) => ("error" in report ? true : isResult(report) && report.outcome === "fail"));
  if (failed) return "fail";
  return scenarios.some((report) => isResult(report) && report.outcome === "error") ? "error" : "pass";
}

/** One turn as the report prints it: the caller's line, how it answered an action waiting for
 * the caller's yes, the agent's tool calls and errors, and what the caller heard. A hang-up or a
 * skipped turn shows as a marker, not as its tool call. */
export function formatTurn(turn: ScenarioTurn): string {
  const lines: string[] = [];
  if (turn.caller !== null) lines.push(`caller: ${turn.caller}`);
  if (turn.confirmation) lines.push(`  ${confirmationLine(turn.confirmation)}`);
  for (const call of turn.toolCalls) {
    if (call.ok && (call.name === END_CALL_TOOL_NAME || call.name === SKIP_TURN_TOOL_NAME)) continue;
    lines.push(`  ${toolCallLine(call)}`);
  }
  for (const error of turn.errors) lines.push(`  [error ${error.kind}] ${error.message}`);
  lines.push(`agent:  ${turn.reply || (turn.skipped ? "(silent: skip_turn)" : "(no reply)")}`);
  if (turn.endedCall) lines.push("  [the agent ended the call]");
  return `${lines.join("\n")}\n`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const percent = (share: number | null) => (share === null ? "n/a" : `${Math.round(share * 100)}%`);
const callerTurns = (turns: readonly ScenarioTurn[]) => turns.filter((turn) => turn.caller !== null).length;
const VERDICT = { pass: "PASS", fail: "FAIL", error: "ERROR" } as const;

/** Where the judge pointed: `turn 3 "the words"`, or as much of it as it gave, and for a
 * question asked again the turn in which the caller had answered it. */
function evidenceText(turn: number | null, quote: string | null, earlierTurn?: number): string {
  const said = earlierTurn === undefined ? "" : `after the caller said it in turn ${earlierTurn}`;
  return [turn === null ? "" : `turn ${turn}`, quote ? JSON.stringify(quote) : "", said].filter(Boolean).join(" ");
}

/** How a check's line starts: a check the judge never answered is neither passed nor failed. */
const checkMark = (check: ScenarioCheck) => (check.notJudged ? "skip" : check.pass ? "pass" : "FAIL");

function checkLines(checks: readonly ScenarioCheck[]): string[] {
  return checks.flatMap((check) => {
    const [first = "", ...more] = (check.detail ?? "").split("\n");
    const pointed = check.evidence ? evidenceText(check.evidence.turn, check.evidence.quote) : "";
    return [
      `  ${checkMark(check)}  ${check.name}${first ? `: ${first}` : ""}${pointed ? ` (${pointed})` : ""}`,
      ...more.map((line) => `        ${line}`),
    ];
  });
}

/** One line per built-in finding the judge found in a run, with the turn and words that show it. */
function findingLines(run: Pick<ScenarioRun, "judge">): string[] {
  return (run.judge?.answers ?? [])
    .filter((answer) => answer.kind === "finding" && answer.answer === "yes")
    .map((answer) => `  find  ${answer.id}: ${evidenceText(answer.turn, answer.quote, answer.earlierTurn)} (${answer.reason})`);
}

/** The verdict line of a scenario: its outcome, and for an error the reason. */
function verdictLine(result: ScenarioResult, counted: string): string {
  const shown = result.runs.length === 1 ? result.runs[0] : undefined;
  const why = shown?.error ? `: ${shown.error.kind}: ${shown.error.message}` : "";
  return `${VERDICT[result.outcome]} ${result.name} (${counted}, ${seconds(result.durationMs)})${why}`;
}

/** The report of a scenario that ran once, after its transcript: every check (a detail's further
 * lines indented under it), the judge's findings, the notes, then the scenario's verdict. */
export function formatChecks(result: ScenarioResult): string {
  const lines = [
    ...checkLines(result.checks),
    ...result.runs.flatMap(findingLines),
    ...result.notes.map((note) => `  note  ${note}`),
    verdictLine(result, `${callerTurns(result.turns)} caller turn(s)`),
  ];
  return `${lines.join("\n")}\n`;
}

/** One line for a finished run of a scenario that runs more than once. */
export function formatRunLine(run: ScenarioRun, runs: number): string {
  const head = `  run ${run.run}/${runs}`;
  const took = `(${callerTurns(run.turns)} caller turn(s), ${seconds(run.durationMs)})`;
  if (run.outcome === "pass") return `${head}  pass   ${took}\n`;
  if (run.error) return `${head}  error  ${run.error.kind}: ${run.error.message} ${took}\n`;
  const failed = run.checks.filter((check) => !check.pass && !check.notJudged).map((check) => check.name);
  return `${head}  FAIL   ${failed.join("; ")} ${took}\n`;
}

function runsLine(result: ScenarioResult): string {
  const { stats } = result;
  const completed = stats.passed + stats.failed;
  const parts = [
    `${stats.passed} of ${completed} completed run(s) passed (${percent(stats.passRate)})`,
    `needs ${percent(stats.minPassRate)}`,
    ...(stats.reliability === null ? [] : [`pass^${stats.runs} ${percent(stats.reliability)}`]),
    ...(stats.errors > 0 ? [`${stats.errors} error(s) (${percent(stats.errorRate)} of ${stats.ran}, at most ${percent(stats.maxErrorRate)})`] : []),
  ];
  return `  runs  ${parts.join(", ")}`;
}

function findingStatLine(finding: FindingStats): string {
  const [example] = finding.examples;
  const shown = example ? `, e.g. run ${example.run} ${evidenceText(example.turn, example.quote, example.earlierTurn)} (${example.reason})` : "";
  return `  find  ${finding.id}: ${finding.found} of ${finding.total} judged run(s) (${percent(finding.rate)})${shown}`;
}

/** A run's transcript and what failed in it, as a repeated scenario's report shows it. */
function runTranscript(run: ScenarioRun): string[] {
  const failed = run.checks.filter((check) => !check.pass);
  return [
    `  --- run ${run.run} (${run.error ? `error: ${run.error.kind}` : run.outcome})`,
    ...run.turns.flatMap((turn) => formatTurn(turn).trimEnd().split("\n")).map((line) => `  ${line}`),
    ...(run.error ? [`  error ${run.error.kind}: ${run.error.message}`] : []),
    ...checkLines(failed),
    ...findingLines(run),
  ];
}

/** Longest list of failed transcripts a repeated scenario prints; every run is in the saved run. */
const MAX_TRANSCRIPTS = 3;

/**
 * The report of a scenario that ran more than once, after its run lines: the rates, every check
 * with how many runs passed it, the judge's findings with theirs, the variants, the notes, the
 * transcripts of the first runs that did not pass, and the verdict.
 */
export function formatRepeated(result: ScenarioResult): string {
  const { stats } = result;
  const notPassed = result.runs.filter((run) => run.outcome !== "pass");
  const variants = result.variants.map((variant) => `${variant.experiment}=${variant.variant} ${variant.passed}/${variant.passed + variant.failed}${variant.errors > 0 ? ` (+${variant.errors} error(s))` : ""}`);
  const lines = [
    runsLine(result),
    ...result.checkStats.map((check) => {
      const unknown = check.unknown > 0 ? `, ${check.unknown} unknown` : "";
      return `  ${check.passed === check.total ? "pass" : "FAIL"}  ${check.name}: ${check.passed}/${check.total} (${percent(check.passRate)}${unknown})`;
    }),
    ...checkLines(result.checks.filter((check) => check.name.startsWith("style: "))),
    ...result.findings.filter((finding) => finding.found > 0).map(findingStatLine),
    ...(variants.length > 0 ? [`  variants passed  ${variants.join(" · ")}`] : []),
    ...result.notes.map((note) => `  note  ${note}`),
    ...notPassed.slice(0, MAX_TRANSCRIPTS).flatMap(runTranscript),
    ...(notPassed.length > MAX_TRANSCRIPTS ? [`  note  ${notPassed.length - MAX_TRANSCRIPTS} more run(s) did not pass; the saved run has every transcript`] : []),
    verdictLine(result, `${result.flaky ? "flaky: " : ""}${stats.passed}/${stats.passed + stats.failed} run(s) passed`),
  ];
  return `${lines.join("\n")}\n`;
}

const count = (value: number) => value.toLocaleString("en-US");

/** The tokens of a run on one line; empty when no provider reported any. */
export function usageLine(usage: RunUsage | null): string {
  if (!usage) return "";
  const parts = (["agent", "caller", "judge"] as const).flatMap((role) => {
    const used = usage[role];
    return used ? [`${role} ${count(used.inputTokens + used.cacheReadTokens + used.cacheWriteTokens)} in / ${count(used.outputTokens)} out`] : [];
  });
  return `${count(usage.totalTokens)} tokens (${parts.join(" · ")})`;
}

/** Why a run took longer than its conversations: the provider rate limited it. */
export function throttledLine(throttled: NonNullable<TestReport["throttled"]>): string {
  const { waits, waitedMs, concurrency } = throttled;
  return `Slowed down by the provider's rate limit: ${waits} wait(s), ${Math.round(waitedMs / 1000)} s, then ${concurrency} conversation(s) at a time.`;
}

const named = (reports: readonly ScenarioReport[]) => reports.map((report) => `${report.name} (${report.file})`).join(", ");

/** What ends the terminal report: the style numbers, the tokens, where the run is saved, and
 * one line that sorts the scenarios into passed, failed every run, flaky, and not assessed. */
export function formatSummary(report: TestReport): string {
  const results = report.scenarios.filter(isResult);
  const lines: string[] = [""];
  if (results.some((result) => result.style.replies > 0)) {
    lines.push("Style (counted from the agent's replies):", ...results.map((result) => `  ${result.name}: ${styleLine(result.style)}`));
  }
  const tokens = usageLine(report.usage);
  if (tokens) lines.push(`Tokens: ${tokens}`);
  if (report.throttled) lines.push(throttledLine(report.throttled));
  if (report.savedTo) lines.push(`Saved: ${report.savedTo} (check it again without running the agent: npx curb test --rejudge latest)`);
  if (lines.length > 1) lines.push("");

  // A flaky scenario is listed as flaky whether its rate was enough to pass or not.
  const sorted = { passed: [] as ScenarioReport[], failed: [] as ScenarioReport[], flaky: [] as ScenarioResult[], unassessed: [] as ScenarioReport[] };
  for (const entry of report.scenarios) {
    if (entry.passed) sorted.passed.push(entry);
    if (isResult(entry) && entry.flaky) sorted.flaky.push(entry);
    else if (isResult(entry) && entry.outcome === "error") sorted.unassessed.push(entry);
    else if (!entry.passed) sorted.failed.push(entry);
  }
  const parts = [
    `${sorted.passed.length} of ${report.scenarios.length} scenario(s) passed in ${seconds(report.durationMs)}.`,
    ...(sorted.failed.length > 0 ? [`Failed: ${named(sorted.failed)}`] : []),
    ...(sorted.flaky.length > 0
      ? [`Flaky (passed on some runs, failed on others): ${sorted.flaky.map((result) => `${result.name} (${result.file}) ${result.stats.passed}/${result.stats.passed + result.stats.failed}`).join(", ")}`]
      : []),
    ...(sorted.unassessed.length > 0 ? [`Not assessed (too many errors): ${named(sorted.unassessed)}`] : []),
  ];
  lines.push(parts.join(" "));
  return `${lines.join("\n")}\n`;
}

const cell = (text: string) => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function outcomeCell(report: ScenarioReport): string {
  if ("error" in report) return "fail (not loaded)";
  return report.flaky && !report.passed ? "fail (flaky)" : report.flaky ? "pass (flaky)" : report.outcome;
}

/** The transcripts of the runs that did not pass, folded, for one scenario. */
function markdownRuns(result: ScenarioResult): string[] {
  return result.runs
    .filter((run) => run.outcome !== "pass")
    .slice(0, MAX_TRANSCRIPTS)
    .flatMap((run) => [
      "<details>",
      `<summary>Run ${run.run}: ${run.error ? `error (${run.error.kind})` : run.outcome}</summary>`,
      "",
      "```text",
      ...runTranscript(run).slice(1).map((line) => line.replace(/^ {2}/, "")),
      "```",
      "",
      "</details>",
      "",
    ]);
}

/**
 * The run as Markdown: one table of every scenario with its rates, then, for each scenario that
 * did not simply pass, its checks, the judge's findings and the transcripts of the runs that
 * did not pass, then the style numbers and the tokens.
 */
export function markdownReport(report: TestReport): string {
  const results = report.scenarios.filter(isResult);
  const lines = [
    `## curb test: ${report.outcome === "pass" ? "passed" : report.outcome === "fail" ? "failed" : "too many errors"}`,
    "",
    `${report.scenarios.filter((entry) => entry.passed).length} of ${report.scenarios.length} scenario(s) passed in ${seconds(report.durationMs)}.`,
    "",
    "| Scenario | Outcome | Runs passed | Pass rate | pass^k | Errors |",
    "|---|---|---|---|---|---|",
    ...report.scenarios.map((entry) => {
      if (!isResult(entry)) return `| ${cell(entry.name)} | ${outcomeCell(entry)} | | | | |`;
      const { stats } = entry;
      return `| ${cell(entry.name)} | ${outcomeCell(entry)} | ${stats.passed}/${stats.passed + stats.failed} | ${percent(stats.passRate)} | ${percent(stats.reliability)} | ${stats.errors} |`;
    }),
    "",
  ];

  for (const entry of report.scenarios) {
    if ("error" in entry) lines.push(`### ${entry.name}`, "", entry.error, "");
    else if (!entry.passed || entry.flaky || entry.findings.some((finding) => finding.found > 0)) {
      lines.push(`### ${entry.name}`, "", `\`${entry.file}\`, ${runsLine(entry).replace(/^ {2}runs {2}/, "")}`, "");
      const failing = entry.checkStats.filter((check) => check.passed < check.total);
      if (failing.length > 0) {
        lines.push("| Check | Runs passed |", "|---|---|", ...failing.map((check) => `| ${cell(check.name)} | ${check.passed}/${check.total} |`), "");
      }
      const found = entry.findings.filter((finding) => finding.found > 0);
      if (found.length > 0) {
        lines.push(
          "| Judge finding | Runs | Evidence |",
          "|---|---|---|",
          ...found.map((finding) => {
            const [example] = finding.examples;
            const evidence = example ? `run ${example.run} ${evidenceText(example.turn, example.quote, example.earlierTurn)}: ${example.reason}` : "";
            return `| ${finding.id} | ${finding.found}/${finding.total} | ${cell(evidence)} |`;
          }),
          "",
        );
      }
      lines.push(...markdownRuns(entry));
    }
  }

  if (results.some((result) => result.style.replies > 0)) {
    lines.push("### Style", "", "| Scenario | Counted from the agent's replies |", "|---|---|", ...results.map((result) => `| ${cell(result.name)} | ${cell(styleLine(result.style))} |`), "");
  }
  const models = (["agent", "caller", "judge"] as const).flatMap((role) => (report.models[role] ? [`${role} ${report.models[role]}`] : []));
  const footer = [
    ...(usageLine(report.usage) ? [usageLine(report.usage)] : []),
    ...(models.length > 0 ? [`models: ${models.join(", ")}`] : []),
    `judge prompt ${report.judgePromptVersion}, caller prompt ${report.callerPromptVersion}`,
    ...(report.savedTo ? [`saved to \`${report.savedTo}\``] : []),
  ];
  if (report.throttled) lines.push(throttledLine(report.throttled), "");
  lines.push(footer.join(" · "), "");
  return lines.join("\n");
}
