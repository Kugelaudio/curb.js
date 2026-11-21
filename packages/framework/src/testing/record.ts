import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ScenarioEndedBy } from "./checks.js";
import type { JudgeResult } from "./judge.js";
import type { JudgeFinding, ScenarioCaller, ScenarioCheck, ScenarioTurn, StyleLimits } from "./scenario.js";
import type { RunUsage } from "./usage.js";

/**
 * The conversation record: everything about one finished conversation that a check, the judge
 * or a style number reads, as plain JSON. `curb test` writes one per run and saves them all
 * (`.curb/test-runs/<id>.json`); `curb test --rejudge` reads them back and checks them again
 * without running the agent.
 *
 * Nothing in a record's `turns`, `ending` or `endState` is specific to a scenario: a turn is
 * the caller's words, what the agent said and the tool calls with their inputs and results.
 * A conversation from the preview or a hosted call's transcript fits the same shape, with a
 * `source` of its own, which is how they can be checked by the same code later.
 */

/** What the simulated caller said about the end of the call (see `caller.ts`). */
export type CallerEnding = {
  /** The caller was done with the call; false when the agent hung up while it still wanted something. */
  done: boolean;
  /** Whether the caller says its goal was met; null when it did not say. */
  goalMet: boolean | null;
  /** Why, in the caller's words; what it still wanted when `done` is false. */
  reason: string;
};

/** How a conversation ended, as code: who ended it, at which point, and what the caller said. */
export type ConversationEnding = {
  by: ScenarioEndedBy;
  /** Why it stopped, for `error` and `simulator`. */
  reason?: string;
  /** Scripted caller lines that were never said. */
  unsaid: string[];
  /** The caller turns the conversation was allowed. */
  maxTurns: number;
  /** A request to the agent's LLM provider failed, after the retries, and that stopped it. */
  providerError?: true;
  /** What the simulated caller said about the end; null when it never said (a scripted caller,
   * a call that broke off, or an answer that could not be read). */
  caller: CallerEnding | null;
};

/** The agent's state when the conversation ended. */
export type EndState = {
  /** The data of every `createAgentStore` store the agent used, by key, without actions. */
  stores: Record<string, Record<string, unknown>>;
  /** The agent's rendered context, line by line. */
  context: string[];
  /** The active skill; "" at the agent level. */
  skillPath: string;
};

/** A tool the agent was offered during the conversation, as the judge needs it. */
export type RecordedTool = { name: string; description: string };

export type ConversationRecord = {
  format: "curb.conversation";
  version: 1;
  /** Where the conversation comes from. `curb test` writes "scenario". */
  source: "scenario";
  scenario: { name: string; file: string; mode: "scripted" | "simulated"; run: number };
  /** The simulated caller as the scenario defined it; null for a scripted one. */
  caller: ScenarioCaller | null;
  /** The variant the call had in each of the agent's experiments. */
  experiments: Record<string, string>;
  startedAt: string;
  durationMs: number;
  turns: ScenarioTurn[];
  /** Every tool of the agent's that the model was offered at some point of the conversation,
   * without the framework's own. A record that does not hold it is judged without it. */
  tools?: RecordedTool[];
  ending: ConversationEnding;
  /** Null when the agent's state could not be read. */
  endState: EndState | null;
  /** The scenario's fakes that no call used. */
  unusedFakes: string[];
  /** Tokens the agent and the caller used; the judge's are added when it has answered. */
  usage: RunUsage | null;
};

/** What a run came to. An error is a run that says nothing about the agent: it is left out of
 * the pass rate. */
export type RunOutcome = "pass" | "fail" | "error";

/** Why a run says nothing about the agent. */
export type RunErrorKind =
  /** A request to the agent's LLM provider failed, after the retries. */
  | "provider"
  /** The simulated caller could not say its next line. */
  | "simulator"
  /** The simulated caller said the same line over and over while the agent did not. */
  | "simulator_loop"
  /** The simulated caller said a fact that is not in `caller.knows`. */
  | "invented_fact"
  /** The turn limit cut the call off before the caller was done, and no fault of the agent's was found. */
  | "max_turns"
  /** The judge could not be asked, or its answer could not be read. */
  | "judge";

export type RunError = { kind: RunErrorKind; message: string };

/** What the checks and the judge made of a conversation. */
export type Assessment = {
  outcome: RunOutcome;
  /** Set when `outcome` is "error". */
  error?: RunError;
  checks: ScenarioCheck[];
  /** Things worth knowing that fail nothing. */
  notes: string[];
  /** The judge's answers; null when the conversation was not judged. */
  judge: JudgeResult | null;
};

/** A conversation as a run file holds it: the record, and what was made of it when it was saved. */
export type SavedConversation = ConversationRecord & { assessment: Assessment };

