import { AGENT_LANGUAGES, fallbackReplies } from "../llm/localized.js";
import { ask, judgeView, type JudgeModel } from "./judge.js";
import { normalizeLlmPunctuation } from "../llm/punctuation.js";
import type { CallerEnding, ConversationRecord, EndState, RecordedSkills } from "./record.js";
import { skillPathOf, toolName, type ExpectedCall, type ScenarioSkill, type ScenarioCheck, type ScenarioExpectContext, type ScenarioTool, type ScenarioToolCall, type ScenarioTurn } from "./scenario.js";
import { agentWords, sentenceKey, sentences } from "./style.js";

/**
 * The checks every scenario gets, and the helpers an `expect` function builds its own from.
 * Pure: they read a finished conversation and never call anything.
 */

/** How a conversation ended. */
export type ScenarioEndedBy =
  /** The agent hung up (end_call). */
  | "agent"
  /** The simulated caller hung up. */
  | "caller"
  /** Every scripted caller line was said. */
  | "script"
  /** The scenario's maxTurns ran out. */
  | "max_turns"
  /** A turn reported an error; the conversation stopped there. */
  | "error"
  /** The simulated caller could not say its next line; the conversation stopped there. */
  | "simulator";

/** A finished conversation, as the checks read it. */
export type Conversation = {
  turns: readonly ScenarioTurn[];
  /** Null when the record does not say who ended the call. */
  endedBy: ScenarioEndedBy | null;
  /** Why it stopped, for `error` and `simulator`. */
  stopReason?: string;
  /** Scripted caller lines that were never said. */
  unsaid: readonly string[];
  maxTurns: number;
};

export const BUILT_IN_CHECKS = {
  errors: "no turn errors",
  empty: "no empty agent reply",
  fallback: "no fallback line instead of a reply",
  repeated: "no sentence repeated within a turn",
  ends: "the conversation ends cleanly",
  hangUp: "the agent does not hang up on a caller who still wants something",
  goal: "the caller reaches its goal",
} as const;

/** A tool refused this often in one turn is a loop: the model cannot give it input it accepts. */
export const REFUSAL_LOOP = 3;

/** Every fixed line the framework says when a turn cannot answer, as the caller hears it. */
const FALLBACK_LINES = AGENT_LANGUAGES.flatMap((language) =>
  Object.values(fallbackReplies(language)).map(normalizeLlmPunctuation),
);

/** The fixed fallback line that ends `reply`, or null. */
export function fallbackLineIn(reply: string): string | null {
  return FALLBACK_LINES.find((line) => reply.endsWith(line)) ?? null;
}

/**
 * The fixed checks of one conversation, in report order: no turn errors, no empty agent reply,
 * no fallback line instead of a reply, no sentence repeated within a turn, a clean end, and, for
 * a caller that says whether it was done (a simulated one), that the agent did not hang up on it
 * while it still wanted something. Pure: no model is asked.
 */
export function builtInChecks(record: ConversationRecord): ScenarioCheck[] {
  const { turns, ending } = record;
  const checks = conversationChecks({
    turns,
    endedBy: ending.by,
    ...(ending.reason === undefined ? {} : { stopReason: ending.reason }),
    unsaid: ending.unsaid,
    maxTurns: ending.maxTurns,
  });
  if (record.caller !== null || ending.caller !== null) checks.push(hangUpCheck(ending.by, ending.caller, turns));
  return checks;
}

/**
 * The helpers an `expect` function receives, over a finished conversation: `called`, `said`,
 * `stateMatches` and the rest make the same checks of `record` as they do in a scenario. `ask`
 * and `model` ask `options.model`, the judge's model of `curb test`; without one they refuse.
 */
