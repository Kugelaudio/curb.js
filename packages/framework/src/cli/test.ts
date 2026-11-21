import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentLlmClient } from "../agent-session.js";
import { experimentDeclarations } from "../experiments.js";
import type { AgentModelUsage } from "../llm/ai-sdk.js";
import { anthropic, kugelaudio, openai, type KugelaudioLlmModel, type LlmDescriptor } from "../providers.js";
import { aggregateScenario } from "../testing/aggregate.js";
import { assessConversation, assessmentSettings } from "../testing/assess.js";
import { ANSWER_TIMEOUT_MS, CALLER_PROMPT_VERSION } from "../testing/caller.js";
import { JUDGE_PROMPT_VERSION } from "../testing/judge.js";
import {
  loadTestRun,
  newTestRunId,
  saveTestRun,
  testRunPath,
  type SavedConversation,
  type SavedScenarioSettings,
  type SavedTestRun,
  type TestModels,
} from "../testing/record.js";
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
} from "../testing/report.js";
import { Throttle, withRetries, withStreamRetries } from "../testing/resilience.js";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ERROR_RATE,
  MAX_CONCURRENCY,
  RunSlots,
  runScenario,
  scenarioSettings,
  type ScenarioBundle,
  type ScenarioResult,
} from "../testing/run.js";
import {
  isScenario,
  runsProblem,
  scenario as accepted,
  styleLimitsProblems,
  type Scenario,
  type ScenarioDefinition,
  type ScenarioTurn,
  type StyleLimits,
} from "../testing/scenario.js";
import { TokenBudget, TokenCounter, runUsage, sumUsage } from "../testing/usage.js";
import { curbVersion } from "../version.js";
import {
  diagnosticsNote,
  disableConversationRecording,
  dropDiagnosticLogs,
  routeConsoleToStderr,
} from "./headless-project.js";

export type { LoadFailure, ScenarioReport, TestReport } from "../testing/report.js";

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

