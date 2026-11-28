import { assignExperiments, forcedVariant } from "../../experiments.node.js";
import {
  converse,
  inParallel,
  scriptedCaller,
  simulatedCaller,
  startCall,
  testModel,
  type Call,
  type Scenario,
  type ScenarioTurn,
  type TestHost,
} from "../../testing/index.js";
import { aggregateScenario, scenarioRun, type ScenarioResult, type ScenarioRun } from "./aggregate.js";
import { acrossRunsChecks, assessConversation, assessmentSettings } from "./assess.js";
import type { ExperimentDeclaration, SavedConversation, SavedScenarioSettings } from "./types.js";
import { runUsage } from "./usage.js";
import type { RunUsage } from "./types.js";

/**
 * How `curb test` runs a scenario, from the public functions of `curb/testing`: each run is
 * `startCall` with the scenario's fakes, page info and variants, `converse` with its caller, then
 * the checks and the judge on the record (`assess.ts`), and the runs sum up into one result
 * (`aggregate.ts`).
 */

export type { ScenarioResult, ScenarioRun } from "./aggregate.js";

/** Conversations in flight at once when nothing says otherwise, and the most that may be asked for. */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
/** The share of a scenario's runs that may be errors before the scenario itself is one: one run
 * in three, so that a single provider hiccup does not void a scenario that runs three times. */
export const DEFAULT_MAX_ERROR_RATE = 0.34;

/** Whether a scenario's runs so far hold more errors than `maxErrorRate` allows of its `runs`:
 * however its other runs end, it cannot be assessed, so they are not started. */
export function cannotBeAssessed(conversations: readonly SavedConversation[], runs: number, maxErrorRate: number): boolean {
  return conversations.filter((conversation) => conversation.assessment.outcome === "error").length > maxErrorRate * runs;
}

/** The note of a scenario whose last `notStarted` runs were not started ({@link cannotBeAssessed}); none when all ran. */
export function notStartedNote(conversations: readonly SavedConversation[], runs: number, notStarted: number, maxErrorRate: number): string[] {
  if (notStarted === 0) return [];
  const errors = conversations.filter((conversation) => conversation.assessment.outcome === "error").length;
  return [
    `${notStarted} of ${runs} run(s) not started: ${errors} error(s) already, more than the ${Math.round(maxErrorRate * 100)}% of its runs a scenario may have, so it cannot be assessed`,
  ];
}

/** How often a scenario runs: `requested` (`curb test --runs`), else its own `runs`, else once.
 * Scripted lines say the same words every time, but the agent does not answer them the same way
 * every time: a fault that shows once in ten runs shows only when they run ten times. */
export function plannedRuns(scenario: Scenario, requested?: number): number {
  return requested ?? scenario.runs ?? 1;
}

/** What a scenario asks of its runs, as it is saved beside them. */
export function scenarioSettings(params: {
  scenario: Scenario;
  name: string;
  file: string;
  /** `curb test --runs`. */
  runs?: number;
}): SavedScenarioSettings {
  const { scenario } = params;
  return {
    name: params.name,
    file: params.file,
    mode: scenario.caller ? "simulated" : "scripted",
    runs: plannedRuns(scenario, params.runs),
    minPassRate: scenario.minPassRate ?? 1,
    expectations: [...(scenario.expectations ?? [])],
    ...(scenario.findings ? { findings: { ...scenario.findings } } : {}),
    failOn: [...(scenario.failOn ?? [])],
    style: { ...scenario.style },
  };
}

/** Which scenario a run belongs to, and how its models are chosen. */
export type ScenarioRunParams = {
  scenario: Scenario;
  name: string;
  file: string;
  host: TestHost;
  /** `--caller-model` and `--judge-model`. */
  callerModel?: string;
  judgeModel?: string;
  /** `--hermetic`: every run is hermetic, whatever the scenario says. */
  hermetic?: boolean;
};

/**
 * One run of a scenario (`run` from 0): a call as a call runs, the scenario's fakes in place and
 * its page info and the run's variants on it before the agent opens, played with its caller
 * until the agent hangs up, the caller hangs up or runs out of lines, `maxTurns` is reached, or a
 * turn reports an error; then assessed. A tool without a fake runs for real, unless the run is
 * hermetic (the scenario's `hermetic` or `--hermetic`): then calling it ends the run as an error. `onCall` hears the
 * call when it starts, `onDeclared` the agent's experiments, `onTurn` each turn as it ends.
 */
