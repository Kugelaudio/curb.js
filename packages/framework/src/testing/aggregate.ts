import type { ScenarioEndedBy } from "./checks.js";
import type { JudgeResult } from "./judge.js";
import type { ConversationEnding, EndState, RunError, RunOutcome, SavedConversation, SavedScenarioSettings } from "./record.js";
import { JUDGE_FINDINGS, type JudgeFinding, type ScenarioCheck, type ScenarioTurn } from "./scenario.js";
import { styleLimitLine, styleReport, type StyleReport } from "./style.js";
import { sumUsage, type RunUsage } from "./usage.js";

/**
 * A scenario's runs as one result: how many passed, how reliable that makes it, which checks
 * and judge findings came up how often, per experiment variant as well as overall. Pure: it
 * reads finished conversations, so a live run and a re-judged one are summed up the same way.
 */

/** One run of a scenario: its conversation, and what the checks and the judge made of it. */
export type ScenarioRun = {
  /** 1 for the first run. */
  run: number;
  outcome: RunOutcome;
  /** Set when `outcome` is "error". */
  error?: RunError;
  passed: boolean;
  endedBy: ScenarioEndedBy;
  durationMs: number;
  turns: ScenarioTurn[];
  checks: ScenarioCheck[];
  notes: string[];
  /** The variant the call had in each of the agent's experiments. */
  experiments: Record<string, string>;
  ending: ConversationEnding;
  endState: EndState | null;
  judge: JudgeResult | null;
  usage: RunUsage | null;
};

export type ScenarioStats = {
  /** The runs the scenario asked for. */
  runs: number;
  /** The runs that ran: passed, failed and errors together. */
  ran: number;
  passed: number;
  failed: number;
  /** Runs that say nothing about the agent; they are in neither rate below. */
  errors: number;
  /** passed / (passed + failed); null when no run completed. */
  passRate: number | null;
  /** passRate to the power of `runs`: the chance that every one of that many runs passes. */
  reliability: number | null;
  /** errors / ran. */
  errorRate: number;
  minPassRate: number;
  maxErrorRate: number;
  /** Why fewer runs ran than asked: the outcome was decided, the token budget ran out, or the
   * scenario was stopped. Null when all of them ran. */
  cutShort: "decided" | "budget" | "stopped" | null;
};

/** How one check did across the completed runs it was put to. */
export type CheckStats = { name: string; passed: number; total: number; passRate: number; unknown: number };

/** How often the judge found one of its built-in findings, over the runs it judged. */
export type FindingStats = {
  id: JudgeFinding;
  question: string;
  found: number;
  unknown: number;
  total: number;
  rate: number;
  /** Up to three of the runs it was found in, with the turn and words that show it. */
  examples: Array<{ run: number; turn: number | null; quote: string | null; reason: string; earlierTurn?: number }>;
};

/** How the runs with one variant of one experiment did. */
export type VariantStats = {
  experiment: string;
  variant: string;
  runs: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number | null;
};

/** Why a scenario was stopped before its runs were through. */
export type ScenarioStop = { code: string; message: string };

export type ScenarioResult = {
  name: string;
  /** The scenario file, relative to the project root. */
  file: string;
  mode: "scripted" | "simulated";
  passed: boolean;
  /** Of the run shown below: the first that failed, else the first error, else the first. */
  endedBy: ScenarioEndedBy;
  /** How long the scenario took, all runs together. */
  durationMs: number;
  /** The turns and checks of the run shown; every run's are in `runs`. */
  turns: ScenarioTurn[];
  checks: ScenarioCheck[];
  /** Things worth knowing that fail nothing: a fake no call used, a variant no run covered. */
  notes: string[];
  /** pass or fail by the pass rate; error when too few runs say anything about the agent. */
  outcome: RunOutcome;
  /** It passed on some runs and failed on others. */
  flaky: boolean;
  stats: ScenarioStats;
  checkStats: CheckStats[];
  findings: FindingStats[];
  /** Per experiment and variant; empty when the agent declares no experiments. */
  variants: VariantStats[];
  style: StyleReport;
  usage: RunUsage | null;
  runs: ScenarioRun[];
  /** Set when the scenario was stopped, e.g. a tool without a fake on a repeated run. */
  stopped?: ScenarioStop;
};

