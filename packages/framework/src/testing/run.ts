import type { AgentLlmClient, AgentSession } from "../agent-session.js";
import { snapshotAgentStores } from "../agent-state.js";
import type { AgentFirstTurn } from "../config.js";
import { experimentInfo, type ExperimentDeclaration } from "../experiments.js";
import { assignExperiments, forcedVariant } from "../experiments.node.js";
import type { AgentModelUsage } from "../llm/ai-sdk.js";
import { declinedNote, unclearNote, type ConfirmationVerdict, type PendingConfirmation } from "../llm/confirmation.js";
import { agentLanguage } from "../llm/localized.js";
import type { AgentChatMessage } from "../llm/types.js";
import type { AgentSiteRuntime, ToolFake } from "../runtime.js";
import { clientInfo } from "../server/protocol.js";
import { SKIP_TURN_TOOL_NAME, type ToolResult } from "../types.js";
import { aggregateScenario, scenarioRun, type ScenarioResult, type ScenarioRun } from "./aggregate.js";
import { assessConversation, assessmentSettings } from "./assess.js";
import { askCallerAfterHangUp, nextCallerLine } from "./caller.js";
import { fallbackLineIn, type ScenarioEndedBy } from "./checks.js";
import type { CallerEnding, ScenarioRecord, EndState, RecordedTool, SavedConversation, SavedScenarioSettings, TestModels } from "./record.js";
import { describeProviderError } from "./resilience.js";
import { installFakes, playOpening, playTurn, scenarioTurn, endStateOf, type PlayedTurn } from "./call.js";
import { RunSlots } from "./parallel.js";

export { installFakes, playOpening, playTurn, toolCallsOf, type InstalledFakes, type PlayedTurn } from "./call.js";
export { RunSlots } from "./parallel.js";
import {
  DEFAULT_MAX_TURNS,
  toolResultProblem,
  type Scenario,
  type ScenarioConfirmation,
  type ScenarioFake,
  type ScenarioToolCall,
  type ScenarioTurn,
  type ScenarioTurnError,
} from "./scenario.js";
import { TokenCounter, runUsage, type TokenUsage } from "./usage.js";

/** The agent one scenario talks to: a fresh runtime and session, built the way a call builds them. */
export type ScenarioBundle = {
  runtime: AgentSiteRuntime;
  session: AgentSession;
  /** `defineAgent({ firstTurn })`: with "agent", the agent opens the call with a greeting. The
   * session itself opens with the fixed line of `{ say }`. */
  firstTurn?: AgentFirstTurn;
  /** `defineAgent({ experiments })` as the bundle manifest carries them: the call gets one variant
   * of each, the scenario's own or drawn as a call would draw it. */
  experiments?: readonly ExperimentDeclaration[];
  /** The tokens the agent's LLM requests used on this bundle so far; null while its provider
   * reported none. */
  tokens?: () => TokenUsage | null;
  /** How many of the agent's LLM requests failed for good on this bundle so far (after the
   * retries). A turn that failed while this went up failed on the provider, not on the agent. */
  providerErrors?: () => number;
};

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
function uncoveredVariants(experiments: readonly ExperimentDeclaration[], scenario: Scenario, covered: ReadonlyArray<Record<string, string>>): string[] {
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

/** A tool call as `curb test` and `curb say` print it: held, faked, ok, or refused with the reason. */
export function toolCallLine(call: ScenarioToolCall): string {
  const input = JSON.stringify(call.input);
  if (call.heldFor !== undefined) return `[tool ${call.name} held] ${input} -> runs on the caller's yes to "${call.heldFor}"`;
  const reason = !call.ok && call.result?.message ? ` -> ${call.result.message}` : "";
  return `[tool ${call.name} ${call.faked ? "faked" : call.ok ? "ok" : "refused"}] ${input}${reason}`;
}

/** The caller's answer to a held action as `curb test` and `curb say` print it: the verdict, the
 * words, and what became of the tool. */
export function confirmationLine({ tool, answer, verdict, ran }: ScenarioConfirmation): string {
  const outcome = verdict === "unclear" ? "still waits for the caller's yes" : ran ? "ran" : "did not run";
  return `[confirmation ${verdict}] ${JSON.stringify(answer)}: ${tool} ${outcome}`;
}

export type { ScenarioResult, ScenarioRun } from "./aggregate.js";

/** Conversations in flight at once when nothing says otherwise, and the most that may be asked for. */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
/** The share of a scenario's runs that may be errors before the scenario itself is one: one run
 * in three, so that a single provider hiccup does not void a scenario that runs three times. */
export const DEFAULT_MAX_ERROR_RATE = 0.34;

/** The LLMs that play the caller and judge one run. */
export type RunLlms = { caller: AgentLlmClient; judge: AgentLlmClient };

/** How often a scenario runs: its own `runs`, which `requested` (`curb test --runs`) overrides
 * for a simulated caller. Scripted lines say the same words every time and run once unless the
 * scenario itself asks for more. */
export function plannedRuns(scenario: Scenario, requested?: number): number {
  return (scenario.caller ? requested : undefined) ?? scenario.runs ?? 1;
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
    failOn: [...(scenario.failOn ?? [])],
    style: { ...scenario.style },
  };
}

