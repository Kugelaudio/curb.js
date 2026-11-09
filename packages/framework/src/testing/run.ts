import type { AgentLlmClient, AgentSession } from "../agent-session.js";
import type { AgentFirstTurn } from "../config.js";
import { experimentInfo, type ExperimentDeclaration } from "../experiments.js";
import { assignExperiments } from "../experiments.node.js";
import { declinedNote, unclearNote, type ConfirmationVerdict, type PendingConfirmation } from "../llm/confirmation.js";
import { agentLanguage } from "../llm/localized.js";
import type { AgentChatMessage } from "../llm/types.js";
import type { AgentSiteRuntime, ToolFake } from "../runtime.js";
import { clientInfo } from "../server/protocol.js";
import { SKIP_TURN_TOOL_NAME, type ToolResult } from "../types.js";
import { judgeGoal, nextCallerLine } from "./caller.js";
import { builtInChecks, expectContext, fallbackLineIn, goalCheck, type ScenarioEndedBy } from "./checks.js";
import {
  DEFAULT_MAX_TURNS,
  toolResultProblem,
  type Scenario,
  type ScenarioCheck,
  type ScenarioConfirmation,
  type ScenarioFake,
  type ScenarioToolCall,
  type ScenarioTurn,
  type ScenarioTurnError,
} from "./scenario.js";

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

/** The session id a scenario's variants are drawn for: the same on every run of it. */
export function scenarioSessionId(file: string, name: string): string {
  return `scenario:${file}:${name}`;
}

/** What one turn of a call did on a text route: the words the caller heard, the errors, the
 * transcript messages it added, and how the caller's words answered an action waiting for
 * their yes (null when none waited). */
export type PlayedTurn = {
  reply: string;
  errors: ScenarioTurnError[];
  messages: AgentChatMessage[];
  confirmation: ScenarioConfirmation | null;
};

/** One spoken turn on the session, as a call runs it: the caller's line, or (`synthetic`) the
 * framework's own input. */
export async function playTurn(session: AgentSession, text: string, kind?: "synthetic", spoken = true): Promise<PlayedTurn> {
  const before = session.messages.length;
  // The caller's line answers the action waiting for their yes, if one waits; framework input never does.
  const pending = kind ? null : session.pendingConfirmation;
  const errors: ScenarioTurnError[] = [];
  let reply = "";
  for await (const event of session.runTurnStream(text, { spoken, ...(kind ? { kind } : {}) })) {
    if (event.type === "error") errors.push({ kind: event.error.kind, message: event.error.message });
    else if (event.type === "done") reply = event.reply;
  }
  const messages = session.messages.slice(before);
  return { reply, errors, messages, confirmation: pending && confirmationIn(messages, pending, text.trim()) };
}

/**
 * How the session took `answer` as the caller's answer to `pending`, read from what it recorded:
 * the call a yes made, or the note a no or an unclear answer left the model. Null when it did
 * not take it as one (the turn was cancelled before the check).
 */
function confirmationIn(
  messages: readonly AgentChatMessage[],
  pending: PendingConfirmation,
  answer: string,
): ScenarioConfirmation | null {
  const taken = (verdict: ConfirmationVerdict, ran = false): ScenarioConfirmation => ({
    tool: pending.toolName,
    readBack: pending.readBack,
    answer,
    verdict,
    ran,
  });
  for (const message of messages) {
    if (message.role === "assistant") {
      const yes = message.toolCalls?.find((call) => call.confirmedBy !== undefined);
      // A yes to a tool that left the context meanwhile runs nothing.
      if (yes) return taken("yes", yes.invalid === undefined);
    } else if (message.role === "user" && message.kind === "context_event") {
      if (message.content === declinedNote(pending, answer)) return taken("no");
      if (message.content === unclearNote(pending, answer)) return taken("unclear");
    }
  }
  return null;
}

/** Fakes in place of their tools on a runtime (see {@link installFakes}). */
export type InstalledFakes = {
  /** Whether a fake, not the tool, gave `result`. */
  gave: (result: ToolResult | null) => boolean;
  /** The faked tools no call reached: none got past the input check. */
  unused: () => string[];
};

/**
 * Put `fakes` in place of their tools on `runtime` (`AgentSiteRuntime.fakeTools`). Each result a
 * fake gives is a copy of its own, so a transcript can tell a faked call from a real one. A
 * function fake that returns no tool result fails the call, as a tool's own bug does.
 */