/** The run of a saved conversation, as a report shows it. */
export function scenarioRun(conversation: SavedConversation): ScenarioRun {
  const { assessment } = conversation;
  return {
    run: conversation.scenario.run,
    outcome: assessment.outcome,
    ...(assessment.error ? { error: assessment.error } : {}),
    passed: assessment.outcome === "pass",
    endedBy: conversation.ending.by,
    durationMs: conversation.durationMs,
    turns: conversation.turns,
    checks: assessment.checks,
    notes: assessment.notes,
    experiments: conversation.experiments,
    ending: conversation.ending,
    endState: conversation.endState,
    judge: assessment.judge,
    usage: conversation.usage,
  };
}

const rate = (count: number, total: number) => Math.round((count / total) * 1000) / 1000;

/** What a scenario shows when no run finished: it was stopped, or its budget ran out, first. */
const NO_RUN: Pick<ScenarioRun, "endedBy" | "turns" | "checks" | "notes"> = { endedBy: "error", turns: [], checks: [], notes: [] };

export function aggregateScenario(params: {
  settings: SavedScenarioSettings;
  conversations: readonly SavedConversation[];
  maxErrorRate: number;
  durationMs: number;
  /** Notes about the scenario as a whole, shown after the run's own. */
  notes?: readonly string[];
  cutShort?: ScenarioStats["cutShort"];
  stopped?: ScenarioStop;
}): ScenarioResult {
  const { settings, maxErrorRate } = params;
  const runs = [...params.conversations].sort((left, right) => left.scenario.run - right.scenario.run).map(scenarioRun);
  const passed = runs.filter((run) => run.outcome === "pass").length;
  const failed = runs.filter((run) => run.outcome === "fail").length;
  const errors = runs.length - passed - failed;
  const completed = passed + failed;
  const passRate = completed === 0 ? null : rate(passed, completed);
  const style = styleReport(runs, settings.style);
  const styleChecks: ScenarioCheck[] = style.limits.map((limit) => ({
    name: `style: ${limit.metric} at most ${limit.limit}`,
    pass: limit.pass,
    detail: styleLimitLine(limit),
  }));
  const stats: ScenarioStats = {
    runs: settings.runs,
    ran: runs.length,
    passed,
    failed,
    errors,
    passRate,
    reliability: passRate === null ? null : rate(passRate ** settings.runs, 1),
    errorRate: runs.length === 0 ? 0 : rate(errors, runs.length),
    minPassRate: settings.minPassRate,
    maxErrorRate,
    cutShort: params.cutShort ?? null,
  };

  // Runs that failed are evidence whatever else happened. Without them, a scenario whose runs
  // mostly could not be assessed is an error, not a pass.
  const outcome: RunOutcome =
    params.stopped || (passRate !== null && passRate < settings.minPassRate) || styleChecks.some((check) => !check.pass)
      ? "fail"
      : passRate === null || stats.errorRate > maxErrorRate
        ? "error"
        : "pass";
  const shown = runs.find((run) => run.outcome === "fail") ?? runs.find((run) => run.outcome === "error") ?? runs[0] ?? NO_RUN;

  return {
    name: settings.name,
    file: settings.file,
    mode: settings.mode,
    passed: outcome === "pass",
    endedBy: shown.endedBy,
    durationMs: params.durationMs,
    turns: shown.turns,
    checks: [...shown.checks, ...styleChecks],
    notes: [...shown.notes, ...(params.notes ?? [])],
    outcome,
    flaky: passed > 0 && failed > 0,
    stats,
    checkStats: checkStats(runs),
    findings: findingStats(runs),
    variants: variantStats(runs),
    style,
    usage: sumUsage(runs.map((run) => run.usage)),
    runs,
    ...(params.stopped ? { stopped: params.stopped } : {}),
  };
}