/** What a scenario asked of its runs, saved with them so a re-judge can apply the same. */
export type SavedScenarioSettings = {
  name: string;
  file: string;
  mode: "scripted" | "simulated";
  runs: number;
  minPassRate: number;
  expectations: string[];
  failOn: JudgeFinding[];
  style: StyleLimits;
};

/** Which model played each part, as `provider:model`; null where the host did not say. */
export type TestModels = { agent: string | null; caller: string | null; judge: string | null };

/** One `curb test` invocation on disk. */
export type SavedTestRun = {
  format: "curb.test-run";
  version: 1;
  id: string;
  createdAt: string;
  /** The curb version that wrote it. */
  curb: string;
  /** False while scenarios are still running, or when the run was cut short. */
  complete: boolean;
  /** The run whose conversations these are, when this is a re-judge of it. */
  rejudgedFrom?: string;
  models: TestModels;
  callerPromptVersion: string;
  judgePromptVersion: string;
  maxErrorRate: number;
  scenarios: SavedScenarioSettings[];
  conversations: SavedConversation[];
};

/** Saved runs kept per project; older ones are deleted when a new one is written. */
export const KEPT_TEST_RUNS = 20;

/** Where a project's test runs are saved, relative to the project. */
export const TEST_RUNS_DIR = ".curb/test-runs";

/** An id for a new run: when it started, to the millisecond, and four random characters. Ids
 * sort by time, which is how "latest" is found. */
export function newTestRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

const runFile = (projectRoot: string, id: string) => join(projectRoot, TEST_RUNS_DIR, `${id}.json`);

/** The path of a saved run as a report shows it: relative to the project, with forward slashes. */
export function testRunPath(id: string): string {
  return `${TEST_RUNS_DIR}/${id}.json`;
}

/**
 * Write `run` to `.curb/test-runs/<id>.json`, replacing an earlier state of the same run, and
 * delete all but the newest {@link KEPT_TEST_RUNS}. The file is written beside its place and
 * moved in, so a reader never finds half of one.
 */
export function saveTestRun(projectRoot: string, run: SavedTestRun): void {
  const directory = join(projectRoot, TEST_RUNS_DIR);
  mkdirSync(directory, { recursive: true });
  const file = runFile(projectRoot, run.id);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(run)}\n`);
  renameSync(`${file}.tmp`, file);
  for (const stale of savedTestRunIds(projectRoot).slice(KEPT_TEST_RUNS)) {
    rmSync(runFile(projectRoot, stale), { force: true });
  }
}

/** The ids of the project's saved runs, newest first. */
export function savedTestRunIds(projectRoot: string): string[] {
  try {
    return readdirSync(join(projectRoot, TEST_RUNS_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort()
      .reverse();
  } catch {
    // KEEP-JUSTIFIED: no directory IS the answer "no saved runs"; the caller reports it.
    return [];
  }
}

/**
 * Read a saved run: `which` is "latest", a run's id, or the path of its file. Throws, naming
 * the runs there are, when it does not exist, and saying what it is instead when the file is
 * not a saved run of this format.
 */
export function loadTestRun(projectRoot: string, which: string): SavedTestRun {
  const ids = savedTestRunIds(projectRoot);
  const notFound = (where: string) => {
    const known = ids.length > 0 ? `The saved runs are: ${ids.join(", ")} (newest first; "latest" names the first).` : "This project has no saved runs yet: run `npx curb test` first.";
    return new Error(`[CURB_TEST_RUN_NOT_FOUND] No saved test run ${where}.\nFix: ${known}`);
  };
  if (which === "latest" && ids.length === 0) throw notFound(`in ${TEST_RUNS_DIR}`);
  const looksLikePath = which.includes("/") || which.includes(sep) || which.endsWith(".json");
  const file = looksLikePath
    ? isAbsolute(which) ? which : resolve(projectRoot, which)
    : runFile(projectRoot, which === "latest" ? ids[0]! : which);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw notFound(`at ${relative(projectRoot, file) || file}`);
  }
  const unreadable = (why: string) =>
    new Error(
      `[CURB_TEST_RUN_UNREADABLE] ${relative(projectRoot, file) || file} is not a saved test run this version reads: ${why}.\nFix: run \`npx curb test\` again to save a new one.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unreadable("it is not JSON");
  }
  const run = parsed as Partial<SavedTestRun> | null;
  if (typeof run !== "object" || run === null || run.format !== "curb.test-run") throw unreadable('its format is not "curb.test-run"');
  if (run.version !== 1) throw unreadable(`it is version ${String(run.version)} of the format, and this is version 1`);
  if (!Array.isArray(run.conversations) || !Array.isArray(run.scenarios)) throw unreadable("it holds no conversations");
  return run as SavedTestRun;
}