export async function playRun(
  params: ScenarioRunParams & {
    run: number;
    onTurn?: (turn: ScenarioTurn) => void;
    onCall?: (call: Call) => void;
    onDeclared?: (declared: readonly ExperimentDeclaration[]) => void;
  },
): Promise<SavedConversation> {
  const { scenario, name, file, host, run } = params;
  const call = await startCall({
    host,
    ...(scenario.fakes ? { fakes: scenario.fakes } : {}),
    ...(scenario.client ? { client: scenario.client } : {}),
    ...(params.hermetic || scenario.hermetic ? { hermetic: true } : {}),
    experiments: (declared) => {
      params.onDeclared?.(declared);
      return runVariants({ file, name }, declared, scenario, run);
    },
  });
  params.onCall?.(call);
  const callerModel = await testModel({ host, role: "caller", ...(params.callerModel === undefined ? {} : { model: params.callerModel }) });
  const judgeModel = await testModel({ host, role: "judge", ...(params.judgeModel === undefined ? {} : { model: params.judgeModel }) });
  const caller =
    typeof scenario.caller === "function"
      ? scenario.caller
      : scenario.caller
        ? simulatedCaller(scenario.caller, { model: callerModel })
        : scriptedCaller(scenario.turns!);
  const played = await converse(call, caller, {
    ...(scenario.maxTurns === undefined ? {} : { maxTurns: scenario.maxTurns }),
    ...(params.onTurn ? { onTurn: params.onTurn } : {}),
  });
  const { format, version, source: _call, ...rest } = played;
  const record = {
    format,
    version,
    source: "scenario" as const,
    scenario: { name, file, mode: scenario.caller ? ("simulated" as const) : ("scripted" as const), run: run + 1 },
    ...rest,
  } as Omit<SavedConversation, "assessment">;
  const assessment = await assessConversation({ record, settings: assessmentSettings(scenario), judge: judgeModel });
  const usage = runUsage({ agent: played.usage?.agent ?? null, caller: callerModel.usage(), judge: judgeModel.usage() });
  return { ...record, usage, assessment };
}

/**
 * Run one scenario: each run a conversation of its own on a fresh agent of `host`, `concurrency`
 * at a time, each assessed as it ends, all summed up into one result. Every run that was asked
 * for runs, unless so many were errors that the scenario cannot be assessed
 * ({@link cannotBeAssessed}). `curb test` plays the runs of all its scenarios through one
 * `inParallel` instead.
 */
export async function runScenario(
  params: ScenarioRunParams & {
    /** `curb test --runs`: the runs of the scenario, in place of its own `runs`. */
    runs?: number;
    concurrency?: number;
    maxErrorRate?: number;
    /** Called with each turn as soon as it is over. Only a scenario that runs once reports its turns. */
    onTurn?: (turn: ScenarioTurn) => void;
    /** Called with each run when it is assessed, with its conversation as it is saved. */
    onRun?: (run: ScenarioRun, conversation: SavedConversation) => void;
  },
): Promise<ScenarioResult> {
  const started = performance.now();
  const settings = scenarioSettings(params);
  let declared: readonly ExperimentDeclaration[] = [];
  const conversations: SavedConversation[] = [];
  const maxErrorRate = params.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  let notStarted = 0;
  await inParallel(
    Array.from({ length: settings.runs }, (_, run) => run),
    async (run) => {
      if (cannotBeAssessed(conversations, settings.runs, maxErrorRate)) {
        notStarted += 1;
        return;
      }
      const conversation = await playRun({
        ...params,
        run,
        onDeclared: (experiments) => void (declared = experiments),
        ...(settings.runs === 1 && params.onTurn ? { onTurn: params.onTurn } : {}),
      });
      conversations.push(conversation);
      params.onRun?.(scenarioRun(conversation), conversation);
    },
    { concurrency: params.concurrency ?? DEFAULT_CONCURRENCY, host: params.host },
  );
  return summarizeScenario({
    scenario: params.scenario,
    host: params.host,
    ...(params.judgeModel === undefined ? {} : { judgeModel: params.judgeModel }),
    settings,
    conversations,
    maxErrorRate,
    durationMs: Math.round(performance.now() - started),
    notes: [
      ...notStartedNote(conversations, settings.runs, notStarted, maxErrorRate),
      ...uncoveredVariants(declared, params.scenario, conversations.map((conversation) => conversation.experiments)),
    ],
  });
}

/**
 * A scenario's runs summed up into one result: its checks across all runs first (`expectRuns`,
 * when the scenario is in the project and has them), on a judge model of their own, then
 * `aggregateScenario`.
 */
