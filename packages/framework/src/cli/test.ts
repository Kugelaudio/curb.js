import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  affectedScenarios,
  inParallel,
  loadRun,
  localReplyStore,
  projectHost,
  remoteReplyStore,
  withReplyStore,
  type ReplyStore,
  saveRun,
  scenario as accepted,
  simulatedCaller,
  judge,
  testModel,
  type Scenario,
  type ScenarioDefinition,
  type ScenarioTurn,
  type TestHost,
  type AffectedScenario,
  type TestRun,
} from "../testing/index.js";
import { routeConsoleToStderr } from "./headless-project.js";
import { scenarioRun, type ScenarioResult } from "./scenarios/aggregate.js";
import { assessConversation, assessmentSettings } from "./scenarios/assess.js";
import { runsProblem } from "./scenarios/limits.js";
import {
  TEST_EXIT_CODES,
  formatChecks,
  formatRepeated,
  formatRunLine,
  formatSummary,
  formatTurn,
  isResult,
  markdownReport,
  testOutcome,
  type ScenarioReport,
  type TestReport,
} from "./scenarios/report.js";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ERROR_RATE,
  MAX_CONCURRENCY,
  cannotBeAssessed,
  notStartedNote,
  playRun,
  scenarioSettings,
  summarizeScenario,
  uncoveredVariants,
} from "./scenarios/run.js";
import type { ExperimentDeclaration, SavedConversation, SavedScenarioSettings, TestModels, ThrottleStats } from "./scenarios/types.js";
import { sinceLastVersion } from "./scenarios/since.js";
import { runUsage, sumUsage } from "./scenarios/usage.js";

export type { TestHost } from "../testing/index.js";
export type { LoadFailure, ScenarioReport, TestReport } from "./scenarios/report.js";

export const TEST_USAGE = `Usage: curb test [<filter>] [options]

Runs the conversation scenarios in src/**/*.scenario.ts headlessly, a few at a time, each
through the same session, skills, tools and spoken-reply rules as a call, with the LLM keys
from the project's .env. A scenario's caller is scripted lines, or an LLM that plays a caller
with a goal. Prints each transcript, then every check with pass or fail. Everything is text:
audio, timing and interruptions are not tested here.

Every scenario is checked for: no turn errors (provider error, step limit, a tool refused
3 times in one turn), no empty agent reply, no fallback line instead of a reply, no sentence
repeated within a turn, and a clean end (end_call, the last scripted line, or maxTurns). A
simulated caller is also judged on whether it reached its goal, and the agent must not hang
up while that caller still wants something. A judge answers the scenario's expectations and
looks for six kinds of mistake, each with the turn and a quote; those findings are reported
and fail nothing unless the scenario says so (failOn).

A run ends as pass, fail or error. An error is a run that says nothing about the agent (the
provider failed, the simulated caller got stuck or made up a fact, the judge could not be
read): it is left out of the pass rate. A rate limit of the provider is no error: the run
waits for it, goes on more slowly, and the report says how long it waited.

A tool runs for real on every run unless the scenario fakes it (fakes).

  <filter>               run only the scenarios whose name or file contains it (ignoring case)
  --changed <ref>        run only the scenarios a change since <ref> (a branch or commit, such
                         as origin/main) can affect: those in a changed skill's folder or whose
                         saved runs opened it, every one when the agent level changed, and any
                         scenario no saved run played
  --runs <n>             run every scenario n times (1 to 100) and report rates; a scripted
                         scenario must pass every run unless it sets minPassRate
  --concurrency <k>      conversations at a time, across all scenarios and their runs
                         (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY}); the report keeps the scenarios' order
  --caller-model <id>    the model that plays the caller: a model of the agent's provider, or
                         <provider>:<model> with openai, anthropic or kugelaudio
                         (default: a small model of the agent's provider)
  --judge-model <id>     the same for the judge
  --report <file>        also write the report as Markdown (GITHUB_STEP_SUMMARY gets it too)
  --rejudge <run>        check the conversations of a saved run again, without running the
                         agent: "latest", a run's id, or the path of its file
  --json                 print one JSON object instead:
                         { passed, scenarios: [{ name, file, mode, passed, endedBy, durationMs,
                           turns, checks, notes, outcome, flaky, stats, checkStats, findings,
                           variants, style, usage, runs }], outcome, exitCode, durationMs,
                           models, callerPromptVersion, judgePromptVersion, usage, savedTo,
                           since, changed }

Every run is saved to .curb/test-runs/<id>.json (the newest 20 are kept). After a run, the
report compares it with the newest saved run of another version of the agent (another hash
of the files under src/ and context/, scenarios and tests left out) that played the same
scenarios: per scenario the pass rate then and now, and better, worse, "no clear change"
(Fisher's exact test, p < 0.1) or "too few runs to tell".

Exit code 0 when every scenario passed; 1 when a scenario failed, or no scenario was found or
matched; 2 when none failed but too many runs of a scenario were errors.`;