export function installFakes(runtime: AgentSiteRuntime, fakes: Readonly<Record<string, ScenarioFake>>): InstalledFakes {
  const given = new WeakSet<ToolResult>();
  const used = new Set<string>();
  const fake = (tool: string, answer: ScenarioFake): ToolFake => async (input) => {
    used.add(tool);
    const returned: unknown = typeof answer === "function" ? await answer(input) : answer;
    const problem = toolResultProblem(returned);
    if (problem) throw new Error(`The fake for ${tool} returned no tool result: ${problem}.`);
    const result = { ...(returned as ToolResult) };
    given.add(result);
    return result;
  };
  runtime.fakeTools(Object.fromEntries(Object.entries(fakes).map(([tool, answer]) => [tool, fake(tool, answer)])));
  return {
    gave: (result) => result !== null && given.has(result),
    unused: () => Object.keys(fakes).filter((tool) => !used.has(tool)),
  };
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

/**
 * What a call does before the caller's first words, on a text route (`curb test`, `curb say`), as
 * the voice host does it (`call-opening.ts`): the greeting the model writes for `firstTurn:
 * "agent"`, else the session's fixed line (`firstTurn: { say }`), with no model call. Null when
 * the caller speaks first. Set the session info (`client.*`) first: the opening reads it.
 */
export async function playOpening(
  session: AgentSession,
  firstTurn: AgentFirstTurn | undefined,
): Promise<PlayedTurn | null> {
  if (firstTurn === "agent") {
    // The prompt a call opens with; loaded only here, its module brings in LiveKit's runtime.
    const { AGENT_FIRST_TURN_PROMPT } = await import("../server/voice/livekit-host/call-opening.js");
    return playTurn(session, AGENT_FIRST_TURN_PROMPT, "synthetic");
  }
  const before = session.messages.length;
  let line: string | null;
  try {
    line = session.open();
  } catch (error) {
    // A `say` function that returned no line: the call goes on without it, as a voice call does.
    return {
      reply: "",
      errors: [{ kind: "failed", message: describe(error) }],
      messages: session.messages.slice(before),
      confirmation: null,
    };
  }
  return line === null ? null : { reply: line, errors: [], messages: session.messages.slice(before), confirmation: null };
}

export type ScenarioResult = {
  name: string;
  /** The scenario file, relative to the project root. */
  file: string;
  mode: "scripted" | "simulated";
  passed: boolean;
  endedBy: ScenarioEndedBy;
  durationMs: number;
  turns: ScenarioTurn[];
  checks: ScenarioCheck[];
  /** Things worth knowing that fail nothing: a fake no call used, a scenario without checks of its own. */
  notes: string[];
};

/**
 * Run one scenario as a call: the scenario's fakes in place and its page info (`client`) on the
 * conversation first, then the agent's opening (its greeting or fixed line) when it speaks first,
 * then every caller line as a spoken turn on the bundle's session, with `end_call` attached the
 * way a live call attaches it. The conversation stops when the agent hangs up, the caller hangs
 * up or runs out of lines, `maxTurns` is reached, or a turn reports an error. Then every check
 * runs.
 *
 * Tools run for real unless the scenario fakes them; undoing what they did is the scenario
 * author's business.
 */
export async function runScenario(params: {
  scenario: Scenario;
  name: string;
  file: string;
  bundle: ScenarioBundle;
  /** The LLM the simulated caller and the judge run on. A scripted scenario never calls it. */
  simulator: AgentLlmClient;
  /** Called with each turn as soon as it is over, so a report can print the call as it goes. */
  onTurn?: (turn: ScenarioTurn) => void;
}): Promise<ScenarioResult> {
  const started = performance.now();
  const { scenario, bundle } = params;
  let hungUp = false;
  bundle.runtime.setEndCallRequest(() => {
    hungUp = true;
  });
  const fakes = scenario.fakes ? installFakes(bundle.runtime, scenario.fakes) : null;

  const turns: ScenarioTurn[] = [];
  let endedBy: ScenarioEndedBy | null = null;
  let stopReason: string | undefined;
  /** Record one turn (number 0: the opening, no caller line) and note when it ends the call. */
  const take = (played: PlayedTurn, caller: string | null, number: number) => {
    const turn = scenarioTurn(bundle.runtime, played, caller, number, fakes);
    turn.endedCall = hungUp;
    turns.push(turn);
    params.onTurn?.(turn);
    if (turn.errors.length > 0) {
      endedBy = "error";
      stopReason = turn.errors.map((error) => `${error.kind}: ${error.message}`).join("; ");
    } else if (turn.endedCall) {
      endedBy = "agent";
    }
  };

  // The page the call came from and the call's experiment variants, before the call opens: the
  // opening may read them.
  const callInfo = {
    ...clientInfo(scenario.client ?? {}),
    ...experimentInfo(scenarioVariants({ file: params.file, name: params.name }, bundle.experiments ?? [], scenario)),
  };
  if (Object.keys(callInfo).length > 0) bundle.session.updateInfo(callInfo);
  const opening = await playOpening(bundle.session, bundle.firstTurn);
  if (opening) take(opening, null, 0);

  const lines = scenario.turns;
  const maxTurns = scenario.maxTurns ?? lines?.length ?? DEFAULT_MAX_TURNS;
  const language = scenario.caller?.language ?? agentLanguage(bundle.runtime.settings.view());
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
    let hangsUpAfter = false;
    if (line === undefined) {
      try {
        const answer = await nextCallerLine({ llm: params.simulator, caller: scenario.caller!, language, turns });
        hangsUpAfter = answer.hangsUp;
        line = answer.line;
      } catch (error) {
        endedBy = "simulator";
        stopReason = describe(error);
        break;
      }
      if (!line) {
        endedBy = "caller";
        break;
      }
    }
    said += 1;
    // On an agent with `s2s` this text goes to the back office, whose turns carry no spoken rules.
    take(await playTurn(bundle.session, line, undefined, !bundle.runtime.settings.s2s()), line, said);
    if (endedBy === null && hangsUpAfter) endedBy = "caller";
  }
  const ended: ScenarioEndedBy = endedBy;

  const checks = builtInChecks({
    turns,
    endedBy: ended,
    ...(stopReason === undefined ? {} : { stopReason }),
    unsaid: lines?.slice(said) ?? [],
    maxTurns,
  });
  if (scenario.caller) checks.push(await judged(scenario, turns, ended, params.simulator));
  checks.push(...(await authorChecks(scenario, turns)));
  const notes = [
    ...(fakes?.unused() ?? []).map((tool) => `the fake for ${tool} was never used: no call of ${tool} ran`),
    ...(scenario.expect ? [] : ["this scenario has no checks of its own (expect), so only the built-in checks ran"]),
  ];

  return {
    name: params.name,
    file: params.file,
    mode: scenario.caller ? "simulated" : "scripted",
    passed: checks.every((check) => check.pass),
    endedBy: ended,
    durationMs: Math.round(performance.now() - started),
    turns,
    checks,
    notes,
  };
}