export function checksOf(
  record: Pick<ConversationRecord, "turns" | "endState"> & Partial<ConversationRecord>,
  options: { model?: JudgeModel } = {},
): ScenarioExpectContext {
  const judged: ConversationRecord = {
    format: "curb.conversation",
    version: 1,
    source: "call",
    experiments: {},
    startedAt: null,
    durationMs: 0,
    unusedFakes: [],
    usage: null,
    ending: { by: null, unsaid: [], maxTurns: 0, caller: null },
    ...record,
    // A question of your own is about what was said, not about a simulated caller's goal.
    caller: null,
  };
  const judgeModel = (helper: string) => {
    if (options.model) return options.model;
    throw new Error(`${helper} asks a judge model, and none was given here. Fix: checksOf(record, { model: await testModel() }); in a scenario, curb test gives it the run's judge model.`);
  };
  return {
    ...expectContext(record.turns, record.endState, record.skills),
    transcriptText: judgeView({ turns: judged.turns, endedBy: judged.ending.by, caller: null, ...(judged.tools ? { tools: judged.tools } : {}) }).join("\n"),
    ask: async (question) => {
      if (typeof question !== "string" || !question.trim()) {
        throw new Error('ask() takes one sentence about the call that a judge answers with yes or no, e.g. ask("The agent sounds like a person on the phone.").');
      }
      return ask(judged, question.trim(), { model: judgeModel("ask()") });
    },
    model: async (system, input) => judgeModel("model()")(system, input),
  };
}

/** The built-in checks of a conversation, in report order. */
export function conversationChecks(conversation: Conversation): ScenarioCheck[] {
  const { turns } = conversation;
  return [
    outcome(BUILT_IN_CHECKS.errors, turns.flatMap(turnErrors)),
    outcome(BUILT_IN_CHECKS.empty, turns.flatMap(emptyReply)),
    outcome(
      BUILT_IN_CHECKS.fallback,
      turns.flatMap((turn) => (turn.fallback ? [`${label(turn)}: the caller heard the fixed line "${turn.fallback}"`] : [])),
    ),
    outcome(
      BUILT_IN_CHECKS.repeated,
      turns.flatMap((turn) =>
        repeatedSentences(agentWords(turn)).map((sentence) => `${label(turn)} says "${sentence}" more than once`),
      ),
    ),
    endsCheck(conversation),
  ];
}

/**
 * Whether the agent hung up on a simulated caller who was not done, read from who ended the
 * call and what the caller said about it (its hang-up marker, or its answer when the agent
 * ended the call first). No word of a goodbye is looked at. A caller that did not say passes:
 * nothing shows the agent was wrong.
 */
export function hangUpCheck(endedBy: ScenarioEndedBy | null, caller: CallerEnding | null, turns: readonly ScenarioTurn[]): ScenarioCheck {
  const name = BUILT_IN_CHECKS.hangUp;
  if (endedBy !== "agent") return { name, pass: true, detail: "the agent did not end the call" };
  const last = turns[turns.length - 1];
  const at = last ? ` at ${label(last)}` : "";
  if (caller === null) return { name, pass: true, detail: `the agent ended the call${at}; the caller did not say whether it was done` };
  if (caller.done) return { name, pass: true, detail: `the agent ended the call${at}, and the caller was done` };
  return { name, pass: false, detail: `the agent ended the call${at} while the caller still wanted: ${caller.reason || "something it did not name"}` };
}

/** Errors the session reported (an empty reply is the empty-reply check's), and refusal loops. */
function turnErrors(turn: ScenarioTurn): string[] {
  const reported = turn.errors
    .filter((error) => error.kind !== "empty_reply")
    .map((error) => `${label(turn)}: ${error.kind}: ${error.message}`);
  return [...reported, ...refusalLoops(turn).map((loop) => `${label(turn)}: ${loop}`)];
}

/** Tools refused {@link REFUSAL_LOOP} or more times in the turn. A call held for the caller's
 * yes (`<Tool confirm>`) did not run, but it was not refused either. */
function refusalLoops(turn: ScenarioTurn): string[] {
  const refused = new Map<string, ScenarioToolCall[]>();
  for (const call of turn.toolCalls) {
    if (call.ok || call.heldFor !== undefined) continue;
    refused.set(call.name, [...(refused.get(call.name) ?? []), call]);
  }
  return [...refused]
    .filter(([, calls]) => calls.length >= REFUSAL_LOOP)
    .map(([name, calls]) => {
      const last = calls[calls.length - 1]?.result?.message;
      return `${name} was refused ${calls.length} times${last ? `, last with: ${last}` : ""}`;
    });
}