/** The file name ending that makes a module under src/ a scenario. */
export const SCENARIO_SUFFIX = ".scenario.ts";

const NO_SCENARIOS = `No scenarios found: curb test runs every src/**/*${SCENARIO_SUFFIX} file, and there is none.
Add one, for example src/agent/first-call.scenario.ts:

  import { scenario } from "curb/testing";

  export default scenario({
    caller: { goal: "Find out what this agent can help with" },
  });

Scenarios are described in node_modules/curb/docs/agent-guide/testing.md.`;

export type TestArgs = {
  filter: string;
  json: boolean;
  runs?: number;
  concurrency?: number;
  callerModel?: string;
  judgeModel?: string;
  /** A file the Markdown report is written to. */
  report?: string;
  /** The saved run to check again. */
  rejudge?: string;
  /** The branch or commit whose changes since pick the scenarios. */
  changed?: string;
};

/** The options that take no value. */
const FLAGS = ["--json"];
/** The options that take one, each with what it is. */
const VALUES: Readonly<Record<string, string>> = {
  "--runs": "<n>",
  "--concurrency": "<k>",
  "--caller-model": "<id>",
  "--judge-model": "<id>",
  "--report": "<file>",
  "--rejudge": "<run>",
  "--changed": "<ref>",
};

/** The options `curb test` takes, as public-api.txt lists them. */
export const TEST_OPTIONS: readonly string[] = [...FLAGS, ...Object.keys(VALUES)];

/**
 * A command line as `curb test` and `curb review` read it: options anywhere (`--runs 5` or
 * `--runs=5`), every other argument a word. Throws, naming the option and what it takes, on one
 * that is unknown or has no value.
 */
export function parseOptions(
  command: string,
  usage: string,
  args: readonly string[],
  flagNames: readonly string[],
  valueNames: Readonly<Record<string, string>>,
) {
  const words: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flagNames.includes(arg)) flags.add(arg);
    else if (Object.hasOwn(valueNames, name)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[(index += 1)];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`${command}: ${name} needs a value: ${name} ${valueNames[name]}.\n\n${usage}`);
      }
      values.set(name, value);
    } else if (arg.startsWith("--")) throw new Error(`${command}: unknown option ${arg}.\n\n${usage}`);
    else words.push(arg);
  }
  const wrong = (option: string, problem: string) => new Error(`${command}: ${option} ${problem}`);
  const number = (option: string, ok: (value: number) => boolean, takes: string): number | undefined => {
    const given = values.get(option);
    if (given === undefined) return undefined;
    const value = Number(given);
    if (!Number.isFinite(value) || !ok(value)) throw wrong(option, `must be ${takes}; got ${JSON.stringify(given)}.`);
    return value;
  };
  /** `--concurrency <k>`, which means the same wherever it is taken. */
  const concurrency = () =>
    number("--concurrency", (value) => Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY, `a whole number from 1 to ${MAX_CONCURRENCY}`);
  return { words, values, flags, wrong, number, concurrency };
}

/** `curb test` arguments: every argument that is no option is the filter. */
export function parseTestArgs(args: readonly string[]): TestArgs {
  const { words, values, flags, wrong, number, concurrency } = parseOptions("curb test", TEST_USAGE, args, FLAGS, VALUES);
  const runs = number("--runs", () => true, "a whole number");
  if (runs !== undefined && runsProblem(runs)) throw wrong("--runs", runsProblem(runs)!);
  if (values.has("--changed") && values.has("--rejudge")) throw wrong("--changed", "cannot be combined with --rejudge: a re-judge plays no change of the agent.");
  return {
    filter: words.join(" ").trim(),
    json: flags.has("--json"),
    runs,
    concurrency: concurrency(),
    callerModel: values.get("--caller-model"),
    judgeModel: values.get("--judge-model"),
    report: values.get("--report"),
    rejudge: values.get("--rejudge"),
    changed: values.get("--changed"),
  };
}

