import { declaredNameProblem } from "../goals.js";
import type { ConfirmationVerdict } from "../llm/confirmation.js";
import type { AgentTurnError } from "../llm/types.js";
import { clientInfoProblem } from "../server/protocol.js";
import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME, type ToolResult } from "../types.js";

/**
 * Conversation scenarios: what a caller says to the agent, and what must hold afterwards.
 * `curb test` finds every `*.scenario.ts` under the project's `src/`, runs each one through the
 * session a call uses (spoken turns, the agent's own skills and tools), and reports the
 * transcript with pass or fail per check.
 *
 *   // src/agent/booking.scenario.ts
 *   import { scenario } from "curb/testing";
 *   export default scenario({
 *     caller: { goal: "Book a follow-up call for next week", knows: "Name Max Mustermann" },
 *     expect: ({ called }) => [called("book_meeting")],
 *   });
 */

/** The caller an LLM plays: it answers the agent's last reply, working toward `goal`. */
export type ScenarioCaller = {
  /** What the caller wants from the call, e.g. "Book a follow-up call for next week". */
  goal: string;
  /** What the caller can tell the agent when it asks: name, company, email, numbers. */
  knows?: string;
  /** The language the caller speaks, e.g. "de". Default: the agent's language. */
  language?: string;
};

/** What a scenario's fake of a tool answers its calls with: a fixed result, or a function of
 * the call's validated input that returns one. */
export type ScenarioFake =
  | ToolResult
  | ((input: Record<string, unknown>) => ToolResult | Promise<ToolResult>);

/** One tool call the agent made. `ok` is false when the call did not run: it was refused, or
 * held for the caller's yes. */
export type ScenarioToolCall = {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: ToolResult | null;
  /** Held, not run: the read-back the caller must say yes to (`<Tool confirm>`). Not a refusal. */
  heldFor?: string;
  /** A fake gave the result (`fakes`); the tool itself did not run. */
  faked?: true;
};

/** How the caller's words answered the action held for their yes (`<Tool confirm>`), as the
 * session decided it before the agent spoke. */
export type ScenarioConfirmation = {
  /** The held tool. */
  tool: string;
  /** The question the caller was asked. */
  readBack: string;
  /** The caller's words. */
  answer: string;
  verdict: ConfirmationVerdict;
  /** The tool ran on this answer: a yes, while the tool was still there to run. */
  ran: boolean;
};

/** An error the session reported for a turn: `kind` as in `AgentTurnError`. */
export type ScenarioTurnError = { kind: AgentTurnError["kind"]; message: string };

/** One caller turn and everything the agent did in answer to it. An agent that speaks first
 * (`defineAgent({ firstTurn: "agent" })` or `{ say }`) opens with turn 0: its greeting, or its
 * fixed line. */
export type ScenarioTurn = {
  /** The turn's number: 1 for the caller's first line, 0 for the agent's opening. */
  turn: number;
  /** What the caller said; null for the agent's opening. */
  caller: string | null;
  /** What the caller heard: the agent's words, then the fixed fallback line if the turn failed. */
  reply: string;
  /** The fixed line the framework said because the turn could not answer, or null. */
  fallback: string | null;
  /** How the caller's line answered an action waiting for their yes; null when none waited. */
  confirmation: ScenarioConfirmation | null;
  toolCalls: ScenarioToolCall[];
  errors: ScenarioTurnError[];
  /** Context lines the turn's tool calls added. */
  contextDiff: string[];
  /** The active skill after the turn; "" while the agent has read none (the agent level). */
  skillPath: string;
  /** The agent stayed silent on purpose (skip_turn). */
  skipped: boolean;
  /** The agent hung up in this turn (end_call). */
  endedCall: boolean;
};

/** One named result. `detail` says what was found, always when the check failed. */
export type ScenarioCheck = { name: string; pass: boolean; detail?: string };

/** What an `expect` function receives: the conversation, and helpers that make checks of it. */
export type ScenarioExpectContext = {
  /** Every turn of the conversation, in order. */
  transcript: readonly ScenarioTurn[];
  /** Passes when the agent ran `tool` without a refusal at least once. With `input`, only a call
   * whose input has those values counts: strings compared ignoring case and outer spaces, a
   * RegExp tested against the field's text, anything else by its JSON. */
  called: (tool: string, input?: Record<string, unknown>) => ScenarioCheck;
  /** Passes when the agent never called `tool`, not even in a call that was refused. */
  notCalled: (tool: string) => ScenarioCheck;
  /** Passes when an agent reply contains `text` (ignoring case) or matches the pattern. */
  said: (text: string | RegExp) => ScenarioCheck;
  /** Passes when the agent ended the call itself (end_call). */
  endedCall: () => ScenarioCheck;
  /** A check of your own: passes when `pass` is true; `detail` explains a failure. */
  check: (name: string, pass: boolean, detail?: string) => ScenarioCheck;
};