/** A turn the agent answered with nothing, other than on purpose (skip_turn). A turn that
 * failed outright is the errors check's: its caller heard the fallback line. */
function emptyReply(turn: ScenarioTurn): string[] {
  if (turn.skipped || agentWords(turn)) return [];
  const empty = turn.errors.find((error) => error.kind === "empty_reply");
  if (turn.errors.some((error) => error.kind !== "empty_reply")) return [];
  return [`${label(turn)}: the agent said nothing${empty ? ` (${empty.message})` : ""}`];
}

function endsCheck({ turns, endedBy, stopReason, unsaid, maxTurns }: Conversation): ScenarioCheck {
  const last = turns[turns.length - 1];
  const at = last ? ` at ${label(last)}` : "";
  const passes = (detail: string): ScenarioCheck => ({ name: BUILT_IN_CHECKS.ends, pass: true, detail });
  const fails = (detail: string): ScenarioCheck => ({ name: BUILT_IN_CHECKS.ends, pass: false, detail });
  switch (endedBy) {
    case "agent": {
      if (unsaid.length === 0) return passes(`the agent ended the call (end_call)${at}`);
      const lines = unsaid.map((line) => JSON.stringify(line)).join(", ");
      return fails(`the agent hung up${at} with ${unsaid.length} scripted caller line(s) never said: ${lines}`);
    }
    case "caller":
      return passes(`the caller hung up${last ? ` after ${label(last)}` : ""}`);
    case "script":
      return passes(`every scripted caller line was said (${turns.filter((turn) => turn.caller !== null).length})`);
    case "max_turns":
      return passes(`maxTurns (${maxTurns}) was reached before anyone hung up`);
    case "error":
      return fails(`the conversation stopped${at}: ${stopReason ?? "the turn reported an error"}`);
    case "simulator":
      return fails(`the simulated caller could not go on: ${stopReason ?? "it gave no line"}`);
    case null:
      return passes(`the record does not say how the call ended${at}`);
  }
}

/**
 * Sentences that occur more than once in `text`, in the form first said. Two sentences are the
 * same when they match ignoring case, punctuation and spacing.
 */
export function repeatedSentences(text: string): string[] {
  const seen = new Map<string, number>();
  const firstForm = new Map<string, string>();
  for (const sentence of sentences(text)) {
    const key = sentenceKey(sentence);
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!firstForm.has(key)) firstForm.set(key, sentence);
  }
  return [...seen].filter(([, count]) => count > 1).map(([key]) => firstForm.get(key)!);
}

/** The helpers an `expect` function receives. `endState` is the agent's state when the call
 * ended; null when it could not be read. `skills` are the skills the call had open, as its
 * record holds them; without them, the skills it read (`read_skill`) and each turn's skill. */