export async function summarizeScenario(
  params: Parameters<typeof aggregateScenario>[0] & { scenario: Scenario | null; host: TestHost; judgeModel?: string },
): Promise<ScenarioResult> {
  const { scenario, host, judgeModel, ...rest } = params;
  let acrossRuns: { checks: ScenarioResult["checks"]; usage: RunUsage | null } | undefined;
  if (scenario?.expectRuns) {
    const judge = await testModel({ host, role: "judge", ...(judgeModel === undefined ? {} : { model: judgeModel }) });
    const checks = await acrossRunsChecks(scenario.expectRuns, rest.conversations, judge);
    if (checks) acrossRuns = { checks, usage: runUsage({ agent: null, caller: null, judge: judge.usage() }) };
  }
  return aggregateScenario({ ...rest, ...(acrossRuns ? { acrossRuns } : {}) });
}

/**
 * The variant the scenario's call gets in each experiment: the one `scenario.experiments` pins,
 * else drawn by the hosting platform's rule (`experiments.node.ts`) for the session id
 * `scenario:<file>:<name>` and the scenario's page info. Seeded by the scenario rather than drawn
 * afresh, so a scenario gets the same variants on every run and passes or fails the same way.
 * Throws, naming each one, when a pin names an experiment or a variant the agent does not declare.
 */
export function scenarioVariants(
  scenarioId: { file: string; name: string },
  experiments: readonly ExperimentDeclaration[],
  scenario: Scenario,
): Record<string, string> {
  const { file, name } = scenarioId;
  const pins = scenario.experiments ?? {};
  const listed = (names: readonly string[]) => (names.length > 0 ? names.map((item) => `"${item}"`).join(", ") : "none");
  const problems = Object.entries(pins).flatMap(([experimentName, variant]) => {
    const experiment = experiments.find((candidate) => candidate.name === experimentName);
    if (!experiment) {
      return [`experiments.${experimentName}: the agent declares no such experiment (it declares ${listed(experiments.map((item) => item.name))}).`];
    }
    if (!experiment.variants.some((candidate) => candidate.name === variant)) {
      return [`experiments.${experimentName}: "${variant}" is not one of its variants (${listed(experiment.variants.map((item) => item.name))}).`];
    }
    return [];
  });
  if (problems.length > 0) throw new Error(`scenario "${name}": ${problems.join(" ")}`);
  return { ...assignExperiments(experiments, scenarioSessionId(file, name), scenario.client ?? {}), ...pins };
}

/**
 * The variants of one run of a scenario. Its first run gets what {@link scenarioVariants} gives,
 * as a scenario that runs once always has. Each further run moves every experiment the scenario
 * leaves open (not pinned, and not picked by its page info) on to its next variant, so that
 * repeated runs cover every variant of every experiment instead of testing one of them N times.
 */
export function runVariants(
  scenarioId: { file: string; name: string },
  experiments: readonly ExperimentDeclaration[],
  scenario: Scenario,
  run: number,
): Record<string, string> {
  const first = scenarioVariants(scenarioId, experiments, scenario);
  const moved = openExperiments(experiments, scenario).map((experiment) => {
    const names = drawable(experiment);
    return [experiment.name, names[(names.indexOf(first[experiment.name]!) + run) % names.length]!];
  });
  return { ...first, ...Object.fromEntries(moved) };
}

/** The variants a call can draw: those with a weight. */
const drawable = (experiment: ExperimentDeclaration) => experiment.variants.filter((variant) => variant.weight > 0).map((variant) => variant.name);

/** The experiments whose variant the scenario leaves to the draw. */
function openExperiments(experiments: readonly ExperimentDeclaration[], scenario: Scenario): ExperimentDeclaration[] {
  return experiments.filter(
    (experiment) => !Object.hasOwn(scenario.experiments ?? {}, experiment.name) && forcedVariant(experiment, scenario.client ?? {}) === undefined,
  );
}

/** One note per open experiment whose variants `runs` runs do not all reach, naming them. */
export function uncoveredVariants(experiments: readonly ExperimentDeclaration[], scenario: Scenario, covered: ReadonlyArray<Record<string, string>>): string[] {
  return openExperiments(experiments, scenario).flatMap((experiment) => {
    const seen = new Set(covered.map((variants) => variants[experiment.name]));
    const missed = drawable(experiment).filter((variant) => !seen.has(variant));
    if (missed.length === 0) return [];
    return [
      `experiment ${experiment.name}: ${covered.length} run(s) covered ${[...seen].map((variant) => `"${variant}"`).join(", ")} and not ${missed.map((variant) => `"${variant}"`).join(", ")}; ` +
        `run it ${drawable(experiment).length} times (runs) to cover every variant, or pin one (experiments: { ${experiment.name}: ... })`,
    ];
  });
}

/** The session id a scenario's variants are drawn for: the same on every run of it. */
export function scenarioSessionId(file: string, name: string): string {
  return `scenario:${file}:${name}`;
}