/**
 * Run one scenario: each run a conversation of its own on a fresh bundle, as many at a time as
 * `slots` has room for, each assessed as it ends (`assess.ts`), all summed up into one result
 * (`aggregate.ts`). Every run that was asked for runs.
 *
 * A conversation runs as a call: the scenario's fakes in place and its page info (`client`) on
 * the conversation first, then the agent's opening (its greeting or fixed line) when it speaks
 * first, then every caller line as a spoken turn on the bundle's session, with `end_call`
 * attached the way a live call attaches it. It stops when the agent hangs up, the caller hangs
 * up or runs out of lines, `maxTurns` is reached, or a turn reports an error.
 *
 * A tool runs for real on every run unless the scenario fakes it; undoing what it did is the
 * scenario author's business.
 */
export async function runScenario(params: {
  scenario: Scenario;
  name: string;
  file: string;
  /** The bundle of a scenario that runs once. Give this or `createBundle`. */
  bundle?: ScenarioBundle;
  /** A fresh bundle for each run. */
  createBundle?: () => Promise<ScenarioBundle>;
  /** The LLM that plays the caller and judges, when their tokens need no counting. A scripted
   * scenario without `expectations` never calls it. Give this or `llms`. */
  simulator?: AgentLlmClient;
  /** The caller's and the judge's LLM for one run; `onUsage` hears the tokens each used. */
  llms?: (onUsage: (role: "caller" | "judge", usage: AgentModelUsage) => void) => RunLlms;
  /** `curb test --runs`: the runs of a simulated-caller scenario. */
  runs?: number;
  /** The slots its runs wait for: shared with the other scenarios of the run. Default: its own. */
  slots?: RunSlots;
  maxErrorRate?: number;
  /** Stamped into each run's judge result. */
  models?: TestModels;
  /** Called with each turn as soon as it is over, so a report can print the call as it goes.
   * Only a scenario that runs once reports its turns. */
  onTurn?: (turn: ScenarioTurn) => void;
  /** Called with each run when it is assessed, with its conversation as it is saved. */
  onRun?: (run: ScenarioRun, conversation: SavedConversation) => void;
}): Promise<ScenarioResult> {
  const started = performance.now();
  const { scenario } = params;
  const settings = scenarioSettings(params);
  const maxErrorRate = params.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const slots = params.slots ?? new RunSlots(DEFAULT_CONCURRENCY);
  const createBundle = params.createBundle ?? (() => Promise.resolve(params.bundle!));
  if (!params.createBundle && settings.runs > 1) {
    throw new Error(`curb: scenario "${params.name}" runs ${settings.runs} times and needs a bundle for each: pass createBundle.`);
  }

  const conversations: SavedConversation[] = [];
  const covered: Array<Record<string, string>> = [];
  let declared: readonly ExperimentDeclaration[] = [];
  let next = 0;

  /** One run, in a slot of its own. Which run it is is read once the slot is free. */
  const runNext = async () => {
    if (next >= settings.runs) return;
    const run = next;
    next += 1;

    const bundle = await createBundle();
    declared = bundle.experiments ?? [];
    const counters = { caller: new TokenCounter(), judge: new TokenCounter() };
    const llms = params.llms?.((role, usage) => counters[role].add(usage)) ?? { caller: params.simulator!, judge: params.simulator! };
    const record = await playConversation({
      scenario,
      name: params.name,
      file: params.file,
      run,
      bundle,
      caller: llms.caller,
      ...(settings.runs === 1 && params.onTurn ? { onTurn: params.onTurn } : {}),
    });
    const assessment = await assessConversation({
      record,
      settings: assessmentSettings(scenario),
      judge: llms.judge,
      judgeModel: params.models?.judge ?? null,
    });
    const usage = runUsage({ agent: bundle.tokens?.() ?? null, caller: counters.caller.total(), judge: counters.judge.total() });
    const conversation: SavedConversation = { ...record, usage, assessment };
    covered.push(conversation.experiments);
    conversations.push(conversation);
    params.onRun?.(scenarioRun(conversation), conversation);
  };
  const worker = async () => {
    while (next < settings.runs) await slots.run(runNext);
  };
  await Promise.all(Array.from({ length: Math.min(settings.runs, slots.limit) }, worker));

  return aggregateScenario({
    settings,
    conversations,
    maxErrorRate,
    durationMs: Math.round(performance.now() - started),
    notes: uncoveredVariants(declared, scenario, covered),
  });
}