export type ScenarioDefinition = {
  /** Shown in the report and matched by `curb test <filter>`. Default: the file name. */
  name?: string;
  /** A simulated caller. Give this or `turns`. */
  caller?: ScenarioCaller;
  /** Scripted caller lines, one per turn. Give this or `caller`. */
  turns?: readonly string[];
  /** The most caller turns the conversation may take. Default: 12 for a simulated caller, the
   * number of lines for a script. */
  maxTurns?: number;
  /** Page info the call starts with, as the page an agent is embedded in sends it:
   * `{ event: "webinar-11-04" }` sets `client.event` before the agent's opening. */
  client?: Readonly<Record<string, string>>;
  /** The variant the call gets in an experiment of the agent's (`defineAgent({ experiments })`),
   * by experiment name: `{ greeting: "casual" }`. An experiment left out draws its variant as a
   * call would. */
  experiments?: Readonly<Record<string, string>>;
  /** Tools that must not run for real, by name, each with the result its calls get instead:
   * `{ create_claim: { ok: true, message: "Claim created." } }`, or a function of the input
   * `onSubmit` would get that returns one. Only `onSubmit` is replaced: the tool checks the input
   * as on a real call (its schema's rules and transforms included), its success or error line
   * follows the result, and a `confirm` tool still waits for the caller's yes. */
  fakes?: Readonly<Record<string, ScenarioFake>>;
  /** Your own checks, run on the finished conversation. */
  expect?: (context: ScenarioExpectContext) => readonly ScenarioCheck[] | Promise<readonly ScenarioCheck[]>;
};

/** A definition `scenario()` accepted. */
export type Scenario = Readonly<ScenarioDefinition>;

/** The caller turns a simulated conversation may take when the scenario sets no `maxTurns`. */
export const DEFAULT_MAX_TURNS = 12;

const FIELDS = ["name", "caller", "turns", "maxTurns", "client", "experiments", "fakes", "expect"];
const CALLER_FIELDS = ["goal", "knows", "language"];
const RESULT_FIELDS = ["ok", "message", "data"];
/** The framework's own tools: they touch nothing outside the call, and the call needs them. */
const FRAMEWORK_TOOLS = ["read_skill", SKIP_TURN_TOOL_NAME, END_CALL_TOOL_NAME];

/** Marks what {@link scenario} returned, so `curb test` tells a file's scenarios from its other
 * exports. A registry symbol: a second copy of this module marks the same way. */
const SCENARIO = Symbol.for("curb.scenario");

/**
 * Define a scenario: `export default scenario({ ... })`, or `export const name = scenario({ ... })`
 * for each further one, in a `*.scenario.ts` file under `src/`.
 * Throws when the definition cannot run, naming every field that is wrong and how to fix it.
 */
export function scenario(definition: ScenarioDefinition): Scenario {
  const problems = scenarioProblems(definition);
  if (problems.length > 0) throw new Error(`scenario(): ${problems.join(" ")}`);
  return Object.freeze(Object.defineProperty({ ...definition }, SCENARIO, { value: true }));
}

/** Whether `value` is what {@link scenario} returned. */
export function isScenario(value: unknown): value is Scenario {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SCENARIO] === true;
}

function scenarioProblems(definition: unknown): string[] {
  if (!isRecord(definition)) {
    return [
      'It takes one object: { caller: { goal: "..." } } for a simulated caller, or { turns: ["...", ...] } for scripted caller lines.',
    ];
  }
  const problems = unknownFields(definition, FIELDS, "a scenario");
  const { name, caller, turns, maxTurns, client, experiments, fakes, expect } = definition;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    problems.push("name must be a non-empty string.");
  }
  if (caller !== undefined && turns !== undefined) {
    problems.push("Give caller (a simulated caller) or turns (scripted caller lines), not both.");
  } else if (caller === undefined && turns === undefined) {
    problems.push('Give caller: { goal: "..." } for a simulated caller, or turns: ["...", ...] for scripted caller lines.');
  }
  if (caller !== undefined) problems.push(...callerProblems(caller));
  if (turns !== undefined) problems.push(...turnsProblems(turns));
  if (maxTurns !== undefined) {
    if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
      problems.push(`maxTurns must be a whole number of caller turns, at least 1; got ${JSON.stringify(maxTurns)}.`);
    } else if (Array.isArray(turns) && maxTurns < turns.length) {
      problems.push(`maxTurns (${maxTurns}) is less than the ${turns.length} scripted turns; raise it or leave it out.`);
    }
  }
  if (client !== undefined) problems.push(...clientProblems(client));
  if (experiments !== undefined) problems.push(...experimentsProblems(experiments));
  if (fakes !== undefined) problems.push(...fakesProblems(fakes));
  if (expect !== undefined && typeof expect !== "function") {
    problems.push('expect must be a function that returns checks, e.g. ({ called }) => [called("book_meeting")].');
  }
  return problems;
}

