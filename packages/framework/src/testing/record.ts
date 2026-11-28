import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveProjectRoot } from "../project.node.js";
import { curbVersion } from "../version.js";
import { CALLER_PROMPT_VERSION } from "./caller.js";
import type { ScenarioEndedBy } from "./checks.js";
import type { TestModels } from "./host.js";
import { JUDGE_PROMPT_VERSION, type JudgeResult } from "./judge.js";
import type { ReplyRequest } from "./reply-store.js";
import type { JudgeFinding, ScenarioCaller, ScenarioCheck, ScenarioTurn, StyleLimits } from "./scenario.js";
import type { RunUsage } from "./usage.js";

export type { TestModels } from "./host.js";

/**
 * The conversation record: everything about one finished conversation that a check, the judge
 * or a style number reads, as plain JSON. `curb test` writes one per run and saves them all
 * (`.curb/test-runs/<id>.json`); `curb test --rejudge` reads them back and checks them again
 * without running the agent.
 *
 * Nothing in a record's `turns`, `ending` or `endState` is specific to a scenario: a turn is
 * the caller's words, what the agent said and the tool calls with their inputs and results.
 * A call `startCall` played, a conversation of the preview and a hosted call's transcript fit
 * the same shape, each with a `source` of its own (`loadCalls` reads them), so every check and
 * judge reads them all.
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
  /** Null when the source does not say who ended the call. */
  by: ScenarioEndedBy | null;
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

/** Where a conversation comes from: a scenario of `curb test`, a call `startCall` played, or a
 * source `loadCalls` read (the `curb dev` store, a Calls export, a written transcript). */
export type ConversationSource = "scenario" | "call" | "dev" | "calls-export" | "transcript";

/** The scenario a conversation of `curb test` ran, and which of its runs it is, from 1. */
export type ScenarioRef = { name: string; file: string; mode: "scripted" | "simulated"; run: number };

export type ConversationRecord = {
  format: "curb.conversation";
  version: 1;
  source: ConversationSource;
  /** How a report names the call, where its source names it: a Calls export's call id, a
   * conversation of the `curb dev` store, a saved run's scenario and run. */
  id?: string;
  /** The scenario, on a conversation of `curb test`. */
  scenario?: ScenarioRef;
  /** The simulated caller as it was defined; null for scripted lines and any other caller. */
  caller: ScenarioCaller | null;
  /** The variant the call had in each of the agent's experiments. */
  experiments: Record<string, string>;
  /** Null when the source does not say. */
  startedAt: string | null;
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
  /** False when the source does not record the agent's tool calls (a Calls export line without
   * `toolCalls`, a written transcript): a turn without one says nothing about the tools. */
  recordsToolCalls?: false;
  /** What the reply store answered, on a conversation `curb test` played with it: how many model
   * requests it answered and how many went live; absent without a store (`--live`). */
  replies?: ConversationReplies;
};

/** What the reply store answered in one conversation of `curb test`. `from` names the first
 * request that went live: its turn (null after the last one, as the judge's), who asked, and what
 * part of it differs from the same request of the newest saved run that made it. `requests`
 * holds each request's digests, which the next run compares with. */