type LoadedScenario = { name: string; file: string; scenario: Scenario } | { name: string; file: string; error: string };

/** Every `*.scenario.ts` under the project's src/, as sorted paths relative to the project. */
export function findScenarioFiles(projectRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(SCENARIO_SUFFIX)) {
        found.push(relative(projectRoot, path).split(sep).join("/"));
      }
    }
  };
  const source = join(projectRoot, "src");
  if (existsSync(source)) walk(source);
  return found.sort();
}

/**
 * Every scenario one file exports: its default export (named after the file unless it sets
 * `name`), then each other export `scenario()` made (named after the export).
 */
async function loadScenarios(projectRoot: string, file: string): Promise<LoadedScenario[]> {
  const fileName = basename(file, SCENARIO_SUFFIX);
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(join(projectRoot, file)).href)) as Record<string, unknown>;
  } catch (error) {
    return [{ name: fileName, file, error: `${file} could not be loaded: ${describe(error)}` }];
  }
  const exported: Array<[string, unknown]> = Object.entries(module).filter(
    ([key, value]) => key !== "default" && isScenario(value),
  );
  if (module.default !== undefined) exported.unshift([fileName, module.default]);
  if (exported.length === 0) {
    return [{ name: fileName, file, error: `${file} exports no scenario. Fix: export default scenario({ ... }), with scenario from "curb/testing".` }];
  }
  return exported.map(([name, value]) => {
    try {
      const loaded = accepted(value as ScenarioDefinition);
      return { name: loaded.name ?? name, file, scenario: loaded };
    } catch (error) {
      return { name, file, error: `${file}: ${describe(error)}` };
    }
  });
}

/** A scenario of the project as a review's coverage names it: what its caller wants. */
export type ProjectScenario = { name: string; file: string; wants: string };

/** What a scenario's caller wants, in its own words: the goal, a scripted caller's lines, or that
 * it is a caller of the scenario's own. */
function wantsOf(scenario: Scenario): string {
  const { caller, turns } = scenario;
  if (caller && typeof caller === "object") return caller.goal;
  if (turns) return `says ${turns.map((line) => JSON.stringify(line)).join(", ")}`;
  return "a caller of its own";
}

/**
 * The findings of their own that the project's scenarios give, by id, every scenario with what
 * its caller wants, and a note for each scenario file that could not be loaded. Several
 * scenarios may share a finding (one module imported by each); the same id with two sentences is
 * refused, naming both files.
 */
export async function projectFindings(projectRoot: string): Promise<{ findings: Record<string, string>; notes: string[]; scenarios: ProjectScenario[] }> {
  const findings: Record<string, string> = {};
  const from = new Map<string, string>();
  const notes: string[] = [];
  const scenarios: ProjectScenario[] = [];
  for (const file of findScenarioFiles(projectRoot)) {
    for (const entry of await loadScenarios(projectRoot, file)) {
      if ("error" in entry) {
        notes.push(`The findings of ${entry.file} were not asked: ${entry.error}`);
        continue;
      }
      scenarios.push({ name: entry.name, file: entry.file, wants: wantsOf(entry.scenario) });
      for (const [id, sentence] of Object.entries(entry.scenario.findings ?? {})) {
        if (Object.hasOwn(findings, id) && findings[id] !== sentence) {
          throw new Error(
            `[CURB_REVIEW_FINDING_CONFLICT] The finding "${id}" is given two sentences: ${JSON.stringify(findings[id])} in ${from.get(id)}, and ${JSON.stringify(sentence)} in ${file}.\n` +
              "Fix: give one of them another id, or define the finding once in a module both scenario files import.",
          );
        }
        findings[id] = sentence;
        if (!from.has(id)) from.set(id, file);
      }
    }
  }
  return { findings, notes: [...new Set(notes)], scenarios };
}

