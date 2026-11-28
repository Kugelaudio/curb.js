import { randomUUID } from "node:crypto";
import type { AgentSession } from "../agent-session.js";
import type { AgentFirstTurn } from "../config.js";
import { experimentInfo, type ExperimentDeclaration } from "../experiments.js";
import { assignExperiments } from "../experiments.node.js";
import { declinedNote, unclearNote, type ConfirmationVerdict, type PendingConfirmation } from "../llm/confirmation.js";
import type { AgentChatMessage } from "../llm/types.js";
import { snapshotAgentStores } from "../agent-state.js";
import type { AgentSiteRuntime, ToolFake, UnfakedTool } from "../runtime.js";
import { clientInfo, clientInfoProblem } from "../server/protocol.js";
import { SKIP_TURN_TOOL_NAME, type ToolResult } from "../types.js";
import { expectContext, fallbackLineIn } from "./checks.js";
import { offerSnapshotMcpTools } from "../mcp/snapshot-file.js";
import { missingMcpSnapshots, unfakedToolMessage, unfakedToolResult, unknownFakeProblems } from "./hermetic.js";
import { projectHost, takeBundle, type TestHost } from "./host.js";
import type { ConversationRecord, EndState, RecordedTool } from "./record.js";
import {
  fakedToolProblem,
  isFakeList,
  toolResultProblem,
  type ScenarioCallOptions,
  type ScenarioConfirmation,
  type ScenarioFake,
  type ScenarioFakeEntry,
  type ScenarioToolCall,
  type ScenarioTurn,
  type ScenarioTurnError,
} from "./scenario.js";
import { runUsage } from "./usage.js";

/**
 * A call of the project's agent in text, driven turn by turn from any code: the same session,
 * skills, tools and spoken-reply rules as a phone call, `end_call` included. Audio, timing and
 * interruptions are not part of it.
 *
 *   const call = await startCall({ fakes: { book: { ok: true, message: "Booked." } } });
 *   const turn = await call.say("I'd like a haircut tomorrow at ten.");
 *   expect(call.state("calendar")).toMatchObject({ appointments: [{ service: "haircut" }] });
 */

/** One call in progress. */
export type Call = {
  /** What the agent said before the caller's first words (turn 0): its greeting, or its fixed
   * line; null when the caller speaks first. */
  readonly opening: ScenarioTurn | null;
  /** Every turn so far, the opening first. */
  readonly turns: readonly ScenarioTurn[];
  /** Say one caller line, as a spoken turn, and get what the agent did: its reply as the caller
   * heard it, each tool call with its input and result, the turn's errors, and whether it hung
   * up (`endedCall`). Throws once the call has ended. */
  say(text: string): Promise<ScenarioTurn>;
  /** The data of the agent's store `store` (the key of its `createAgentStore`) now, without its
   * actions. Throws, naming the stores there are, when the agent has none by that key. */
  state<T = Record<string, unknown>>(store: string): T;
  /** The agent's rendered context now, line by line: its knowledge, the skills it can open
   * (`available_skill: ...`) and its tools. */
  readonly context: readonly string[];
  /** The system prompt the agent's model receives on the caller's next turn: the agent's
   * `<SystemPrompt>` and the framework's spoken-reply rules. */
  readonly systemPrompt: string;
  /** The agent hung up (`end_call`), or the call was closed. */
  readonly ended: boolean;
  /** The variant the call has in each of the agent's experiments. */
  readonly experiments: Readonly<Record<string, string>>;
  /** The language the agent speaks (BCP 47): what a simulated caller speaks unless told. */
  readonly language: string;
  /** The agent's model as `provider:model`; null when the host does not say. */
  readonly model: string | null;
  /** The call so far as a conversation record (`source: "call"`): what every check and judge
   * reads, and what `saveRun` saves. */
  record(): ConversationRecord;
  /** End the call. Its record and state stay readable. */
  close(): void;
};

/** The variant for each experiment, by name, or a function of the agent's experiments that
 * returns them. An experiment left out draws its variant as a call would. */
export type CallExperiments =
  | Readonly<Record<string, string>>
  | ((declared: readonly ExperimentDeclaration[]) => Readonly<Record<string, string>>);

