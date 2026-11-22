import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Finding } from "./judge.js";
import type { RunOutcome } from "./record.js";
import type { ScenarioCheck } from "./scenario.js";

/**
 * Results, from any code, as CI reads them: the pass rate of many runs, and a reporter that
 * prints named groups of checks and findings for the terminal, as Markdown, in the GitHub job
 * summary and as JSON, and returns the exit code.
 */

/** A check that counts against the agent: it failed, and it is neither report-only nor unjudged. */
const counts = (check: ScenarioCheck) => !check.pass && !check.reportOnly && !check.notJudged;

const rate = (count: number, total: number) => Math.round((count / total) * 1000) / 1000;

export type PassRate = {
  runs: number;
  passed: number;
  failed: number;
  /** Runs that say nothing about the agent: in neither rate. */
  errors: number;
  /** passed / (passed + failed); null when no run completed. */
  passRate: number | null;
  /** passRate to the power of `runs`: the chance that every one of that many runs passes. */
  reliability: number | null;
  /** errors / runs. */
  errorRate: number;
};

/**
 * The pass rate of runs, each given as its outcome ("pass", "fail" or "error") or as its checks
 * (a pass when no check failed that is neither `reportOnly` nor `notJudged`). Rates are
 * rounded to three places.
 */
export function passRate(results: ReadonlyArray<RunOutcome | readonly ScenarioCheck[]>): PassRate {
  const outcomes = results.map((result): RunOutcome => (typeof result === "string" ? result : result.some(counts) ? "fail" : "pass"));
  const passed = outcomes.filter((outcome) => outcome === "pass").length;
  const failed = outcomes.filter((outcome) => outcome === "fail").length;
  const errors = outcomes.length - passed - failed;
  const completed = passed + failed;
  const share = completed === 0 ? null : rate(passed, completed);
  return {
    runs: outcomes.length,
    passed,
    failed,
    errors,
    passRate: share,
    reliability: share === null ? null : rate(share ** outcomes.length, 1),
    errorRate: outcomes.length === 0 ? 0 : rate(errors, outcomes.length),
  };
}

/** One named group of results: a test case, a scenario, a call. A group with an `error` could
 * not be assessed. */
export type ReportGroup = {
  name: string;
  checks?: readonly ScenarioCheck[];
  findings?: readonly Finding[];
  notes?: readonly string[];
  error?: string;
};