/** Whether `value` is what `scenario()` returned: it marks each with this registry symbol, so a
 * scenario is recognised whichever copy of `curb/testing` made it. */
function isScenario(value: unknown): value is Scenario {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[Symbol.for("curb.scenario")] === true;
}

const NO_MODELS: TestModels = { agent: null, caller: null, judge: null };

/** What one `curb test` invocation runs with: the arguments, with the defaults filled in. */
type TestRunOptions = TestArgs & { concurrency: number };

/**
 * `curb test <args>` in the project at `projectRoot` (its .env already loaded). Writes the report
 * to `out` and returns the exit code ({@link TEST_EXIT_CODES}). Framework logs go to stderr
 * meanwhile, so stdout carries only the report (one JSON object with --json).
 */
export async function testCommand(
  args: readonly string[],
  projectRoot: string,
  options: { host?: TestHost; out?: (text: string) => void; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<number> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const env = options.env ?? process.env;
  const parsed = parseTestArgs(args);
  const run: TestRunOptions = { ...parsed, concurrency: parsed.concurrency ?? DEFAULT_CONCURRENCY };
  const files = findScenarioFiles(projectRoot);
  if (files.length === 0 && run.rejudge === undefined) {
    console.error(NO_SCENARIOS);
    return TEST_EXIT_CODES.fail;
  }

  const started = performance.now();
  const restoreConsole = routeConsoleToStderr();
  try {
    const loaded: LoadedScenario[] = [];
    for (const file of files) loaded.push(...(await loadScenarios(projectRoot, file)));
    const host = () => options.host ?? projectHost();
    const session = { projectRoot, run, out, loaded, started, env };
    // Scenarios play on the reply store: a request answered before is answered again without a
    // model. A rejudge asks the judge again on purpose, so it goes to the model.
    const stored = () => options.host ?? withReplyStore(projectHost(), replyStores(env));
    return run.rejudge === undefined ? await runScenarios(session, stored) : await rejudge(session, run.rejudge, host);
  } finally {
    restoreConsole();
  }
}

/** The stores `curb test` keeps replies in: the local one, then the remote one
 * `CURB_REPLY_STORE_URL` names. */
function replyStores(env: Readonly<Record<string, string | undefined>>): ReplyStore[] {
  const url = env.CURB_REPLY_STORE_URL;
  const token = env.CURB_REPLY_STORE_TOKEN;
  return [localReplyStore(env.CURB_REPLY_STORE_DIR ? { dir: env.CURB_REPLY_STORE_DIR } : {}), ...(url ? [remoteReplyStore({ url, ...(token ? { token } : {}) })] : [])];
}

type TestSession = {
  /** What `--changed` picked, once it has. */
  changed?: NonNullable<TestReport["changed"]>;
  projectRoot: string;
  run: TestRunOptions;
  out: (text: string) => void;
  loaded: LoadedScenario[];
  started: number;
  env: Readonly<Record<string, string | undefined>>;
};

/**
 * The files of the project at `root` that differ from where the current branch left `ref` (their
 * merge base): changed, added, deleted or renamed (both names), committed or not, and new files
 * git does not ignore. Paths are relative to the project. Throws, saying how to fix it, when git
 * cannot find that point.
 */
export function changedSince(root: string, ref: string): { base: string; files: string[]; before: (file: string) => string | null } {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  let base: string;
  try {
    base = git("merge-base", ref, "HEAD").trim();
  } catch {
    throw new Error(
      `curb test: --changed ${ref}: git cannot find where this branch left ${JSON.stringify(ref)}.\n` +
        "Fix: name a branch or commit this repository has, and fetch it first where the checkout is shallow (GitHub Actions: actions/checkout with fetch-depth: 0).",
    );
  }
  const listed = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const files = [
    ...listed(git("diff", "--name-only", "--no-renames", "--relative", base, "--", ".")),
    ...listed(git("ls-files", "--others", "--exclude-standard", "--", ".")),
  ];
  const before = (file: string): string | null => {
    try {
      return git("show", `${base}:./${file}`);
    } catch {
      // KEEP-JUSTIFIED: a file the base does not hold IS the answer "it did not exist".
      return null;
    }
  };
  return { base, files: [...new Set(files)].sort(), before };
}

const matches = (filter: string, entry: { name: string; file: string }) =>
  !filter || entry.name.toLowerCase().includes(filter.toLowerCase()) || entry.file.toLowerCase().includes(filter.toLowerCase());

/**
 * The report of scenarios that run at the same time, printed in their own order: what a
 * scenario writes is printed at once while every scenario before it is done, and kept until
 * then otherwise. So the first scenario prints as it goes, as a single one always has, and the
 * text as a whole reads as if they had run one after another.
 */
function inOrder(out: (text: string) => void, count: number) {
  const kept: string[][] = Array.from({ length: count }, () => []);
  const done: boolean[] = Array.from({ length: count }, () => false);
  let current = 0;
  return {
    write(index: number, text: string): void {
      if (index === current) out(text);
      else kept[index]!.push(text);
    },
    finish(index: number): void {
      done[index] = true;
      while (current < count && done[current]) {
        current += 1;
        if (current < count) out(kept[current]!.splice(0).join(""));
      }
    },
  };
}

/** The scenarios that are through, in their own order, as the run's file holds them meanwhile. */
function inScenarioOrder<T>(byIndex: ReadonlyArray<T | undefined>): T[] {
  return byIndex.filter((entry): entry is T => entry !== undefined);
}

/** The fields of every run file this invocation writes, beyond its conversations. */
type RunFields = { id?: string; createdAt?: string; agentVersion?: TestRun["agentVersion"] };

/** Save the run so far (`saveRun`), and keep what makes a later save replace the same file. */
function saveSoFar(session: TestSession, fields: RunFields, run: Parameters<typeof saveRun>[1], conversations: readonly SavedConversation[]): ReturnType<typeof saveRun> {
  const saved = saveRun(conversations, { ...run, ...fields, maxErrorRate: DEFAULT_MAX_ERROR_RATE, root: session.projectRoot });
  Object.assign(fields, { id: saved.run.id, createdAt: saved.run.createdAt, agentVersion: saved.run.agentVersion ?? null });
  return saved;
}

/**
 * Play the selected scenarios, as many conversations at a time as `--concurrency` allows across
 * all of them, report each in the scenarios' order, and save the run after each one. Every run
 * of every scenario is one item of one `inParallel`: `playRun` plays it (`startCall`, `converse`,
 * the checks and the judge), and a scenario is summed up once its last run is in.
 */
async function runScenarios(session: TestSession, hostOf: () => TestHost): Promise<number> {
  const { run, out, loaded } = session;
  const matched = loaded.filter((entry) => matches(run.filter, entry));
  if (matched.length === 0) {
    console.error(
      `No scenario matches "${run.filter}". The scenarios are: ${loaded.map((entry) => `${entry.name} (${entry.file})`).join(", ")}.`,
    );
    return TEST_EXIT_CODES.fail;
  }
  // --changed: only the scenarios the change can affect. One that could not be loaded is reported
  // whatever changed.
  let selected = matched;
  if (run.changed !== undefined) {
    const { base, files, before } = changedSince(session.projectRoot, run.changed);
    const verdicts = affectedScenarios(files, matched.filter((entry) => "scenario" in entry), { root: session.projectRoot, before });
    const affected = new Set(verdicts.filter((verdict) => verdict.affected).map((verdict) => `${verdict.file}\n${verdict.name}`));
    selected = matched.filter((entry) => "error" in entry || affected.has(`${entry.file}\n${entry.name}`));
    const of = ({ name, file, why }: AffectedScenario) => ({ name, file, why });
    session.changed = {
      since: run.changed,
      base,
      files,
      ran: verdicts.filter((verdict) => verdict.affected).map(of),
      skipped: verdicts.filter((verdict) => !verdict.affected).map(of),
    };
  }

  const host = hostOf();
  const before = host.throttle?.stats();
  const choice = { ...(run.callerModel === undefined ? {} : { callerModel: run.callerModel }), ...(run.judgeModel === undefined ? {} : { judgeModel: run.judgeModel }) };
  const printed = inOrder(run.json ? () => {} : out, selected.length);
  const reports: ScenarioReport[] = [];
  const settingsOf: Array<SavedScenarioSettings | undefined> = [];
  const conversationsOf: Array<SavedConversation[] | undefined> = [];
  const fields: RunFields = {};
  let models = NO_MODELS;
  let savedTo: string | null = null;

  // Every agent is the same, so the first one says which LLM the models run beside. It is built
  // before any header (the first build logs the agent's authoring diagnostics, to stderr), and
  // the first run takes it. A model without a key is refused here, before any run.
  if (selected.some((entry) => "scenario" in entry)) {
    const caller = await testModel({ host, role: "caller", ...(choice.callerModel === undefined ? {} : { model: choice.callerModel }) });
    const judging = await testModel({ host, role: "judge", ...(choice.judgeModel === undefined ? {} : { model: choice.judgeModel }) });
    models = { agent: null, caller: caller.model, judge: judging.model };
  }

  type Job = { index: number; run: number };
  const jobs: Job[] = [];
  const left: number[] = [];
  /** The runs of each scenario that were not started: it had too many errors to be assessed. */
  const notStarted: number[] = [];
  const declaredOf: Array<readonly ExperimentDeclaration[]> = [];
  for (const [index, entry] of selected.entries()) {
    printed.write(index, `\n--- ${entry.name} (${entry.file})\n`);
    if ("error" in entry) {
      printed.write(index, `FAIL ${entry.name}: ${entry.error}\n`);
      reports[index] = { ...entry, passed: false };
      printed.finish(index);
      continue;
    }
    settingsOf[index] = scenarioSettings({ scenario: entry.scenario, name: entry.name, file: entry.file, runs: run.runs });
    conversationsOf[index] = [];
    declaredOf[index] = [];
    left[index] = settingsOf[index].runs;
    notStarted[index] = 0;
    for (let at = 0; at < settingsOf[index].runs; at += 1) jobs.push({ index, run: at });
  }
  const done = new Set<number>();
  for (const [index, entry] of selected.entries()) if ("error" in entry) done.add(index);
  // Settings and conversations of the scenarios that are through, in their own order.
  const through = () => ({
    scenarios: selected.flatMap((_, index) => (done.has(index) && settingsOf[index] ? [settingsOf[index]] : [])),
    conversations: selected.flatMap((_, index) => (done.has(index) ? (conversationsOf[index] ?? []) : [])),
  });

  let concurrency = run.concurrency;
  const runsStarted = performance.now();
  await inParallel(
    jobs,
    async ({ index, run: at }) => {
      const entry = selected[index] as Extract<(typeof selected)[number], { scenario: Scenario }>;
      const settings = settingsOf[index]!;
      const once = settings.runs === 1;
      const write = (text: string) => printed.write(index, text);
      if (cannotBeAssessed(conversationsOf[index]!, settings.runs, DEFAULT_MAX_ERROR_RATE)) notStarted[index]! += 1;
      else {
        const conversation = await playRun({
          scenario: entry.scenario,
          name: entry.name,
          file: entry.file,
          host,
          ...choice,
          run: at,
          onCall: (call) => void (models = { ...models, agent: models.agent ?? call.model }),
          onDeclared: (declared) => void (declaredOf[index] = declared),
          ...(once ? { onTurn: (turn: ScenarioTurn) => write(formatTurn(turn)) } : {}),
        });
        conversationsOf[index]!.push(conversation);
        if (!once) write(formatRunLine(scenarioRun(conversation), settings.runs));
      }
      left[index]! -= 1;
      if (left[index]! > 0) return;

      const result = await summarizeScenario({
        scenario: entry.scenario,
        host,
        ...(choice.judgeModel === undefined ? {} : { judgeModel: choice.judgeModel }),
        settings,
        conversations: conversationsOf[index]!,
        maxErrorRate: DEFAULT_MAX_ERROR_RATE,
        durationMs: Math.round(performance.now() - runsStarted),
        notes: [
          ...notStartedNote(conversationsOf[index]!, settings.runs, notStarted[index]!, DEFAULT_MAX_ERROR_RATE),
          ...uncoveredVariants(declaredOf[index]!, entry.scenario, conversationsOf[index]!.map((saved) => saved.experiments)),
        ],
      });
      write(once ? formatChecks(result) : formatRepeated(result));
      reports[index] = result;
      done.add(index);
      savedTo = saveSoFar(session, fields, { ...through(), models, complete: false }, through().conversations).path;
      printed.finish(index);
    },
    { concurrency, host, onSlowDown: (lowered) => void (concurrency = lowered) },
  );
  return finish(session, { fields, models, rejudgedFrom: undefined, callerPromptVersion: simulatedCaller.promptVersion, savedTo }, through(), reports, throttledBy(host, before, concurrency));
}

/** How the provider's rate limit slowed this command down, since `before` (the host's throttle
 * is the process's, and counts every command it served); undefined when it did not. */
export function throttledBy(host: TestHost, before: ThrottleStats | undefined, concurrency: number): TestReport["throttled"] {
  const stats = host.throttle?.stats();
  if (!stats) return undefined;
  const waits = stats.waits - (before?.waits ?? 0);
  return waits > 0 ? { waits, waitedMs: stats.waitedMs - (before?.waitedMs ?? 0), concurrency } : undefined;
}

/** What `finish` saves and reports beyond the scenarios. */
type Finished = {
  fields: RunFields;
  models: TestModels;
  rejudgedFrom: string | undefined;
  callerPromptVersion: string;
  /** Where the run was saved while it ran. */
  savedTo: string | null;
};

/** Save the finished run, print the report (and write it where it was asked for), and return
 * the exit code. */
function finish(
  session: TestSession,
  finished: Finished,
  through: { scenarios: SavedScenarioSettings[]; conversations: SavedConversation[] },
  scenarios: ScenarioReport[],
  throttled: TestReport["throttled"],
): number {
  const { run, out, env, projectRoot } = session;
  const hasRuns = through.conversations.length > 0;
  const saved = hasRuns
    ? saveSoFar(session, finished.fields, {
        ...through,
        models: finished.models,
        complete: true,
        callerPromptVersion: finished.callerPromptVersion,
        ...(finished.rejudgedFrom === undefined ? {} : { rejudgedFrom: finished.rejudgedFrom }),
      }, through.conversations)
    : null;
  const savedTo = saved?.path ?? null;
  // Did the change help: this run against the last one of another version of the agent. A
  // re-judge played no new version.
  const since = saved && finished.rejudgedFrom === undefined ? sinceLastVersion(projectRoot, saved.path, saved.run) : undefined;
  const outcome = testOutcome(scenarios);
  const report: TestReport = {
    passed: scenarios.every((entry) => entry.passed),
    scenarios,
    outcome,
    exitCode: TEST_EXIT_CODES[outcome],
    durationMs: Math.round(performance.now() - session.started),
    models: finished.models,
    callerPromptVersion: finished.callerPromptVersion,
    judgePromptVersion: judge.promptVersion,
    usage: sumUsage(scenarios.filter(isResult).map((result) => result.usage)),
    savedTo,
    ...(finished.rejudgedFrom === undefined ? {} : { rejudgedFrom: finished.rejudgedFrom }),
    ...(throttled ? { throttled } : {}),
    ...(since ? { since } : {}),
    ...(session.changed ? { changed: session.changed } : {}),
  };
  out(run.json ? `${JSON.stringify(report)}\n` : formatSummary(report));
  const markdown = run.report !== undefined || env.GITHUB_STEP_SUMMARY ? markdownReport(report) : "";
  if (run.report !== undefined) {
    const file = resolve(projectRoot, run.report);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, markdown);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return report.exitCode;
}

/**
 * `curb test --rejudge <run>`: check every conversation of a saved run again, with the checks
 * and the judge as they are now, and without running the agent. A scenario that is still in the
 * project brings its `expect`, `expectations`, `failOn`, `style` and `minPassRate` as they are
 * now; for one that is gone, what was saved applies and `expect` is left out. As many
 * conversations are judged at a time as `--concurrency` allows, across all scenarios. The
 * result is reported like a run and saved as a run of its own.
 */
async function rejudge(session: TestSession, which: string, hostOf: () => TestHost): Promise<number> {
  const { run, out, loaded } = session;
  const source = loadRun(which, { root: session.projectRoot });
  const selected = source.scenarios.filter((entry) => matches(run.filter, entry));
  if (selected.length === 0) {
    console.error(
      `No scenario of the saved run ${source.id} matches "${run.filter}". It holds: ${source.scenarios.map((entry) => `${entry.name} (${entry.file})`).join(", ")}.`,
    );
    return TEST_EXIT_CODES.fail;
  }

  const host = hostOf();
  const before = host.throttle?.stats();
  const judgeOptions = { host, role: "judge" as const, ...(run.judgeModel === undefined ? {} : { model: run.judgeModel }) };
  const judgeModel = (await testModel(judgeOptions)).model;
  const models: TestModels = { agent: source.models.agent, caller: source.models.caller, judge: judgeModel };
  const printed = inOrder(run.json ? () => {} : out, selected.length);
  const reports: ScenarioReport[] = [];
  const startedAt = performance.now();

  // What each scenario applies now: its settings as the project holds it, else as saved.
  const plans = selected.map((was) => {
    const current = loaded.find((entry) => entry.file === was.file && entry.name === was.name);
    const scenario = current && "scenario" in current ? current.scenario : null;
    const settings: SavedScenarioSettings = scenario ? { ...scenarioSettings({ scenario, name: was.name, file: was.file }), runs: was.runs } : was;
    const recorded = source.conversations.filter((entry) => entry.scenario.file === was.file && entry.scenario.name === was.name);
    return { was, scenario, settings, recorded, judged: [] as SavedConversation[], left: recorded.length };
  });
  const report = async (index: number) => {
    const { was, scenario, settings, judged } = plans[index]!;
    const gone = was.file ? `${was.file} no longer holds a scenario named "${was.name}"` : `"${was.name}" is no scenario of the project`;
    const result = await summarizeScenario({
      scenario,
      host,
      ...(run.judgeModel === undefined ? {} : { judgeModel: run.judgeModel }),
      settings,
      conversations: judged,
      maxErrorRate: DEFAULT_MAX_ERROR_RATE,
      durationMs: Math.round(performance.now() - startedAt),
      notes: scenario ? [] : [`${gone}: its saved settings were applied, and its expect was not`],
    });
    reports[index] = result;
    printed.write(index, `\n--- ${was.name} (${was.file})\n${formatReplayed(result)}`);
    printed.finish(index);
  };
  for (const [index, plan] of plans.entries()) if (plan.left === 0) await report(index);

  let concurrency = run.concurrency;
  const jobs = plans.flatMap((plan, index) => plan.recorded.map((conversation, at) => ({ index, at, conversation })));
  await inParallel(
    jobs,
    async ({ index, at, conversation }) => {
      const plan = plans[index]!;
      const { assessment: _before, ...record } = conversation;
      const judging = await testModel(judgeOptions);
      const assessment = await assessConversation({
        record: record as Omit<SavedConversation, "assessment">,
        settings: plan.scenario
          ? assessmentSettings(plan.scenario)
          : {
              expectations: plan.settings.expectations,
              ...(plan.settings.findings ? { findings: plan.settings.findings } : {}),
              failOn: plan.settings.failOn,
              // A simulated scenario's conversation without its caller's definition had a caller of its own.
              ...(plan.settings.mode === "simulated" && record.caller === null ? { judgeAlways: true as const } : {}),
            },
        judge: judging,
      });
      const usage = runUsage({ agent: record.usage?.agent ?? null, caller: record.usage?.caller ?? null, judge: judging.usage() });
      // In the saved run's order, whichever is judged first.
      plan.judged[at] = { ...(record as Omit<SavedConversation, "assessment">), usage, assessment };
      plan.left -= 1;
      if (plan.left === 0) await report(index);
    },
    { concurrency, host, onSlowDown: (lowered) => void (concurrency = lowered) },
  );
  const through = { scenarios: plans.map((plan) => plan.settings), conversations: plans.flatMap((plan) => plan.judged) };
  return finish(session, { fields: {}, models, rejudgedFrom: source.id, callerPromptVersion: source.callerPromptVersion, savedTo: null }, through, reports, throttledBy(host, before, concurrency));
}

/** A re-judged scenario as the report prints it: the transcript first when it ran once. */
function formatReplayed(result: ScenarioResult): string {
  if (result.stats.runs > 1 || result.runs.length !== 1) return formatRepeated(result);
  return `${result.turns.map(formatTurn).join("")}${formatChecks(result)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