export type StartCallOptions = ScenarioCallOptions & {
  /** Tools that must not run for real, by name, each with the result its calls get, or a
   * function of the validated input that returns one. Only `onSubmit` is replaced: the input is
   * checked as on a real call, and a `confirm` tool still waits for the caller's yes. */
  fakes?: Readonly<Record<string, ScenarioFake>> | readonly ScenarioFakeEntry[];
  /** Page info the call starts with, as the page an agent is embedded in sends it. */
  client?: Readonly<Record<string, string>>;
  /** The variant the call gets in the agent's experiments. */
  experiments?: CallExperiments;
  /** What the agent runs on. Default: `projectHost()`, the project's agent on its provider. */
  host?: TestHost;
};

/**
 * Start a call of the project's agent: a fresh agent built the way a call builds it, the fakes
 * in place and the page info and variants on the call, then the agent's opening when it speaks
 * first. Without a host, the project is prepared first (see `projectHost`). Throws when a fake,
 * the page info or a variant is one the agent cannot take.
 */
export async function startCall(options: StartCallOptions = {}): Promise<Call> {
  if (options.fakes !== undefined && isFakeList(options.fakes)) {
    throw new Error("startCall: a list of fake(tool, result) is not implemented yet in this version of curb; give fakes as an object of tool name to result.");
  }
  const notYet = (["start", "spoken", "now"] as const).filter((option) => options[option] !== undefined);
  if (notYet.length > 0) throw new Error(`startCall: ${notYet.join(", ")} is not implemented yet in this version of curb.`);
  const fakeProblems = Object.entries(options.fakes ?? {}).flatMap(([tool, fake]) => {
    const problem = fakedToolProblem(tool) ?? (typeof fake === "function" ? undefined : toolResultProblem(fake));
    return problem ? [`fakes.${tool}: ${problem}.`] : [];
  });
  const clientProblems = Object.entries(options.client ?? {}).flatMap(([key, value]) => clientInfoProblem(key, value) ?? []);
  if (fakeProblems.length + clientProblems.length > 0) throw new Error(`startCall: ${[...fakeProblems, ...clientProblems].join(" ")}`);

  const host = options.host ?? projectHost();
  // Before the agent is built: building it connects its MCP servers.
  if (options.hermetic) offerSnapshotMcpTools();
  const bundle = await takeBundle(host);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { runtime, session } = bundle;
  let hungUp = false;
  let closed = false;
  runtime.setEndCallRequest(() => {
    hungUp = true;
  });
  const setupProblems = [
    ...unknownFakeProblems(runtime, Object.keys(options.fakes ?? {})),
    ...(options.hermetic ? missingMcpSnapshots() : []),
  ];
  if (setupProblems.length > 0) throw new Error(`startCall: ${setupProblems.join(" ")}`);
  // A hermetic call stops at the first call of a tool without a fake: the tool does not run,
  // the turn is cut off, and the call ends as an error.
  let unfaked: { tool: string; turn: AbortController } | null = null;
  let turnControl = new AbortController();
  const stopAtUnfaked: UnfakedTool = (tool) => {
    unfaked ??= { tool, turn: turnControl };
    turnControl.abort();
    return unfakedToolResult(tool);
  };
  const fakes =
    options.fakes || options.hermetic ? installFakes(runtime, options.fakes ?? {}, options.hermetic ? stopAtUnfaked : undefined) : null;

  // Tools come and go with the agent's state, so every render is looked at: the record holds
  // each tool the model was offered at some point, without the framework's own.
  const offered = new Map<string, RecordedTool>();
  const noteTools = () => {
    for (const tool of runtime.snapshot().context.tools) {
      if (tool.scope !== "runtime") offered.set(tool.name, { name: tool.name, description: tool.description });
    }
  };
  noteTools();
  const stopNotingTools = runtime.subscribe(noteTools);

  // The page the call came from and the call's experiment variants, before the call opens: the
  // opening may read them.
  const declared = bundle.experiments ?? [];
  const pins = typeof options.experiments === "function" ? options.experiments(declared) : (options.experiments ?? {});
  const variantProblems = Object.entries(pins).flatMap(([name, variant]) => {
    const experiment = declared.find((candidate) => candidate.name === name);
    if (!experiment) return [`experiments.${name}: the agent declares no such experiment (it declares ${listed(declared.map((item) => item.name))}).`];
    if (!experiment.variants.some((candidate) => candidate.name === variant)) {
      return [`experiments.${name}: "${variant}" is not one of its variants (${listed(experiment.variants.map((item) => item.name))}).`];
    }
    return [];
  });
  if (variantProblems.length > 0) throw new Error(`startCall: ${variantProblems.join(" ")}`);
  const experiments = { ...assignExperiments(declared, `call:${randomUUID()}`, options.client ?? {}), ...pins };
  const callInfo = { ...clientInfo(options.client ?? {}), ...experimentInfo(experiments) };
  if (Object.keys(callInfo).length > 0) session.updateInfo(callInfo);

  const turns: ScenarioTurn[] = [];
  /** The last turn's errors, and whether the agent's LLM provider failed it, not the agent. */
  let failure: { reason: string; providerError: boolean } | null = null;
  const take = async (play: () => Promise<PlayedTurn | null>, caller: string | null, number: number): Promise<ScenarioTurn | null> => {
    const failedBefore = bundle.providerErrors?.() ?? 0;
    turnControl = new AbortController();
    const played = await play();
    if (!played) return null;
    const turn = scenarioTurn(runtime, played, caller, number, fakes);
    if (unfaked?.turn === turnControl) turn.errors.push({ kind: "failed", message: unfakedToolMessage(unfaked.tool) });
    turn.endedCall = hungUp;
    turns.push(turn);
    failure =
      turn.errors.length === 0
        ? null
        : {
            reason: turn.errors.map((error) => `${error.kind}: ${error.message}`).join("; "),
            // A request that timed out, or failed for good on the provider, is not the agent's doing.
            providerError: turn.errors.some((error) => error.kind === "timeout") || (bundle.providerErrors?.() ?? 0) > failedBefore,
          };
    return turn;
  };
  const opening = await take(() => playOpening(session, bundle.firstTurn, turnControl.signal), null, 0);
  const callerTurns = () => turns.filter((turn) => turn.caller !== null).length;
  const endState = () => endStateOf(runtime);
  const model = host.models?.(runtime.settings.current().llm).agent ?? null;

  return {
    opening,
    turns,
    async say(text) {
      if (hungUp || closed || unfaked) {
        const why = hungUp ? ": the agent hung up (end_call)" : unfaked ? `: ${unfakedToolMessage(unfaked.tool)}` : "";
        throw new Error(`call.say: the call has ended${why}. Start another with startCall().`);
      }
      // On an agent with `s2s` this text goes to the back office, whose turns carry no spoken rules.
      return (await take(() => playTurn(session, text, undefined, !runtime.settings.s2s(), turnControl.signal), text, callerTurns() + 1))!;
    },
    state: <T,>(store: string) => expectContext(turns, endState()).state<T>(store),
    get context() {
      return endState()?.context ?? [];
    },
    get systemPrompt() {
      return session.systemPromptFor(!runtime.settings.s2s());
    },
    get ended() {
      return hungUp || closed || unfaked !== null;
    },
    experiments,
    language: runtime.settings.language(),
    model,
    record() {
      // A hermetic stop ends the call as an error even after a later turn went well.
      if (unfaked && failure === null) failure = { reason: `failed: ${unfakedToolMessage(unfaked.tool)}`, providerError: false };
      const errored = failure !== null;
      return {
        format: "curb.conversation",
        version: 1,
        source: "call",
        caller: null,
        experiments: { ...experiments },
        startedAt,
        durationMs: Math.round(performance.now() - started),
        turns: [...turns],
        tools: [...offered.values()],
        ending: {
          by: errored ? "error" : hungUp ? "agent" : "caller",
          ...(errored ? { reason: failure!.reason } : {}),
          unsaid: [],
          maxTurns: callerTurns(),
          ...(errored && failure!.providerError ? { providerError: true as const } : {}),
          caller: null,
        },
        endState: endState(),
        unusedFakes: fakes?.unused() ?? [],
        usage: runUsage({ agent: bundle.tokens?.() ?? null, caller: null, judge: null }),
      };
    },
    close() {
      closed = true;
      stopNotingTools();
    },
  };
}