export type ReportOptions = {
  /** The heading of the Markdown report. Default: "Test report". */
  title?: string;
  /** Print one JSON object instead of the terminal report. */
  json?: boolean;
  /** Also write the report as Markdown to this file. */
  markdown?: string;
  /** Where the report is printed. Default: stdout. */
  out?: (text: string) => void;
  /** Where `GITHUB_STEP_SUMMARY` is read from. Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
};

type Outcome = "pass" | "fail" | "error";
const outcomeOf = (group: ReportGroup): Outcome => ((group.checks ?? []).some(counts) ? "fail" : group.error !== undefined ? "error" : "pass");
const EXIT = { pass: 0, fail: 1, error: 2 } as const;
const MARK = (check: ScenarioCheck) => (check.notJudged ? "skip" : check.reportOnly ? "info" : check.pass ? "pass" : "FAIL");
const VERDICT = { pass: "PASS", fail: "FAIL", error: "ERROR" } as const;

function evidence(turn: number | null | undefined, quote: string | null | undefined): string {
  return [turn === null || turn === undefined ? "" : `turn ${turn}`, quote ? JSON.stringify(quote) : ""].filter(Boolean).join(" ");
}

/**
 * `text` on one line: each line break, with the spaces around it, becomes one space. Split and
 * trimmed rather than matched with one pattern, which could take long on text that holds very
 * many spaces in a row.
 */
export function onOneLine(text: string): string {
  const parts = text.split("\n");
  if (parts.length === 1) return text;
  const last = parts.length - 1;
  return parts
    .map((part, index) => (index === 0 ? part.trimEnd() : index === last ? part.trimStart() : part.trim()))
    .filter((part, index) => index === 0 || index === last || part !== "")
    .join(" ");
}

function checkLine(check: ScenarioCheck): string {
  const shown = evidence(check.evidence?.turn, check.evidence?.quote);
  return `${check.name}${check.detail ? `: ${onOneLine(check.detail)}` : ""}${shown ? ` (${shown})` : ""}`;
}

const findingLine = (finding: Finding) => `${finding.kind}: call ${finding.call}${evidence(finding.turn, finding.quote) ? ` ${evidence(finding.turn, finding.quote)}` : ""} (${finding.reason})`;

const cell = (text: string) => onOneLine(text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"));

function markdownOf(groups: readonly ReportGroup[], title: string, outcome: Outcome): string {
  const lines = [
    `## ${title}: ${outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "too many errors"}`,
    "",
    `${groups.filter((group) => outcomeOf(group) === "pass").length} of ${groups.length} passed.`,
    "",
    "| Name | Outcome | Checks passed | Findings |",
    "|---|---|---|---|",
    ...groups.map((group) => {
      const checks = group.checks ?? [];
      return `| ${cell(group.name)} | ${outcomeOf(group)} | ${checks.filter((check) => check.pass).length}/${checks.length} | ${(group.findings ?? []).length} |`;
    }),
    "",
  ];
  for (const group of groups) {
    const failed = (group.checks ?? []).filter((check) => !check.pass);
    if (failed.length === 0 && !group.error && !(group.findings ?? []).length) continue;
    lines.push(`### ${group.name}`, "");
    if (group.error) lines.push(`Error: ${group.error}`, "");
    lines.push(...failed.map((check) => `- ${MARK(check)}: ${cell(checkLine(check))}`), ...(group.findings ?? []).map((finding) => `- finding ${cell(findingLine(finding))}`), "");
  }
  return lines.join("\n");
}

/**
 * Report results and return the exit code: 0 when every group passed, 1 when a check failed
 * (one that is neither `reportOnly` nor `notJudged`), 2 when none failed but a group has an
 * `error`. Prints each group with its checks, findings and notes (or one JSON object with
 * `json`), writes the Markdown report to `markdown` when given, and appends it to the GitHub job
 * summary when `GITHUB_STEP_SUMMARY` is set.
 *
 *   process.exitCode = report([{ name: "books a haircut", checks }]);
 */
export function report(groups: readonly ReportGroup[], options: ReportOptions = {}): 0 | 1 | 2 {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const env = options.env ?? process.env;
  const outcomes = groups.map(outcomeOf);
  const outcome: Outcome = outcomes.includes("fail") ? "fail" : outcomes.includes("error") ? "error" : "pass";
  if (options.json) {
    const shown = groups.map((group, index) => ({ ...group, outcome: outcomes[index] }));
    out(`${JSON.stringify({ passed: outcome === "pass", outcome, exitCode: EXIT[outcome], groups: shown })}\n`);
  } else {
    const lines = groups.flatMap((group, index) => [
      `--- ${group.name}`,
      ...(group.checks ?? []).map((check) => `  ${MARK(check)}  ${checkLine(check)}`),
      ...(group.findings ?? []).map((finding) => `  find  ${findingLine(finding)}`),
      ...(group.notes ?? []).map((note) => `  note  ${note}`),
      `${VERDICT[outcomes[index]!]} ${group.name}${group.error ? `: ${group.error}` : ""}`,
      "",
    ]);
    out(`${lines.join("\n")}${outcomes.filter((entry) => entry === "pass").length} of ${groups.length} passed.\n`);
  }
  const markdown = options.markdown !== undefined || env.GITHUB_STEP_SUMMARY ? markdownOf(groups, options.title ?? "Test report", outcome) : "";
  if (options.markdown !== undefined) {
    const file = resolve(options.markdown);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, markdown);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return EXIT[outcome];
}