Tools run for real on a scenario that runs once, except those it fakes (fakes). A scenario
that runs more than once is stopped before a tool without a fake runs, unless it allows the
tool (realTools).

  <filter>               run only the scenarios whose name or file contains it (ignoring case)
  --runs <n>             run every simulated-caller scenario n times (1 to 100) and report
                         rates; scripted scenarios run once unless they set runs themselves
  --concurrency <k>      conversations at a time, across all scenarios and their runs
                         (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY}); the report keeps the scenarios' order
  --no-early-stop        run every run even once the outcome can no longer change
  --max-error-rate <r>   the share of a scenario's runs that may be errors, 0 to 1 (default ${DEFAULT_MAX_ERROR_RATE})
  --caller-model <id>    the model that plays the caller: a model of the agent's provider, or
                         <provider>:<model> with openai, anthropic or kugelaudio
                         (default: CURB_TEST_CALLER_MODEL, else a small model of the agent's provider)
  --judge-model <id>     the same for the judge (default: CURB_TEST_JUDGE_MODEL)
  --max-tokens <n>       stop starting runs once all runs together used n tokens
  --allow-real-tools     let tools without a fake run on every run of a repeated scenario
  --style <limits>       fail a scenario whose style number is above a limit, for example
                         wordsP90=40,questionShare=0.6 (a scenario's own style wins)
  --report <file>        also write the report as Markdown (GITHUB_STEP_SUMMARY gets it too)
  --rejudge <run>        check the conversations of a saved run again, without running the
                         agent: "latest", a run's id, or the path of its file
  --json                 print one JSON object instead:
                         { passed, scenarios: [{ name, file, mode, passed, endedBy, durationMs,
                           turns, checks, notes, outcome, flaky, stats, checkStats, findings,
                           variants, style, usage, runs }], outcome, exitCode, durationMs,
                           models, callerPromptVersion, judgePromptVersion, usage, savedTo }

Every run is saved to .curb/test-runs/<id>.json (the newest 20 are kept).

Exit code 0 when every scenario passed; 1 when a scenario failed, or no scenario was found or
matched; 2 when none failed but too many runs of a scenario were errors; 3 when none failed
but --max-tokens stopped the run before every run ran.`;

/** The file name ending that makes a module under src/ a scenario. */
export const SCENARIO_SUFFIX = ".scenario.ts";

const NO_SCENARIOS = `No scenarios found: curb test runs every src/**/*${SCENARIO_SUFFIX} file, and there is none.
Add one, for example src/agent/first-call.scenario.ts:

  import { scenario } from "curb/testing";

  export default scenario({
    caller: { goal: "Find out what this agent can help with" },
  });

Scenarios are described in node_modules/curb/docs/agent-guide/testing.md.`;

/**
 * The small, fast model of each provider that plays the caller and judges its goal. They run
 * on the agent's own provider, whose key the project already has.
 */
export const SIMULATION_MODELS = { anthropic: "claude-haiku-5-5", openai: "gpt-5.4-mini" } as const;

export type TestArgs = {
  filter: string;
  json: boolean;
  runs?: number;
  concurrency?: number;
  maxErrorRate?: number;
  callerModel?: string;
  judgeModel?: string;
  maxTokens?: number;
  /** A file the Markdown report is written to. */
  report?: string;
  /** The saved run to check again. */
  rejudge?: string;
  style?: StyleLimits;
  allowRealTools?: true;
  noEarlyStop?: true;
};

/** The options that take no value. */
const FLAGS = ["--json", "--allow-real-tools", "--no-early-stop"];
/** The options that take one, each with what it is. */
const VALUES: Readonly<Record<string, string>> = {
  "--runs": "<n>",
  "--concurrency": "<k>",
  "--max-error-rate": "<0..1>",
  "--caller-model": "<id>",
  "--judge-model": "<id>",
  "--max-tokens": "<n>",
  "--style": "<metric=limit,...>",
  "--report": "<file>",
  "--rejudge": "<run>",
};

/** The options `curb test` takes, as public-api.txt lists them. */
export const TEST_OPTIONS: readonly string[] = [...FLAGS, ...Object.keys(VALUES)];

/** `curb test` arguments: options anywhere (`--runs 5` or `--runs=5`), every other argument is
 * the filter. Throws, naming the option and what it takes, on one that is unknown or wrong. */
export function parseTestArgs(args: readonly string[]): TestArgs {
  const words: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (FLAGS.includes(arg)) flags.add(arg);
    else if (Object.hasOwn(VALUES, name)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[(index += 1)];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`curb test: ${name} needs a value: ${name} ${VALUES[name]}.\n\n${TEST_USAGE}`);
      }
      values.set(name, value);
    } else if (arg.startsWith("--")) throw new Error(`curb test: unknown option ${arg}.\n\n${TEST_USAGE}`);
    else words.push(arg);
  }
  const wrong = (option: string, problem: string) => new Error(`curb test: ${option} ${problem}`);
  const number = (option: string, ok: (value: number) => boolean, takes: string): number | undefined => {
    const given = values.get(option);
    if (given === undefined) return undefined;
    const value = Number(given);
    if (!Number.isFinite(value) || !ok(value)) throw wrong(option, `must be ${takes}; got ${JSON.stringify(given)}.`);
    return value;
  };
  const runs = number("--runs", () => true, "a whole number");
  if (runs !== undefined && runsProblem(runs)) throw wrong("--runs", runsProblem(runs)!);
  const style = values.has("--style") ? styleLimits(values.get("--style")!) : undefined;
  const styleProblems = style ? styleLimitsProblems(style) : [];
  if (styleProblems.length > 0) throw wrong("--style", `takes limits such as wordsP90=40,questionShare=0.6: ${styleProblems.join(" ")}`);
  return {
    filter: words.join(" ").trim(),
    json: flags.has("--json"),
    runs,
    concurrency: number("--concurrency", (value) => Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY, `a whole number from 1 to ${MAX_CONCURRENCY}`),
    maxErrorRate: number("--max-error-rate", (value) => value >= 0 && value <= 1, "a share from 0 to 1"),
    callerModel: values.get("--caller-model"),
    judgeModel: values.get("--judge-model"),
    maxTokens: number("--max-tokens", (value) => Number.isInteger(value) && value >= 1, "a whole number of tokens, at least 1"),
    report: values.get("--report"),
    rejudge: values.get("--rejudge"),
    style,
    ...(flags.has("--allow-real-tools") ? { allowRealTools: true as const } : {}),
    ...(flags.has("--no-early-stop") ? { noEarlyStop: true as const } : {}),
  };
}

/** `wordsP90=40,questionShare=0.6` as limits; a part that is not `name=number` keeps its text,
 * so the check of the limits names it. */
function styleLimits(text: string): StyleLimits {
  return Object.fromEntries(
    text.split(",").filter((part) => part.trim()).map((part) => {
      const [metric = "", limit = ""] = part.split("=").map((side) => side.trim());
      return [metric, limit === "" ? Number.NaN : Number(limit)];
    }),
  );
}

/** Which of the two parts a simulation model plays. */
export type SimulatorRole = "caller" | "judge";

/** What `curb test` runs scenarios on: the project's agent and LLM provider (fakes in tests). */
export type TestHost = {
  /** A fresh runtime + session for the project's agent, built the way a call builds them. */
  createBundle(): Promise<ScenarioBundle>;
  /** The LLM that plays the caller or judges the call, for an agent whose LLM is `llm`.
   * `onUsage` hears the tokens each of its requests used. */
  simulator(llm: LlmDescriptor, role: SimulatorRole, onUsage: (usage: AgentModelUsage) => void): AgentLlmClient;
  /** Which model plays each part, for the report. Throws when one has no key in this process. */
  models?(llm: LlmDescriptor): TestModels;
  /** What every request of this host shares about its provider's rate limit. The command has
   * it lower the run's concurrency, and reports how long the run waited. */
  throttle?: Throttle;
};

/** The model the simulated caller and the judge use for an agent on `llm`. KugelAudio and an
 * OpenAI-compatible endpoint serve only what they serve, so there it is the agent's own model. */
export function simulationLlm(llm: LlmDescriptor): LlmDescriptor {
  switch (llm.provider) {
    case "anthropic":
      return anthropic(SIMULATION_MODELS.anthropic);
    case "openai":
      return openai(SIMULATION_MODELS.openai);
    case "kugelaudio":
    case "openai-compatible":
      return llm;
  }
}

/**
 * The model `spec` names (`--caller-model`, `--judge-model`), for an agent on `llm`:
 * `<provider>:<model>` with openai, anthropic or kugelaudio, else a model of the agent's own
 * provider and endpoint. Without a spec, {@link simulationLlm}.
 */
export function modelFor(spec: string | undefined, llm: LlmDescriptor): LlmDescriptor {
  const named = spec?.trim();
  if (!named) return simulationLlm(llm);
  const [, provider, model] = /^(openai|anthropic|kugelaudio):(.+)$/.exec(named) ?? [];
  const on = provider ?? llm.provider;
  const id = model ?? named;
  switch (on) {
    case "openai":
      return openai(id);
    case "anthropic":
      return anthropic(id);
    case "kugelaudio":
      return kugelaudio.llm({ model: id as KugelaudioLlmModel });
    default:
      return llm.provider === "openai-compatible" ? { ...llm, options: { ...llm.options, model: id } } : llm;
  }
}

/** A model as a result names it: `provider:model`. */
export function modelLabel(llm: LlmDescriptor): string {
  return `${llm.provider}:${llm.options.model}`;
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

const NO_MODELS: TestModels = { agent: null, caller: null, judge: null };

/** How long a test session waits for one LLM request. Far beyond any single answer: the host's
 * retries hold each attempt to the real deadline, and a rate limit may take minutes to lift. */
const SESSION_PATIENCE_MS = 60 * 60_000;

/** What one `curb test` invocation runs with: the arguments, with the environment's defaults. */
type TestRunOptions = TestArgs & { concurrency: number; maxErrorRate: number };

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
  const run: TestRunOptions = {
    ...parsed,
    concurrency: parsed.concurrency ?? DEFAULT_CONCURRENCY,
    maxErrorRate: parsed.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE,
    callerModel: parsed.callerModel ?? env.CURB_TEST_CALLER_MODEL,
    judgeModel: parsed.judgeModel ?? env.CURB_TEST_JUDGE_MODEL,
  };
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
    const host = () => options.host ?? projectHost(run);
    const session = { projectRoot, run, out, loaded, started, env };
    return run.rejudge === undefined ? await runScenarios(session, host) : await rejudge(session, run.rejudge, host);
  } finally {
    restoreConsole();
  }
}

type TestSession = {
  projectRoot: string;
  run: TestRunOptions;
  out: (text: string) => void;
  loaded: LoadedScenario[];
  started: number;
  env: Readonly<Record<string, string | undefined>>;
};

const matches = (filter: string, entry: { name: string; file: string }) =>
  !filter || entry.name.toLowerCase().includes(filter.toLowerCase()) || entry.file.toLowerCase().includes(filter.toLowerCase());

const SKIPPED = "the token budget (--max-tokens) was spent before it ran";

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

/** The scenarios of a run that was cut short, as its file holds them: every one that ran. */
function inScenarioOrder<T>(byIndex: ReadonlyArray<T | undefined>): T[] {
  return byIndex.filter((entry): entry is T => entry !== undefined);
}

/**
 * Play the selected scenarios, as many conversations at a time as `--concurrency` allows across
 * all of them, report each in the scenarios' order, and save the run after each one.
 */
async function runScenarios(session: TestSession, hostOf: () => TestHost | Promise<TestHost>): Promise<number> {
  const { run, out, loaded } = session;
  const selected = loaded.filter((entry) => matches(run.filter, entry));
  if (selected.length === 0) {
    console.error(
      `No scenario matches "${run.filter}". The scenarios are: ${loaded.map((entry) => `${entry.name} (${entry.file})`).join(", ")}.`,
    );
    return TEST_EXIT_CODES.fail;
  }

  const host = await hostOf();
  const budget = new TokenBudget(run.maxTokens ?? null);
  const slots = new RunSlots(run.concurrency);
  host.throttle?.onSlowDown(() => void slots.lower());
  const saved = newSavedRun(run);
  const printed = inOrder(run.json ? () => {} : out, selected.length);
  const reports: ScenarioReport[] = [];
  const settingsOf: Array<SavedScenarioSettings | undefined> = [];
  const conversationsOf: Array<SavedConversation[] | undefined> = [];

  // Every bundle is the same agent, so the first one says which LLM it runs on. It is built
  // before any header (the first build logs the agent's authoring diagnostics, to stderr), and
  // the first run takes it.
  let spare: ScenarioBundle | null = selected.some((entry) => "scenario" in entry) ? await host.createBundle() : null;
  const llm = spare?.runtime.settings.current().llm;
  if (llm) saved.models = host.models?.(llm) ?? NO_MODELS;
  const createBundle = () => {
    const first = spare;
    spare = null;
    return first ? Promise.resolve(first) : host.createBundle();
  };

  const play = async (entry: LoadedScenario, index: number): Promise<ScenarioReport> => {
    const write = (text: string) => printed.write(index, text);
    write(`\n--- ${entry.name} (${entry.file})\n`);
    if ("error" in entry) {
      write(`FAIL ${entry.name}: ${entry.error}\n`);
      return { ...entry, passed: false };
    }
    const settings = scenarioSettings({ scenario: entry.scenario, name: entry.name, file: entry.file, runs: run.runs, style: run.style });
    const once = settings.runs === 1;
    const conversations: SavedConversation[] = [];
    const result = await runScenario({
      scenario: entry.scenario,
      name: entry.name,
      file: entry.file,
      createBundle,
      llms: (onUsage) => ({
        caller: host.simulator(llm!, "caller", (usage) => onUsage("caller", usage)),
        judge: host.simulator(llm!, "judge", (usage) => onUsage("judge", usage)),
      }),
      runs: run.runs,
      slots,
      maxErrorRate: run.maxErrorRate,
      earlyStop: !run.noEarlyStop,
      allowRealTools: run.allowRealTools === true,
      style: run.style,
      models: saved.models,
      budget,
      ...(once ? { onTurn: (turn: ScenarioTurn) => write(formatTurn(turn)) } : {}),
      onRun: (finished, conversation) => {
        conversations.push(conversation);
        if (!once) write(formatRunLine(finished, settings.runs));
      },
    });
    // The budget was spent before its first run: it did not run, and says nothing.
    if (result.stats.ran === 0 && result.stats.cutShort === "budget") {
      write(`not run: ${SKIPPED}\n`);
      return { name: entry.name, file: entry.file, passed: false, skipped: SKIPPED };
    }
    write(once ? formatChecks(result) : formatRepeated(result));
    settingsOf[index] = settings;
    conversationsOf[index] = conversations;
    saveTestRun(session.projectRoot, { ...saved, scenarios: inScenarioOrder(settingsOf), conversations: inScenarioOrder(conversationsOf).flat() });
    return result;
  };
  await Promise.all(
    selected.map(async (entry, index) => {
      try {
        reports[index] = await play(entry, index);
      } finally {
        printed.finish(index);
      }
    }),
  );
  if (run.maxTokens !== undefined && !budget.reported && conversationsOf.some((conversations) => conversations?.length)) {
    console.error("note: --max-tokens could not be held: the provider reported no token usage for any run.");
  }
  return finish(session, { ...saved, scenarios: inScenarioOrder(settingsOf), conversations: inScenarioOrder(conversationsOf).flat() }, reports, throttledBy(host, slots));
}

/** How the provider's rate limit slowed the run down; undefined when it did not. */
function throttledBy(host: TestHost, slots: RunSlots): TestReport["throttled"] {
  const stats = host.throttle?.stats();
  return stats && stats.waits > 0 ? { ...stats, concurrency: slots.limit } : undefined;
}

function newSavedRun(run: TestRunOptions): SavedTestRun {
  const now = new Date();
  return {
    format: "curb.test-run",
    version: 1,
    id: newTestRunId(now),
    createdAt: now.toISOString(),
    curb: curbVersion(),
    complete: false,
    models: NO_MODELS,
    callerPromptVersion: CALLER_PROMPT_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    maxErrorRate: run.maxErrorRate,
    scenarios: [],
    conversations: [],
  };
}

/** Save the finished run, print the report (and write it where it was asked for), and return
 * the exit code. */
function finish(session: TestSession, saved: SavedTestRun, scenarios: ScenarioReport[], throttled: TestReport["throttled"]): number {
  const { run, out, env, projectRoot } = session;
  const hasRuns = saved.conversations.length > 0;
  if (hasRuns) saveTestRun(projectRoot, { ...saved, complete: scenarios.every((entry) => !("skipped" in entry)) });
  const outcome = testOutcome(scenarios);
  const report: TestReport = {
    passed: scenarios.every((entry) => entry.passed),
    scenarios,
    outcome,
    exitCode: TEST_EXIT_CODES[outcome],
    durationMs: Math.round(performance.now() - session.started),
    models: saved.models,
    callerPromptVersion: saved.callerPromptVersion,
    judgePromptVersion: saved.judgePromptVersion,
    usage: sumUsage(scenarios.filter(isResult).map((result) => result.usage)),
    savedTo: hasRuns ? testRunPath(saved.id) : null,
    ...(saved.rejudgedFrom === undefined ? {} : { rejudgedFrom: saved.rejudgedFrom }),
    ...(throttled ? { throttled } : {}),
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
async function rejudge(session: TestSession, which: string, hostOf: () => TestHost | Promise<TestHost>): Promise<number> {
  const { run, out, loaded } = session;
  const source = loadTestRun(session.projectRoot, which);
  const selected = source.scenarios.filter((entry) => matches(run.filter, entry));
  if (selected.length === 0) {
    console.error(
      `No scenario of the saved run ${source.id} matches "${run.filter}". It holds: ${source.scenarios.map((entry) => `${entry.name} (${entry.file})`).join(", ")}.`,
    );
    return TEST_EXIT_CODES.fail;
  }

  const host = await hostOf();
  // The judge runs on the agent's provider, which only a bundle knows; no turn is played on it.
  const llm = (await host.createBundle()).runtime.settings.current().llm;
  const models = { ...(host.models?.(llm) ?? NO_MODELS), agent: source.models.agent, caller: source.models.caller };
  const saved: SavedTestRun = { ...newSavedRun(run), rejudgedFrom: source.id, models, callerPromptVersion: source.callerPromptVersion };
  const budget = new TokenBudget(run.maxTokens ?? null);
  const slots = new RunSlots(run.concurrency);
  host.throttle?.onSlowDown(() => void slots.lower());
  const printed = inOrder(run.json ? () => {} : out, selected.length);
  const reports: ScenarioReport[] = [];
  const settingsOf: Array<SavedScenarioSettings | undefined> = [];
  const conversationsOf: Array<SavedConversation[] | undefined> = [];

  const judgeAgain = async (was: SavedScenarioSettings, index: number): Promise<ScenarioReport> => {
    const startedAt = performance.now();
    const current = loaded.find((entry) => entry.file === was.file && entry.name === was.name);
    const scenario = current && "scenario" in current ? current.scenario : null;
    const settings: SavedScenarioSettings = scenario
      ? { ...scenarioSettings({ scenario, name: was.name, file: was.file, style: run.style }), runs: was.runs }
      : { ...was, style: { ...run.style, ...was.style } };
    const recorded = source.conversations.filter((entry) => entry.scenario.file === was.file && entry.scenario.name === was.name);
    const judged = await Promise.all(
      recorded.map(({ assessment: _before, ...record }) =>
        slots.run(async (): Promise<SavedConversation | null> => {
          if (budget.exhausted) return null;
          const judgeTokens = new TokenCounter();
          const assessment = await assessConversation({
            record,
            settings: scenario ? assessmentSettings(scenario) : { expectations: settings.expectations, failOn: settings.failOn },
            judge: host.simulator(llm, "judge", judgeTokens.add),
            judgeModel: models.judge,
          });
          budget.spend(runUsage({ agent: null, caller: null, judge: judgeTokens.total() }));
          const usage = runUsage({ agent: record.usage?.agent ?? null, caller: record.usage?.caller ?? null, judge: judgeTokens.total() });
          return { ...record, usage, assessment };
        }),
      ),
    );
    const conversations = judged.filter((conversation) => conversation !== null);
    if (conversations.length === 0) return { name: was.name, file: was.file, passed: false, skipped: SKIPPED };
    const result = aggregateScenario({
      settings,
      conversations,
      maxErrorRate: run.maxErrorRate,
      durationMs: Math.round(performance.now() - startedAt),
      notes: scenario ? [] : [`${was.file} no longer holds a scenario named "${was.name}": its saved settings were applied, and its expect was not`],
      ...(conversations.length < recorded.length ? { cutShort: "budget" as const } : {}),
    });
    settingsOf[index] = settings;
    conversationsOf[index] = conversations;
    printed.write(index, `\n--- ${was.name} (${was.file})\n${formatReplayed(result)}`);
    return result;
  };
  await Promise.all(
    selected.map(async (was, index) => {
      try {
        reports[index] = await judgeAgain(was, index);
      } finally {
        printed.finish(index);
      }
    }),
  );
  return finish(session, { ...saved, scenarios: inScenarioOrder(settingsOf), conversations: inScenarioOrder(conversationsOf).flat() }, reports, throttledBy(host, slots));
}

/** A re-judged scenario as the report prints it: the transcript first when it ran once. */
function formatReplayed(result: ScenarioResult): string {
  if (result.stats.runs > 1 || result.runs.length !== 1) return formatRepeated(result);
  return `${result.turns.map(formatTurn).join("")}${formatChecks(result)}`;
}

/**
 * The project's agent on the bundle path a call uses (`createVoiceAgentBundle`), which refuses
 * to start, naming the variable, when the agent's LLM key is missing. Conversation recording is
 * turned off first: the store is for real conversations, and every scenario would add one.
 * Every LLM request (the agent's, the caller's, the judge's) is sent again when the provider
 * says to, and counts its tokens.
 *
 * Loading the agent logs every authoring diagnostic, as a server boot does. That is curb
 * check's report and would bury the transcripts, so it becomes one note pointing there.
 */
async function projectHost(run: Pick<TestArgs, "callerModel" | "judgeModel">): Promise<TestHost> {
  await disableConversationRecording();
  const { getHostedAgent } = await import("../server/bootstrap.js");
  const restoreConsole = dropDiagnosticLogs();
  let diagnostics: Awaited<ReturnType<typeof getHostedAgent>>["diagnostics"];
  try {
    ({ diagnostics } = await getHostedAgent());
  } finally {
    restoreConsole();
  }
  const note = diagnosticsNote(diagnostics);
  if (note) console.error(`note: ${note}`);
  const { createVoiceAgentBundle } = await import("../voice-host.js");
  const { missingLlmCredential, runAiSdkAgent } = await import("../llm/ai-sdk.js");
  const { llmTimeoutFromEnv } = await import("../llm/deadline.js");
  // One throttle for every request of the run, the agent's, the caller's and the judge's: a
  // provider counts them against one limit. The provider SDK's own retries are off, so each
  // rate limit is seen here, where the whole run can slow down for it.
  const throttle = new Throttle();
  const agentTimeoutMs = llmTimeoutFromEnv();
  const chosen = { caller: run.callerModel, judge: run.judgeModel };
  const options = { caller: "--caller-model", judge: "--judge-model" } as const;
  /** The model of a part, refused when this process has no key for it. */
  const modelOf = (role: SimulatorRole, llm: LlmDescriptor): LlmDescriptor => {
    const model = modelFor(chosen[role], llm);
    const missing = missingLlmCredential(model);
    if (missing) {
      throw new Error(
        `[CURB_TEST_MODEL_KEY_MISSING] The ${role}'s model ${modelLabel(model)} needs ${missing}, and this process does not have it.\n` +
          `Fix: set ${missing} in the project's .env, or pick a model of the agent's own provider with ${options[role]} <model>.`,
      );
    }
    return model;
  };
  return {
    async createBundle() {
      const tokens = new TokenCounter();
      let failed = 0;
      const retry = { throttle, timeoutMs: agentTimeoutMs, onGiveUp: () => void (failed += 1) };
      const { runtime, session, definition } = await createVoiceAgentBundle(undefined, (transports) => {
        const { llm, streamLlm } = transports({ onUsage: tokens.add, maxRetries: 0 });
        // Each attempt has the session's deadline; the session itself waits as long as a rate
        // limit takes, which the retries bound.
        return { llm: withRetries(llm, retry), streamLlm: withStreamRetries(streamLlm, retry), llmTimeoutMs: SESSION_PATIENCE_MS };
      });
      return {
        runtime,
        session,
        firstTurn: definition.firstTurn,
        experiments: experimentDeclarations(definition.experiments),
        tokens: () => tokens.total(),
        providerErrors: () => failed,
      };
    },
    simulator(llm, role, onUsage) {
      const model = modelOf(role, llm);
      return withRetries((request) => runAiSdkAgent(request, { llm: model, onUsage, maxRetries: 0 }), { throttle, timeoutMs: ANSWER_TIMEOUT_MS });
    },
    models: (llm) => ({ agent: modelLabel(llm), caller: modelLabel(modelOf("caller", llm)), judge: modelLabel(modelOf("judge", llm)) }),
    throttle,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