function clientProblems(client: unknown): string[] {
  if (!isRecord(client)) return ['client must be an object of page info, e.g. { event: "webinar-11-04" } for client.event.'];
  return Object.entries(client).flatMap(([key, value]) => clientInfoProblem(key, value) ?? []);
}

/** The shape only: whether the agent declares each experiment and variant is checked when the
 * scenario runs, against the agent it runs on. */
function experimentsProblems(experiments: unknown): string[] {
  if (!isRecord(experiments)) {
    return ['experiments must be an object of experiment name to variant name, e.g. { greeting: "casual" }.'];
  }
  return Object.entries(experiments).flatMap(([name, variant]) => {
    const problem =
      declaredNameProblem(name, "an experiment") ??
      (typeof variant === "string" ? declaredNameProblem(variant, "a variant") : `give the variant's name as text; got ${preview(variant)}.`);
    return problem ? [`experiments.${name}: ${problem}`] : [];
  });
}

function fakesProblems(fakes: unknown): string[] {
  if (!isRecord(fakes)) {
    return ['fakes must be an object of tool name to the result its calls get, e.g. { create_claim: { ok: true, message: "Claim created." } }.'];
  }
  return Object.entries(fakes).flatMap(([tool, fake]) => {
    const problem =
      fakedToolProblem(tool) ??
      (typeof fake === "function"
        ? undefined
        : isRecord(fake)
          ? toolResultProblem(fake)
          : `give the result its calls get, such as { ok: true, message: "Done." }, or a function of the input that returns one; got ${preview(fake)}`);
    return problem ? [`fakes.${tool}: ${problem}.`] : [];
  });
}

/** Why no fake may stand in for `tool`, or undefined: the framework's own tools stay real. */
export function fakedToolProblem(tool: string): string | undefined {
  if (!tool.trim()) return "a fake needs the name of the tool it stands in for";
  if (FRAMEWORK_TOOLS.includes(tool)) return `${tool} is the framework's own tool, not one of the agent's, and cannot be faked`;
  return undefined;
}

/** What is wrong with `value` as a tool result (`{ ok, message?, data? }`), or undefined. */
export function toolResultProblem(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return `a tool result is an object with ok (true or false) and optionally message and data; got ${preview(value)}`;
  }
  const unknown = Object.keys(value).filter((key) => !RESULT_FIELDS.includes(key));
  if (unknown.length > 0) {
    return `unknown field ${unknown.map((key) => `"${key}"`).join(", ")}; a tool result takes ${RESULT_FIELDS.join(", ")}`;
  }
  if (typeof value.ok !== "boolean") return `ok must be true or false; got ${preview(value.ok)}`;
  if (value.message !== undefined && typeof value.message !== "string") {
    return `message must be a string; got ${preview(value.message)}`;
  }
  return undefined;
}

function preview(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function callerProblems(caller: unknown): string[] {
  if (!isRecord(caller)) return ['caller must be an object: { goal: "...", knows: "..." }.'];
  const problems = unknownFields(caller, CALLER_FIELDS, "caller");
  const { goal, knows, language } = caller;
  if (typeof goal !== "string" || !goal.trim()) {
    problems.push('caller.goal must say what the caller wants from the call, e.g. "Book a follow-up call for next week".');
  }
  if (knows !== undefined && typeof knows !== "string") {
    problems.push('caller.knows must be a string with what the caller can tell the agent, e.g. "Name Max Mustermann, email max@example.com".');
  }
  if (language !== undefined && !isLanguageTag(language)) {
    problems.push(`caller.language must be a language code such as "de" or "en-US"; got ${JSON.stringify(language)}.`);
  }
  return problems;
}

function turnsProblems(turns: unknown): string[] {
  if (!Array.isArray(turns) || turns.length === 0) {
    return ['turns must be a non-empty list of caller lines, e.g. ["Hi, I would like to book a call", "Next Tuesday"].'];
  }
  const blank = turns.flatMap((line, index) => (typeof line === "string" && line.trim() ? [] : [index + 1]));
  return blank.length === 0 ? [] : [`turns must hold one caller line per entry; entry ${blank.join(", ")} is empty or not a string.`];
}

function unknownFields(record: Record<string, unknown>, known: readonly string[], what: string): string[] {
  return Object.keys(record)
    .filter((key) => !known.includes(key))
    .map((key) => `Unknown field "${key}" in ${what}; it takes ${known.join(", ")}.`);
}

function isLanguageTag(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    Intl.getCanonicalLocales(value);
    return true;
  } catch {
    // KEEP-JUSTIFIED: a RangeError IS the answer "not a language tag"; the caller reports it.
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