const listed = (names: readonly string[]) => (names.length > 0 ? names.map((item) => `"${item}"`).join(", ") : "none");

/** What one turn of a call did on a text route: the words the caller heard, the errors, the
 * transcript messages it added, and how the caller's words answered an action waiting for
 * their yes (null when none waited). */
export type PlayedTurn = {
  reply: string;
  errors: ScenarioTurnError[];
  messages: AgentChatMessage[];
  confirmation: ScenarioConfirmation | null;
  /** The LLM steps the turn took. */
  steps: number;
};

/** One spoken turn on the session, as a call runs it: the caller's line, or (`synthetic`) the
 * framework's own input. */
export async function playTurn(
  session: AgentSession,
  text: string,
  kind?: "synthetic",
  spoken = true,
  /** Aborting it cuts the turn off where it is (a hermetic call at a tool without a fake). */
  signal?: AbortSignal,
): Promise<PlayedTurn> {
  const before = session.messages.length;
  const stepsBefore = session.llmTrace.length;
  // The caller's line answers the action waiting for their yes, if one waits; framework input never does.
  const pending = kind ? null : session.pendingConfirmation;
  const errors: ScenarioTurnError[] = [];
  let reply = "";
  for await (const event of session.runTurnStream(text, { spoken, ...(kind ? { kind } : {}), ...(signal ? { signal } : {}) })) {
    if (event.type === "error") errors.push({ kind: event.error.kind, message: event.error.message });
    else if (event.type === "done") reply = event.reply;
  }
  const messages = session.messages.slice(before);
  return {
    reply,
    errors,
    messages,
    confirmation: pending && confirmationIn(messages, pending, text.trim()),
    steps: session.llmTrace.length - stepsBefore,
  };
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
export function installFakes(
  runtime: AgentSiteRuntime,
  fakes: Readonly<Record<string, ScenarioFake>>,
  /** A hermetic call's answer to a tool without a fake, which then does not run. */
  unfaked?: UnfakedTool,
): InstalledFakes {
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
  runtime.fakeTools(
    Object.fromEntries(Object.entries(fakes).map(([tool, answer]) => [tool, fake(tool, answer)])),
    unfaked ? { unfaked } : {},
  );
  return {
    gave: (result) => result !== null && given.has(result),
    unused: () => Object.keys(fakes).filter((tool) => !used.has(tool)),
  };
}

/**
 * What a call does before the caller's first words, on a text route (`startCall`, `curb say`), as
 * the voice host does it (`call-opening.ts`): the greeting the model writes for `firstTurn:
 * "agent"`, else the session's fixed line (`firstTurn: { say }`), with no model call. Null when
 * the caller speaks first. Set the session info (`client.*`) first: the opening reads it.
 */
export async function playOpening(
  session: AgentSession,
  firstTurn: AgentFirstTurn | undefined,
  signal?: AbortSignal,
): Promise<PlayedTurn | null> {
  if (firstTurn === "agent") {
    // The prompt a call opens with; loaded only here, its module brings in LiveKit's runtime.
    const { AGENT_FIRST_TURN_PROMPT } = await import("../server/voice/livekit-host/call-opening.js");
    return playTurn(session, AGENT_FIRST_TURN_PROMPT, "synthetic", true, signal);
  }
  const before = session.messages.length;
  let line: string | null;
  try {
    line = session.open();
  } catch (error) {
    // A `say` function that returned no line: the call goes on without it, as a voice call does.
    return {
      reply: "",
      errors: [{ kind: "failed", message: error instanceof Error ? error.message : String(error) }],
      messages: session.messages.slice(before),
      confirmation: null,
      steps: 0,
    };
  }
  return line === null ? null : { reply: line, errors: [], messages: session.messages.slice(before), confirmation: null, steps: 0 };
}

/** The agent's state as the conversation left it; null when the runtime cannot show it. */
export function endStateOf(runtime: AgentSiteRuntime): EndState | null {
  try {
    const { context, stateSnapshot } = runtime.snapshot();
    const stores = Object.fromEntries(Object.entries(snapshotAgentStores(runtime).stores).map(([key, saved]) => [key, saved.values]));
    return { stores, context: stateSnapshot, skillPath: context.path };
  } catch {
    // KEEP-JUSTIFIED: a runtime with no context IS the answer "no state"; state() says so when asked.
    return null;
  }
}

/** One turn as a record holds it: the reply as the caller heard it, the tool calls, the errors. */
export function scenarioTurn(
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
    steps: played.steps,
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