/** One turn as the report shows it: the reply as the caller heard it, the tool calls, the errors. */
function scenarioTurn(
  runtime: AgentSiteRuntime,
  played: PlayedTurn,
  caller: string | null,
  number: number,
  fakes: InstalledFakes | null,
): ScenarioTurn {
  const { reply, errors, messages, confirmation } = played;
  const toolCalls = toolCallsOf(messages, fakes?.gave);
  return {
    turn: number,
    caller,
    reply,
    fallback: fallbackLineIn(reply),
    confirmation,
    toolCalls,
    errors,
    contextDiff: messages.flatMap((message) => (message.role === "tool" ? message.contextDiff : [])),
    skillPath: runtime.snapshot().context.path,
    skipped: toolCalls.some((call) => call.name === SKIP_TURN_TOOL_NAME && call.ok),
    endedCall: false,
  };
}

/** The tool calls among a turn's messages, each with its result; `faked` tells which results a
 * fake gave (see {@link installFakes}). */
export function toolCallsOf(
  messages: readonly AgentChatMessage[],
  faked?: (result: ToolResult | null) => boolean,
): ScenarioToolCall[] {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    if (message.role === "tool") results.set(message.toolCallId, message.result);
  }
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? []).map((call) => {
          const result = results.get(call.id) ?? null;
          return {
            name: call.name,
            input: call.input,
            ok: result?.ok === true,
            result,
            // A `<Tool confirm>` call held for the caller's yes carries its read-back.
            ...(call.heldFor === undefined ? {} : { heldFor: call.heldFor }),
            ...(faked?.(result) ? { faked: true as const } : {}),
          };
        })
      : [],
  );
}

/** The judge's verdict on a simulated caller's goal. A conversation that broke off is not judged. */
async function judged(
  scenario: Scenario,
  turns: readonly ScenarioTurn[],
  endedBy: ScenarioEndedBy,
  llm: AgentLlmClient,
): Promise<ScenarioCheck> {
  if (endedBy === "error" || endedBy === "simulator") {
    return goalCheck({ notJudged: "the conversation broke off before it ended" });
  }
  try {
    return goalCheck(await judgeGoal({ llm, caller: scenario.caller!, turns, endedBy }));
  } catch (error) {
    return goalCheck({ notJudged: describe(error) });
  }
}

/** The author's `expect` checks. Whatever it does wrong becomes a failed check that says so. */
async function authorChecks(scenario: Scenario, turns: readonly ScenarioTurn[]): Promise<ScenarioCheck[]> {
  if (!scenario.expect) return [];
  let returned: unknown;
  try {
    returned = await scenario.expect(expectContext(turns));
  } catch (error) {
    return [{ name: "expect", pass: false, detail: `expect threw: ${describe(error)}` }];
  }
  if (!Array.isArray(returned)) {
    return [
      {
        name: "expect",
        pass: false,
        detail: `expect must return a list of checks, e.g. [called("book_meeting")]; it returned ${preview(returned)}.`,
      },
    ];
  }
  return returned.map((check: unknown, index) => {
    if (isCheck(check)) {
      const { name, pass, detail } = check;
      return { name, pass, ...(detail === undefined ? {} : { detail: String(detail) }) };
    }
    return {
      name: `expect, entry ${index + 1}`,
      pass: false,
      detail: `${preview(check)} is not a check. Return checks such as called("book_meeting"), said("Tuesday") or check("what must hold", condition).`,
    };
  });
}

function isCheck(value: unknown): value is ScenarioCheck {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Record<string, unknown>;
  return typeof check.name === "string" && typeof check.pass === "boolean";
}

function preview(value: unknown): string {
  const text = typeof value === "function" ? "a function" : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