export function expectContext(
  turns: readonly ScenarioTurn[],
  endState: EndState | null = null,
  skills: RecordedSkills = skillsReadIn(turns),
): Omit<ScenarioExpectContext, "transcriptText" | "ask" | "model"> {
  const calls = turns.flatMap((turn) => turn.toolCalls.map((call) => ({ ...call, at: label(turn) })));
  const ranCalls = (tool: string) => calls.filter((call) => call.name === tool && call.ok);
  const why = (call: (typeof calls)[number]) =>
    call.heldFor !== undefined ? `held for "${call.heldFor}"` : `refused: ${call.result?.message ?? "no reason given"}`;
  const state = <T>(store: string): T => {
    const stores = endState?.stores ?? {};
    if (Object.hasOwn(stores, store)) return stores[store] as T;
    const known = Object.keys(stores);
    throw new Error(
      `state("${store}"): the agent had no store "${store}" when the call ended. ` +
        (known.length > 0
          ? `Its stores are ${known.map((key) => `"${key}"`).join(", ")}.`
          : "It used no createAgentStore store on this call: a store exists once a component that reads it has rendered."),
    );
  };

  return {
    transcript: turns,
    state,
    context: endState?.context ?? [],
    stateMatches: (store, expected) => {
      const name = `state of ${store} has ${expectedValue(expected)}`;
      const actual = state<Record<string, unknown>>(store);
      const difference = firstDifference(actual, expected, store);
      return difference ? { name, pass: false, detail: difference } : { name, pass: true };
    },
    calledInOrder: (...expected) => {
      const wanted = expected.map(expectedCall);
      const name = `called in order: ${wanted.map((call) => (call.input ? `${call.tool} with ${expectedValue(call.input)}` : call.tool)).join(", ")}`;
      const ran = calls.filter((call) => call.ok);
      let from = 0;
      const found: string[] = [];
      for (const call of wanted) {
        const index = ran.findIndex((candidate, at) => at >= from && candidate.name === call.tool && (!call.input || matches(candidate.input, call.input)));
        if (index < 0) {
          const order = ran.map((candidate) => `${candidate.name} (${candidate.at})`).join(", ") || "none";
          const after = found.length > 0 ? ` after ${found[found.length - 1]}` : "";
          return { name, pass: false, detail: `no call of ${call.tool}${call.input ? ` with ${expectedValue(call.input)}` : ""} ran${after}; the calls that ran, in order: ${order}` };
        }
        found.push(`${call.tool} (${ran[index]!.at})`);
        from = index + 1;
      }
      return { name, pass: true, detail: found.join(", ") };
    },
    called: (tool$, input) => {
      const tool = toolName(tool$);
      const name = input ? `called ${tool} with ${expectedValue(input)}` : `called ${tool}`;
      const ran = ranCalls(tool);
      const match = ran.find((call) => !input || matches(call.input, input));
      if (match) return { name, pass: true, detail: `${match.at}: ${JSON.stringify(match.input)}` };
      if (ran.length > 0) {
        const inputs = ran.map((call) => `${JSON.stringify(call.input)} (${call.at})`).join(", ");
        return { name, pass: false, detail: `${tool} ran only with ${inputs}` };
      }
      const tried = calls.filter((call) => call.name === tool);
      if (tried.length > 0) {
        return { name, pass: false, detail: `${tool} never ran: ${tried.map((call) => `${call.at} ${why(call)}`).join("; ")}` };
      }
      const others = [...new Set(calls.filter((call) => call.ok).map((call) => call.name))];
      return { name, pass: false, detail: `${tool} was never called; tools that ran: ${others.join(", ") || "none"}` };
    },
    notCalled: (tool$) => {
      const tool = toolName(tool$);
      const name = `did not call ${tool}`;
      const ran = ranCalls(tool);
      if (ran.length === 0) return { name, pass: true };
      return { name, pass: false, detail: `${tool} ran ${ran.map((call) => `${call.at} with ${JSON.stringify(call.input)}`).join(", ")}` };
    },
    opened: (skill) => {
      const path = skillArgument("opened", skill);
      const name = `opened ${path}`;
      if (skills.opened.includes(path)) return { name, pass: true, ...(skills.started.includes(path) ? { detail: "started there" } : {}) };
      return { name, pass: false, detail: `${path} was never opened; skills opened: ${skills.opened.join(", ") || "none"}` };
    },
    notOpened: (skill) => {
      if (skill === undefined) {
        const name = skills.started.length > 0 ? `opened no skill beyond ${skills.started.join(", ")}` : "opened no skill";
        const more = skills.opened.filter((path) => !skills.started.includes(path));
        return more.length === 0 ? { name, pass: true } : { name, pass: false, detail: `opened ${more.join(", ")}` };
      }
      const path = skillArgument("notOpened", skill);
      const name = `did not open ${path}`;
      if (!skills.opened.includes(path)) return { name, pass: true };
      return { name, pass: false, detail: skills.started.includes(path) ? `${path} was opened by start.skills` : `${path} was opened` };
    },
    said: (text) => {
      const name = `said ${text instanceof RegExp ? String(text) : JSON.stringify(text)}`;
      const pattern = text instanceof RegExp ? fresh(text) : null;
      const found = turns.find((turn) => {
        const words = agentWords(turn);
        return pattern ? pattern.test(words) : words.toLowerCase().includes((text as string).toLowerCase());
      });
      return found ? { name, pass: true, detail: label(found) } : { name, pass: false, detail: "no agent reply says it" };
    },
    endedCall: () => {
      const ended = turns.find((turn) => turn.endedCall);
      return ended
        ? { name: "the agent ended the call", pass: true, detail: label(ended) }
        : { name: "the agent ended the call", pass: false, detail: "the agent never called end_call" };
    },
    check: (name, pass, detail) => ({ name, pass, ...(detail === undefined ? {} : { detail }) }),
    note: (check) => ({ ...check, reportOnly: true }),
  };
}