/**
 * Whether further runs can still change a scenario's outcome, given the runs that are in:
 * false once it fails even if every remaining run passes, or passes even if every remaining
 * run fails or is an error.
 */
export function outcomeOpen(counts: { passed: number; failed: number; errors: number; remaining: number; settings: { minPassRate: number; maxErrorRate: number } }): boolean {
  const { passed, failed, errors, remaining } = counts;
  const { minPassRate, maxErrorRate } = counts.settings;
  if (remaining <= 0) return false;
  const completed = passed + failed;
  const bestRate = (passed + remaining) / (completed + remaining);
  if (bestRate < minPassRate) return false;
  const worstRate = passed / (completed + remaining);
  const worstErrorRate = (errors + remaining) / (completed + errors + remaining);
  return !(passed > 0 && worstRate >= minPassRate && worstErrorRate <= maxErrorRate);
}

function checkStats(runs: readonly ScenarioRun[]): CheckStats[] {
  const stats = new Map<string, CheckStats>();
  for (const run of runs) {
    if (run.outcome === "error") continue;
    for (const check of run.checks) {
      // A check the judge never answered was not put to the run: it is in no rate.
      if (check.notJudged) continue;
      const entry = stats.get(check.name) ?? { name: check.name, passed: 0, total: 0, passRate: 0, unknown: 0 };
      entry.total += 1;
      if (check.pass) entry.passed += 1;
      if (check.evidence?.answer === "unknown") entry.unknown += 1;
      entry.passRate = rate(entry.passed, entry.total);
      stats.set(check.name, entry);
    }
  }
  return [...stats.values()];
}

/** Longest list of examples a finding carries. */
const MAX_EXAMPLES = 3;

function findingStats(runs: readonly ScenarioRun[]): FindingStats[] {
  const judged = runs.filter((run) => run.judge !== null);
  if (judged.length === 0) return [];
  return (Object.keys(JUDGE_FINDINGS) as JudgeFinding[]).map((id) => {
    const answers = judged.flatMap((run) => (run.judge?.answers ?? []).filter((answer) => answer.id === id).map((answer) => ({ run: run.run, ...answer })));
    const found = answers.filter((answer) => answer.answer === "yes");
    return {
      id,
      question: JUDGE_FINDINGS[id],
      found: found.length,
      unknown: answers.filter((answer) => answer.answer === "unknown").length,
      total: judged.length,
      rate: rate(found.length, judged.length),
      examples: found.slice(0, MAX_EXAMPLES).map(({ run, turn, quote, reason, earlierTurn }) => ({
        run,
        turn,
        quote,
        reason,
        ...(earlierTurn === undefined ? {} : { earlierTurn }),
      })),
    };
  });
}

function variantStats(runs: readonly ScenarioRun[]): VariantStats[] {
  const stats = new Map<string, VariantStats>();
  for (const run of runs) {
    for (const [experiment, variant] of Object.entries(run.experiments)) {
      const key = `${experiment}\n${variant}`;
      const entry = stats.get(key) ?? { experiment, variant, runs: 0, passed: 0, failed: 0, errors: 0, passRate: null };
      entry.runs += 1;
      if (run.outcome === "pass") entry.passed += 1;
      else if (run.outcome === "fail") entry.failed += 1;
      else entry.errors += 1;
      const completed = entry.passed + entry.failed;
      entry.passRate = completed === 0 ? null : rate(entry.passed, completed);
      stats.set(key, entry);
    }
  }
  return [...stats.values()].sort((left, right) => left.experiment.localeCompare(right.experiment) || left.variant.localeCompare(right.variant));
}