export type ConversationReplies = {
  stored: number;
  live: number;
  from?: { turn: number | null; role: "agent" | "caller" | "judge"; changed: string };
  requests?: Array<ReplyRequest & { turn: number | null }>;
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

/** A conversation of `curb test` as a run file holds it: the record of a scenario's run, and what
 * was made of it when it was saved. */
export type SavedConversation = ScenarioRecord & { assessment: Assessment };

/** The record of one run of a scenario: its scenario, its start and who ended it always known. */
export type ScenarioRecord = ConversationRecord & {
  scenario: ScenarioRef;
  startedAt: string;
  ending: ConversationEnding & { by: ScenarioEndedBy };
};

/** What a scenario asked of its runs, saved with them so a re-judge can apply the same. */
export type SavedScenarioSettings = {
  name: string;
  file: string;
  mode: "scripted" | "simulated";
  runs: number;
  minPassRate: number;
  expectations: string[];
  /** The scenario's own findings, by id; absent when it gives none. */
  findings?: Record<string, string>;
  /** Built-in findings and the scenario's own. */
  failOn: Array<JudgeFinding | (string & {})>;
  style: StyleLimits;
};

/** The version of the agent a run played: the project's git commit, whether the files of the
 * project differed from it, and a hash of the agent's sources ({@link agentSourcesHash}), which
 * tells apart two runs on one commit with different edits. `sources` is absent in runs saved
 * before it was recorded. */
export type AgentVersion = { commit: string; dirty: boolean; sources?: string };

/** One `curb test` invocation, or one `saveRun`, on disk. */
export type SavedTestRun = {
  format: "curb.test-run";
  version: 1;
  id: string;
  createdAt: string;
  /** The curb version that wrote it. */
  curb: string;
  /** The version of the agent it played; null outside a git repository. Absent in runs saved
   * before it was recorded. */
  agentVersion?: AgentVersion | null;
  /** False while scenarios are still running, or when the run was cut short. */
  complete: boolean;
  /** The run whose conversations these are, when this is a re-judge of it. */
  rejudgedFrom?: string;
  models: TestModels;
  callerPromptVersion: string;
  judgePromptVersion: string;
  /** The share of a scenario's runs that may be errors (`curb test`); null for a run that
   * `saveRun` wrote without one. */
  maxErrorRate: number | null;
  scenarios: SavedScenarioSettings[];
  conversations: SavedConversation[];
};

/** A conversation as a run file holds it, under the scenario it belongs to. `curb test` saves each
 * with its assessment; `saveRun` saves one only when it is given the checks. */
export type RunConversation = ConversationRecord & { scenario: ScenarioRef; assessment?: Assessment };

/** A saved run, `curb.test-run`, of `curb test` or of `saveRun`. */
export type TestRun = Omit<SavedTestRun, "conversations"> & { conversations: RunConversation[] };

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
export function saveTestRun(projectRoot: string, run: TestRun): void {
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

/** A file of the agent's: not a scenario and not a test. */
const agentSource = (name: string) => !name.endsWith(".scenario.ts") && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name);

/**
 * A hash of the agent's sources in `projectRoot`: every file under `src/` and `context/` (by its
 * path and its bytes), without scenario files (`*.scenario.ts`), tests (`*.test.*`, `*.spec.*`),
 * `node_modules` and dot entries. So adding or editing a scenario leaves it as it is, and any
 * edit of the agent changes it. 16 hex characters of a SHA-256.
 */
export function agentSourcesHash(projectRoot: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, shown: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${shown}/${entry.name}`);
      else if (entry.isFile() && agentSource(entry.name)) hash.update(`${shown}/${entry.name}\0`).update(readFileSync(path)).update("\0");
    }
  };
  for (const top of ["src", "context"]) if (existsSync(join(projectRoot, top))) walk(join(projectRoot, top), top);
  return hash.digest("hex").slice(0, 16);
}

/**
 * The version of the agent in `projectRoot`: the git commit checked out, whether the project's
 * files differ from it, and the hash of its sources. Null outside a git repository, and where
 * git cannot tell.
 */
export function agentVersionOf(projectRoot: string): AgentVersion | null {
  const git = (...args: string[]) => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const commit = git("rev-parse", "HEAD").trim();
    if (!/^[0-9a-f]{7,64}$/.test(commit)) return null;
    // The project's own files: a change elsewhere in a larger repository is another agent's.
    return { commit, dirty: git("status", "--porcelain", "--", ".").trim() !== "", sources: agentSourcesHash(projectRoot) };
  } catch {
    // KEEP-JUSTIFIED: no repository, no commit or no git IS the answer "no version"; the run says null.
    return null;
  }
}

/** What `saveRun` writes beyond the conversations: any field of the run file, and where. */
export type SaveRunOptions = Partial<Omit<SavedTestRun, "format" | "version" | "conversations">> & {
  /** The scenario name conversations without one are saved under. Default: "conversations". */
  name?: string;
  /** Each conversation's checks, in the order of the conversations: saved as its assessment,
   * a pass when every check passed (one that is `reportOnly` or `notJudged` fails nothing). */
  checks?: ReadonlyArray<readonly ScenarioCheck[] | undefined>;
  /** The project to save into. Default: the project this process runs. */
  root?: string;
};

/** A check that counts against the agent: it failed, and it is neither report-only nor unjudged. */
const failed = (check: ScenarioCheck) => !check.pass && !check.reportOnly && !check.notJudged;

/**
 * Save conversations as a run, `.curb/test-runs/<id>.json`, which `curb test --rejudge` checks
 * again and `curb review` reads. A conversation without a scenario is saved as a run of one
 * named `options.name`; one from `curb test` keeps its own. Giving an earlier run's `id` replaces
 * that run's file. The newest {@link KEPT_TEST_RUNS} runs are kept. Returns the run as written
 * and its path, relative to the project.
 */
export function saveRun(
  records: ReadonlyArray<ConversationRecord & { assessment?: Assessment }>,
  options: SaveRunOptions = {},
): { run: TestRun; path: string } {
  const { name = "conversations", checks, root = resolveProjectRoot(), ...fields } = options;
  const now = new Date();
  const conversations = records.map((record, index): RunConversation => {
    const { format, version, source, scenario, ...rest } = record;
    const given = checks?.[index];
    const assessment: Assessment | undefined =
      given === undefined ? record.assessment : { outcome: given.some(failed) ? "fail" : "pass", checks: [...given], notes: [], judge: null };
    return {
      format,
      version,
      source,
      scenario: scenario ?? { name, file: "", mode: record.caller ? "simulated" : "scripted", run: index + 1 },
      ...rest,
      ...(assessment === undefined ? {} : { assessment }),
    };
  });
  const scenarios = fields.scenarios ?? groupsOf(conversations);
  const run: TestRun = {
    format: "curb.test-run",
    version: 1,
    id: fields.id ?? newTestRunId(now),
    createdAt: fields.createdAt ?? now.toISOString(),
    curb: fields.curb ?? curbVersion(),
    agentVersion: fields.agentVersion === undefined ? agentVersionOf(root) : fields.agentVersion,
    complete: fields.complete ?? true,
    ...(fields.rejudgedFrom === undefined ? {} : { rejudgedFrom: fields.rejudgedFrom }),
    models: fields.models ?? { agent: null, caller: null, judge: null },
    callerPromptVersion: fields.callerPromptVersion ?? CALLER_PROMPT_VERSION,
    judgePromptVersion: fields.judgePromptVersion ?? JUDGE_PROMPT_VERSION,
    maxErrorRate: fields.maxErrorRate ?? null,
    scenarios,
    conversations,
  };
  saveTestRun(root, run);
  return { run, path: testRunPath(run.id) };
}

/** One scenario entry per scenario the conversations ran, with the settings a re-judge applies
 * to a scenario that is not in the project: none of its own. */
function groupsOf(conversations: readonly RunConversation[]): SavedScenarioSettings[] {
  const groups = new Map<string, SavedScenarioSettings>();
  for (const { scenario } of conversations) {
    const key = `${scenario.file}\n${scenario.name}`;
    const group = groups.get(key) ?? { name: scenario.name, file: scenario.file, mode: scenario.mode, runs: 0, minPassRate: 1, expectations: [], failOn: [], style: {} };
    group.runs += 1;
    if (scenario.mode === "simulated") group.mode = "simulated";
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A saved run: `which` is "latest" (the default), a run's id, or the path of its file. Throws,
 * naming the runs there are, when it does not exist. */
export function loadRun(which = "latest", options: { root?: string } = {}): TestRun {
  return loadTestRun(options.root ?? resolveProjectRoot(), which);
}