/** The route path of the skill an `opened` or `notOpened` check names; throws, naming the helper. */
function skillArgument(helper: string, skill: ScenarioSkill): string {
  try {
    return skillPathOf(skill);
  } catch (error) {
    throw new Error(`${helper}(): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The skills a conversation had open, read from its turns, for a record that does not hold
 * them: each skill a `read_skill` call opened and each skill a turn ended in, in that order. */
function skillsReadIn(turns: readonly ScenarioTurn[]): RecordedSkills {
  const opened: string[] = [];
  const add = (path: unknown) => {
    if (typeof path === "string" && path !== "" && !opened.includes(path)) opened.push(path);
  };
  for (const turn of turns) {
    for (const call of turn.toolCalls) if (call.name === "read_skill" && call.ok) add(call.input.skill);
    add(turn.skillPath);
  }
  return { started: [], opened };
}

/** An expected call as its tool and the input it must have. */
function expectedCall(call: ExpectedCall): { tool: string; input?: Record<string, unknown> } {
  if (typeof call === "string" || !Array.isArray(call)) return { tool: toolName(call as string | ScenarioTool) };
  const [tool, input] = call as readonly [string | ScenarioTool, Record<string, unknown>];
  return { tool: toolName(tool), input };
}

/** Whether `actual` has what `expected` asks for (see {@link firstDifference}). */
function matches(actual: unknown, expected: unknown): boolean {
  return firstDifference(actual, expected, "") === null;
}

/**
 * Where `actual` first lacks what `expected` asks for, in words, or null when it has it all.
 * An expected object is matched by the fields it names, so further fields may be there; an
 * expected list entry by entry and with the same length, so nothing else may be there; a RegExp
 * against the value's text (a string as it is, anything else as its JSON); strings ignoring
 * case and outer spaces; everything else by its JSON.
 */
function firstDifference(actual: unknown, expected: unknown, path: string): string | null {
  const at = path || "the value";
  if (expected instanceof RegExp) {
    const text = typeof actual === "string" ? actual : actual === undefined ? undefined : JSON.stringify(actual);
    return text !== undefined && fresh(expected).test(text) ? null : `${at} is ${shown(actual)}, which does not match ${String(expected)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at} is ${shown(actual)}, not a list`;
    if (actual.length !== expected.length) return `${at} has ${actual.length} entries, not ${expected.length}: ${shown(actual)}`;
    for (const [index, entry] of expected.entries()) {
      const difference = firstDifference(actual[index], entry, `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return `${at} is ${shown(actual)}, not an object`;
    for (const [key, value] of Object.entries(expected)) {
      const difference = firstDifference((actual as Record<string, unknown>)[key], value, path ? `${path}.${key}` : key);
      if (difference) return difference;
    }
    return null;
  }
  if (typeof expected === "string" && typeof actual === "string") {
    return actual.trim().toLowerCase() === expected.trim().toLowerCase() ? null : `${at} is ${shown(actual)}, not ${shown(expected)}`;
  }
  return JSON.stringify(actual) === JSON.stringify(expected) ? null : `${at} is ${shown(actual)}, not ${shown(expected)}`;
}

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** An expected value as a check names it: its JSON, with a RegExp written as the pattern. */
function expectedValue(value: unknown): string {
  if (value instanceof RegExp) return String(value);
  if (Array.isArray(value)) return `[${value.map(expectedValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}:${expectedValue(field)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** `pattern` without the global or sticky flag: those remember where they last matched, and each
 * text is tested afresh. */
function fresh(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

function outcome(name: string, problems: readonly string[]): ScenarioCheck {
  return problems.length === 0 ? { name, pass: true } : { name, pass: false, detail: problems.join("\n") };
}

/** "turn 3", or "the greeting" for the agent's opening turn. */
function label(turn: ScenarioTurn): string {
  return turn.caller === null ? "the greeting" : `turn ${turn.turn}`;
}