/** Play one conversation of a scenario on `bundle` and return its record. */
async function playConversation(params: {
  scenario: Scenario;
  name: string;
  file: string;
  /** 0 for the first run. */
  run: number;
  bundle: ScenarioBundle;
  caller: AgentLlmClient;
  onTurn?: (turn: ScenarioTurn) => void;
}): Promise<ScenarioRecord> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { scenario, bundle } = params;
  let hungUp = false;
  bundle.runtime.setEndCallRequest(() => {
    hungUp = true;
  });
  const fakes = scenario.fakes ? installFakes(bundle.runtime, scenario.fakes) : null;

  // Tools come and go with the agent's state, so every render is looked at: the judge is told
  // each tool the model was offered at some point, without the framework's own.
  const offered = new Map<string, RecordedTool>();
  const noteTools = () => {
    for (const tool of bundle.runtime.snapshot().context.tools) {
      if (tool.scope !== "runtime") offered.set(tool.name, { name: tool.name, description: tool.description });
    }
  };
  noteTools();
  const stopNotingTools = bundle.runtime.subscribe(noteTools);

  const turns: ScenarioTurn[] = [];
  let endedBy: ScenarioEndedBy | null = null;
  let stopReason: string | undefined;
  let providerError = false;
  /** Play one turn (number 0: the opening, no caller line), record it and note when it ends the call. */
  const take = async (play: () => Promise<PlayedTurn | null>, caller: string | null, number: number) => {
    const failedBefore = bundle.providerErrors?.() ?? 0;
    const played = await play();
    if (!played) return;
    const turn = scenarioTurn(bundle.runtime, played, caller, number, fakes);
    turn.endedCall = hungUp;
    turns.push(turn);
    params.onTurn?.(turn);
    if (turn.errors.length > 0) {
      endedBy = "error";
      stopReason = turn.errors.map((error) => `${error.kind}: ${error.message}`).join("; ");
      // A request that timed out, or failed for good on the provider, is not the agent's doing.
      providerError = turn.errors.some((error) => error.kind === "timeout") || (bundle.providerErrors?.() ?? 0) > failedBefore;
    } else if (turn.endedCall) {
      endedBy = "agent";
    }
  };

  // The page the call came from and the call's experiment variants, before the call opens: the
  // opening may read them.
  const experiments = runVariants({ file: params.file, name: params.name }, bundle.experiments ?? [], scenario, params.run);
  const callInfo = { ...clientInfo(scenario.client ?? {}), ...experimentInfo(experiments) };
  if (Object.keys(callInfo).length > 0) bundle.session.updateInfo(callInfo);
  await take(() => playOpening(bundle.session, bundle.firstTurn), null, 0);

  const lines = scenario.turns;
  const maxTurns = scenario.maxTurns ?? lines?.length ?? DEFAULT_MAX_TURNS;
  const language = scenario.caller?.language ?? agentLanguage(bundle.runtime.settings.view());
  let callerEnding: CallerEnding | null = null;
  let said = 0;
  while (endedBy === null) {
    if (lines && said >= lines.length) {
      endedBy = "script";
      break;
    }
    if (said >= maxTurns) {
      endedBy = "max_turns";
      break;
    }
    let line = lines?.[said];
    let ends: CallerEnding | null = null;
    if (line === undefined) {
      try {
        const answer = await nextCallerLine({ llm: params.caller, caller: scenario.caller!, language, turns });
        ends = answer.end && { done: true, ...answer.end };
        line = answer.line;
      } catch (error) {
        endedBy = "simulator";
        stopReason = describeProviderError(error);
        break;
      }
      if (!line) {
        endedBy = "caller";
        callerEnding = ends;
        break;
      }
    }
    said += 1;
    const spoken = line;
    // On an agent with `s2s` this text goes to the back office, whose turns carry no spoken rules.
    await take(() => playTurn(bundle.session, spoken, undefined, !bundle.runtime.settings.s2s()), spoken, said);
    if (ends) {
      callerEnding = ends;
      endedBy ??= "caller";
    }
  }
  stopNotingTools();
  // Turns set it from a callback, which the compiler does not follow.
  const ended = endedBy as ScenarioEndedBy;

  // The agent hung up on a line of the caller's that did not say it was done: ask the caller.
  if (ended === "agent" && scenario.caller && !callerEnding) {
    callerEnding = await callerAfterHangUp(params.caller, scenario, language, turns);
  }

  return {
    format: "curb.conversation",
    version: 1,
    source: "scenario",
    scenario: { name: params.name, file: params.file, mode: scenario.caller ? "simulated" : "scripted", run: params.run + 1 },
    caller: scenario.caller ?? null,
    experiments,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    turns,
    tools: [...offered.values()],
    ending: {
      by: ended,
      ...(stopReason === undefined ? {} : { reason: stopReason }),
      unsaid: [...(lines?.slice(said) ?? [])],
      maxTurns,
      ...(providerError ? { providerError: true as const } : {}),
      caller: callerEnding,
    },
    endState: endStateOf(bundle.runtime),
    unusedFakes: fakes?.unused() ?? [],
    usage: null,
  };
}

/** What the caller says about a call the agent ended; null when it cannot be asked or read. */
async function callerAfterHangUp(
  llm: AgentLlmClient,
  scenario: Scenario,
  language: string,
  turns: readonly ScenarioTurn[],
): Promise<CallerEnding | null> {
  try {
    const answer = await askCallerAfterHangUp({ llm, caller: scenario.caller!, language, turns });
    if (!answer) return null;
    return answer.done ? { done: true, ...answer.end } : { done: false, goalMet: null, reason: answer.wanted };
  } catch {
    // KEEP-JUSTIFIED: no answer IS the answer "the caller did not say"; the hang-up check reports it.
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
