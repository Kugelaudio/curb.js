import { AGENT_LANGUAGES, fallbackReplies } from "../llm/localized.js";
import { normalizeLlmPunctuation } from "../llm/punctuation.js";
import type { ScenarioCheck, ScenarioExpectContext, ScenarioToolCall, ScenarioTurn } from "./scenario.js";

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
  endedBy: ScenarioEndedBy;
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

/** What the agent itself said in a turn: the reply without the framework's fallback line. */
function agentWords(turn: ScenarioTurn): string {
  return (turn.fallback ? turn.reply.slice(0, -turn.fallback.length) : turn.reply).trim();
}

/** The built-in checks, in report order. The goal check of a simulated caller is added by the
 * runner, which asks the judge. */
export function builtInChecks(conversation: Conversation): ScenarioCheck[] {
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

/** The goal check from the judge's verdict, or from why there was none. */
export function goalCheck(verdict: { reached: boolean; reason: string } | { notJudged: string }): ScenarioCheck {
  if ("notJudged" in verdict) return { name: BUILT_IN_CHECKS.goal, pass: false, detail: `not judged: ${verdict.notJudged}` };
  return { name: BUILT_IN_CHECKS.goal, pass: verdict.reached, detail: verdict.reason };
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
  }
}

/**
 * Sentences that occur more than once in `text`, in the form first said. Two sentences are the
 * same when they match ignoring case, punctuation and spacing.
 */
export function repeatedSentences(text: string): string[] {
  const seen = new Map<string, number>();
  const firstForm = new Map<string, string>();
  for (const sentence of text.split(/(?<=[.!?…]["'”’»)\]]*)\s+|\n+/)) {
    const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!firstForm.has(key)) firstForm.set(key, sentence.trim());
  }
  return [...seen].filter(([, count]) => count > 1).map(([key]) => firstForm.get(key)!);
}

/** The helpers an `expect` function receives. */
export function expectContext(turns: readonly ScenarioTurn[]): ScenarioExpectContext {
  const calls = turns.flatMap((turn) => turn.toolCalls.map((call) => ({ ...call, at: label(turn) })));
  const ranCalls = (tool: string) => calls.filter((call) => call.name === tool && call.ok);
  const why = (call: (typeof calls)[number]) =>
    call.heldFor !== undefined ? `held for "${call.heldFor}"` : `refused: ${call.result?.message ?? "no reason given"}`;

  return {
    transcript: turns,
    called: (tool, input) => {
      const name = input ? `called ${tool} with ${expectedInput(input)}` : `called ${tool}`;
      const ran = ranCalls(tool);
      const match = ran.find((call) => !input || inputMatches(call.input, input));
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
    notCalled: (tool) => {
      const name = `did not call ${tool}`;
      const ran = ranCalls(tool);
      if (ran.length === 0) return { name, pass: true };
      return { name, pass: false, detail: `${tool} ran ${ran.map((call) => `${call.at} with ${JSON.stringify(call.input)}`).join(", ")}` };
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
  };
}

/** Every expected field is in the call's input with that value; strings match ignoring case and
 * outer spaces, a RegExp matches the field's text (a string as it is, anything else as its JSON),
 * everything else by its JSON. */
function inputMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const got = actual[key];
    if (value instanceof RegExp) return got !== undefined && fresh(value).test(typeof got === "string" ? got : JSON.stringify(got));
    if (typeof value === "string" && typeof got === "string") return got.trim().toLowerCase() === value.trim().toLowerCase();
    return JSON.stringify(got) === JSON.stringify(value);
  });
}

/** The expected input as a check names it: its JSON, with a RegExp written as the pattern. */
function expectedInput(input: Record<string, unknown>): string {
  const fields = Object.entries(input).map(
    ([key, value]) => `${JSON.stringify(key)}:${value instanceof RegExp ? String(value) : JSON.stringify(value)}`,
  );
  return `{${fields.join(",")}}`;
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
