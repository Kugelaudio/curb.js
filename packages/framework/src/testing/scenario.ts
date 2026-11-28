import type { ComponentType } from "react";
import type { z } from "zod";
import { declaredNameProblem } from "../goals.js";
import type { SkillMeta } from "../routing.js";
import type { ConversationRecord } from "./record.js";
import type { Caller } from "./converse.js";
import type { ConfirmationVerdict } from "../llm/confirmation.js";
import type { AgentTurnError } from "../llm/types.js";
import { runsProblem } from "../cli/scenarios/limits.js";
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

/** How a simulated caller can behave beyond pursuing its goal. Each is one fixed rule in the
 * caller's prompt; `caller.behaviours` picks them, and `personas` bundles the common mixes. */
export const CALLER_BEHAVIOURS = ["everything_at_once", "changes_mind", "off_topic", "impatient", "asks_to_repeat"] as const;

export type CallerBehaviour = (typeof CALLER_BEHAVIOURS)[number];

/** Who a simulated caller is: spread one into `caller`, as in `caller: { goal, ...personas.rushed }`. */
export type CallerPersona = {
  /** Who the caller is and how they talk, in plain words: "An elderly caller who talks slowly". */
  persona: string;
  /** The typed behaviours that go with it. */
  behaviours?: readonly CallerBehaviour[];
};

/** The caller an LLM plays: it answers the agent's last reply, working toward `goal`. */
export type ScenarioCaller = {
  /** What the caller wants from the call, e.g. "Book a follow-up call for next week". */
  goal: string;
  /** Everything the caller knows and can tell the agent when it asks: name, company, email,
   * numbers. The caller never says a fact that is not here. */
  knows?: string;
  /** The language the caller speaks, e.g. "de". Default: the agent's language. */
  language?: string;
  /** Who the caller is and how they talk, in plain words. A simulated caller is more
   * cooperative than a real one; a persona is how a scenario makes it less so. */
  persona?: string;
  /** What the caller does beyond pursuing its goal, e.g. `["changes_mind", "impatient"]`. */
  behaviours?: readonly CallerBehaviour[];
};

/** What the built-in judge looks for in every judged conversation, in one sentence each. The
 * judge answers each with yes, no or unknown, the turn and a quote of the agent's; a yes is a
 * finding. (What exactly it is asked is in `judge.ts`.) */
export const JUDGE_FINDINGS = {
  asked_again: "The agent asked the caller for a piece of information the caller had already stated.",
  claimed_without_tool: "The agent told the caller it did or recorded something that no successful tool call did.",
  ignored_caller: "The agent ignored or misread something the caller said.",
  incoherent: "The agent repeated itself, contradicted itself, or said something that does not follow from the call.",
  wrong_tool_use: "The agent's tool calls did not match what the caller asked for, or came in an order that makes no sense.",
  ended_early: "The agent ended the call although the caller had not said goodbye or that they needed nothing else.",
} as const;

export type JudgeFinding = keyof typeof JUDGE_FINDINGS;

/** The per-reply style numbers `curb test` reports for every scenario. A limit on one
 * (`style: { wordsP90: 40 }`) fails the scenario when the number is above it. */
export const STYLE_METRICS = [
  "wordsP50",
  "wordsP90",
  "questionShare",
  "repeatedOpeningShare",
  "repeatedClosingShare",
  "sameGoodbyeShare",
  "stepsPerTurn",
  "stepsPerTurnMax",
  "refusedToolCallsPerRun",
] as const;

export type StyleMetric = (typeof STYLE_METRICS)[number];

/** The highest value a scenario accepts for each style number it names. */
export type StyleLimits = Readonly<Partial<Record<StyleMetric, number>>>;

/** What a scenario's fake of a tool answers its calls with: a fixed result, or a function of
 * the call's validated input that returns one. */
export type ScenarioFake =
  | ToolResult
  | ((input: Record<string, unknown>) => ToolResult | Promise<ToolResult>);

/** A tool as a value: anything with a `name`, such as what `defineTool` returns. Wherever a
 * scenario names a tool (`fake`, `called`, `notCalled`, `calledInOrder`), it takes this or the
 * tool's name. */
export type ScenarioTool = { readonly name: string };

/** One fake as `fake(tool, result)` makes it, for the list form of `fakes`. */
export type ScenarioFakeEntry = { readonly tool: string; readonly result: ScenarioFake };

/** A skill a scenario names: its module (`import * as Refund from "./refund/skill.js"`) or its
 * route path (`"/billing/refund"`). */
export type ScenarioSkill = string | { readonly default: ComponentType<any>; readonly meta?: SkillMeta };

/** The info one skill declares it needs (`meta.info`), as the object a test gives for it. */
type DeclaredInfo<Skill> = Skill extends { readonly meta?: infer Meta }
  ? NonNullable<Meta> extends { readonly info?: infer Info }
    ? NonNullable<Info> extends z.ZodObject
      ? z.input<NonNullable<Info>>
      : unknown
    : unknown
  : unknown;

/** The info every skill of `Skills` declares, together. */
type DeclaredInfoOf<Skills extends readonly unknown[]> = Skills extends readonly [infer First, ...infer Rest]
  ? DeclaredInfo<First> & DeclaredInfoOf<Rest>
  : unknown;

/** The call info `start.info` takes for `Skills`: every key a skill declares as required, with
 * its type, and any other key. */
export type ScenarioStartInfo<Skills extends readonly ScenarioSkill[] = readonly ScenarioSkill[]> =
  DeclaredInfoOf<Skills> & Readonly<Record<string, unknown>>;

/** Where a call starts: the info it has, then the skills open, before the caller's first line.
 * The same steps as a host's `set_info`, then `read_skill`. */
export type ScenarioStart<Skills extends readonly ScenarioSkill[] = readonly ScenarioSkill[]> = {
  /** The skills opened before turn 1, in this order. A value that is not one of the agent's
   * skills is an error before turn 1. */
  skills?: Skills;
} & ({} extends DeclaredInfoOf<Skills>
  ? {
      /** The call info set before the skills open, as a host's `set_info` sets it. */
      info?: ScenarioStartInfo<Skills>;
    }
  : {
      /** The call info set before the skills open, as a host's `set_info` sets it. A started
       * skill's `meta.info` names the keys it must have. */
      info: ScenarioStartInfo<Skills>;
    });

/** How a call is played, the same for a scenario and `startCall`. */
export type ScenarioCallOptions<Skills extends readonly ScenarioSkill[] = readonly ScenarioSkill[]> = {
  /** Info set and skills opened before turn 1. Default: the call starts at the agent level. */
  start?: ScenarioStart<Skills>;
  /** false sends every turn as typed text, without the spoken-reply rules. Default: true. */
  spoken?: boolean;
  /** true makes a tool call that has no fake stop the run as an error, before the tool runs, and
   * offers MCP tools from `mcp.tools.json` without contacting their servers. Default: false. */
  hermetic?: boolean;
  /** The date and time in the agent's context, as an ISO date-time: "2026-10-30T15:00:00Z".
   * Default: a fixed instant while replies are stored, the real clock with `--live`. */
  now?: string;
};

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
  /** How many LLM steps the turn took; 0 for an opening said without the model. */
  steps: number;
};

/** What a judge found for a question: its answer, and the turn and words that show it. */
export type ScenarioEvidence = {
  answer: "yes" | "no" | "unknown";
  /** The turn that shows it, or null when the judge named none. */
  turn: number | null;
  /** Words from that turn, or null when the judge quoted none or the quote is not in the transcript. */
  quote: string | null;
};

/** One named result. `detail` says what was found, always when the check failed. A check a judge
 * answered carries its `evidence`. A check that needs the judge and did not get an answer is
 * `notJudged`: it did not pass, and it says nothing against the agent either. A `reportOnly`
 * check is shown and counted and fails nothing. */
export type ScenarioCheck = { name: string; pass: boolean; detail?: string; evidence?: ScenarioEvidence; notJudged?: true; reportOnly?: true };

/** A tool call an `expect` helper looks for: the tool (its name or its value), or the tool with
 * the input the call must have. */
export type ExpectedCall =
  | string
  | ScenarioTool
  | readonly [tool: string | ScenarioTool, input: Record<string, unknown>];

/** What an `expect` function receives: the conversation, and helpers that make checks of it. */
export type ScenarioExpectContext = {
  /** Every turn of the conversation, in order. */
  transcript: readonly ScenarioTurn[];
  /** Passes when the agent ran `tool` without a refusal at least once. With `input`, only a call
   * whose input has those values counts, at any depth: strings compared ignoring case and outer
   * spaces, a RegExp tested against the field's text, an object by the fields it names, a list
   * entry by entry. */
  called: (tool: string | ScenarioTool, input?: Record<string, unknown>) => ScenarioCheck;
  /** Passes when the agent ran these tools without a refusal in this order; other calls may come
   * between them. An entry is a tool's name, or `[name, input]` matched as `called` matches. */
  calledInOrder: (...calls: readonly ExpectedCall[]) => ScenarioCheck;
  /** The data of the agent's store `store` (the key of its `createAgentStore`) when the call
   * ended, without its actions. Throws, naming the stores there are, when the agent has none
   * by that key. */
  state: <T = Record<string, unknown>>(store: string) => T;
  /** Passes when the store's data at the end of the call has `expected`: an object by the
   * fields it names, a list entry by entry and with the same length, text ignoring case. */
  stateMatches: (store: string, expected: Record<string, unknown>) => ScenarioCheck;
  /** The agent's rendered context when the call ended, line by line. */
  context: readonly string[];
  /** Passes when the agent never called `tool`, not even in a call that was refused. */
  notCalled: (tool: string | ScenarioTool) => ScenarioCheck;
  /** Passes when the agent had `skill` open at some point in the call, by `start.skills` or by
   * reading it. */
  opened: (skill: ScenarioSkill) => ScenarioCheck;
  /** Passes when the agent never opened `skill`; without one, when it opened no skill beyond those
   * of `start.skills`. */
  notOpened: (skill?: ScenarioSkill) => ScenarioCheck;
  /** Passes when an agent reply contains `text` (ignoring case) or matches the pattern. */
  said: (text: string | RegExp) => ScenarioCheck;
  /** Passes when the agent ended the call itself (end_call). */
  endedCall: () => ScenarioCheck;
  /** A check of your own: passes when `pass` is true; `detail` explains a failure. */
  check: (name: string, pass: boolean, detail?: string) => ScenarioCheck;
  /** The check, marked `reportOnly`: shown with its result and counted across runs, and it never
   * fails a run or a scenario. */
  note: (check: ScenarioCheck) => ScenarioCheck;
  /** The conversation as the judge reads it: the agent's tools, then the transcript with every
   * tool call, fenced as a recording. Give it to `model` as the input. */
  transcriptText: string;
  /** One yes/no question of your own about this conversation, answered by the run's judge model
   * as `ask` of `curb/testing` answers it: a no fails, a yes passes, an unknown is `notJudged`. */
  ask: (question: string) => Promise<ScenarioCheck>;
  /** The run's judge model (`testModel`): a system prompt and an input to its text. */
  model: (system: string, input: string) => Promise<string>;
};

/** One completed run of a scenario as `expectRuns` gets it: its record, its checks and outcome,
 * and the helpers of `expect` over its conversation. */
export type ScenarioRunResult = ScenarioExpectContext & {
  /** 1 for the first run. */
  run: number;
  outcome: "pass" | "fail";
  /** Every check of the run, the built-in ones, the judge's and those of `expect`. */
  checks: readonly ScenarioCheck[];
  record: ConversationRecord;
};

export type ScenarioDefinition<Skills extends readonly ScenarioSkill[] = readonly ScenarioSkill[]> = ScenarioCallOptions<Skills> & {
  /** Shown in the report and matched by `curb test <filter>`. Default: the file name. */
  name?: string;
  /** A simulated caller, or a caller of your own: a function from the turns so far to the next
   * line, or null to hang up (`Caller`). Give this or `turns`. */
  caller?: ScenarioCaller | Caller;
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
   * follows the result, and a `confirm` tool still waits for the caller's yes. Or a list of
   * `fake(tool, result)`. */
  fakes?: Readonly<Record<string, ScenarioFake>> | readonly ScenarioFakeEntry[];
  /** How often the scenario runs. Default: 1; `curb test --runs` overrides it. Each run is a
   * conversation of its own. */
  runs?: number;
  /** The share of the completed runs that must pass, from 0 to 1. Default: 1, every run. */
  minPassRate?: number;
  /** What must be true of the call, in plain sentences a judge answers with yes, no or unknown:
   * "The agent reads the booking number back." A no fails the run. */
  expectations?: readonly string[];
  /** Findings of your own, by id (lowercase, with underscores): one sentence each that is true of
   * a call with that problem. The judge asks them beside the built-in ones; they are counted and
   * reported the same way, and fail nothing unless `failOn` names them. */
  findings?: Readonly<Record<string, string>>;
  /** Judge findings that fail a run when found: built-in ones and the scenario's own. Default:
   * none, they are only reported. */
  failOn?: readonly (JudgeFinding | (string & {}))[];
  /** The highest value this scenario accepts for the style numbers it names. Default: none. */
  style?: StyleLimits;
  /** Your own checks, run on the finished conversation. */
  expect?: (context: ScenarioExpectContext) => readonly ScenarioCheck[] | Promise<readonly ScenarioCheck[]>;
  /** Your own checks across all runs, called once after the last with every completed run. A
   * failed one fails the scenario; `note` makes one report-only. */
  expectRuns?: (
    runs: readonly ScenarioRunResult[],
    helpers: Pick<ScenarioExpectContext, "check" | "note" | "model">,
  ) => readonly ScenarioCheck[] | Promise<readonly ScenarioCheck[]>;
};

/** A definition `scenario()` accepted. */
export type Scenario = Readonly<ScenarioDefinition>;

/** The caller turns a simulated conversation may take when the scenario sets no `maxTurns`. */
export const DEFAULT_MAX_TURNS = 12;
/** The most caller turns a simulated conversation may be given. */
export const MAX_SIMULATED_TURNS = 100;
/** The most sentences `expectations` may hold: one judge call answers them all. */
export const MAX_EXPECTATIONS = 12;
/** The most findings of its own a scenario may give, for the same reason. */
export const MAX_FINDINGS = 12;

/** How the id of a finding of your own is written: lowercase words joined by underscores. */
const FINDING_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** Ids the judge or `curb review` ask questions under themselves. */
const RESERVED_IDS = ["goal", "unresolved", "caller_closed"];

const FIELDS = [
  "name",
  "caller",
  "turns",
  "maxTurns",
  "client",
  "experiments",
  "fakes",
  "runs",
  "minPassRate",
  "expectations",
  "findings",
  "failOn",
  "style",
  "expect",
  "expectRuns",
];
const CALLER_FIELDS = ["goal", "knows", "language", "persona", "behaviours"];
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
export function scenario<const Skills extends readonly ScenarioSkill[] = readonly ScenarioSkill[]>(
  definition: ScenarioDefinition<Skills>,
): Scenario {
  const problems = scenarioProblems(definition);
  if (problems.length > 0) throw new Error(`scenario(): ${problems.join(" ")}`);
  return Object.freeze(Object.defineProperty({ ...definition }, SCENARIO, { value: true }));
}

/** A result a tool's `onSubmit` cannot be checked against: any failure fits every tool. */
type FailedToolResult = { ok: false; message?: string; data?: unknown };

/** What `fake(tool, …)` takes for `tool`: for a tool from `defineTool` with a `schema`, a result
 * of the shape its `onSubmit` returns (or any failure), or a function of its validated input
 * that returns one; for a name or any other tool, any tool result. The result is matched as a
 * whole (`[Result]`), so a tool returning a union of shapes gets one function that may return
 * any of them, not one function per shape. */
type FakeFor<Tool> = Tool extends { readonly onSubmit: (input: infer Input) => infer Returned }
  ? Awaited<Returned> extends infer Result
    ? [Result] extends [ToolResult]
      ? FakeOf<Input, Result | FailedToolResult>
      : ScenarioFake
    : ScenarioFake
  : ScenarioFake;
type FakeOf<Input, Result> = Result | ((input: Input) => Result | Promise<Result>);

/**
 * One fake for the list form of `fakes`: `fakes: [fake(issueRefund, { ok: true, data: { refunded: 49 } })]`.
 * `tool` is the tool's value or its name. Given the value of a tool with a `schema`, TypeScript
 * checks `result` against what the tool's `onSubmit` returns, and a function's input against
 * the schema.
 */
export function fake<const Tool extends string | ScenarioTool>(tool: Tool, result: FakeFor<Tool>): ScenarioFakeEntry {
  const name = toolName(tool);
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("fake(): the tool is a tool's name or a value with its name, such as what defineTool returns.");
  }
  return Object.freeze({ tool: name, result: result as ScenarioFake });
}

/**
 * The fakes of a scenario or a call by tool name, from either form of `fakes`. Throws on a tool
 * given two fakes in the list.
 */
export function fakesByName(
  fakes: Readonly<Record<string, ScenarioFake>> | readonly ScenarioFakeEntry[],
): Readonly<Record<string, ScenarioFake>> {
  if (!isFakeList(fakes)) return fakes;
  // No prototype: a tool named `__proto__` is a key like any other, not the prototype setter.
  const byName: Record<string, ScenarioFake> = Object.create(null);
  for (const entry of fakes) {
    if (Object.prototype.hasOwnProperty.call(byName, entry.tool)) {
      throw new Error(`fakes: ${entry.tool} has two fakes; give each tool one.`);
    }
    byName[entry.tool] = entry.result;
  }
  return byName;
}

/** The name of a tool given as its name or its value. */
export function toolName(tool: string | ScenarioTool): string {
  return typeof tool === "string" ? tool : tool.name;
}

/** Whether `fakes` is the list form, of `fake(tool, result)`. */
export function isFakeList(
  fakes: Readonly<Record<string, ScenarioFake>> | readonly ScenarioFakeEntry[],
): fakes is readonly ScenarioFakeEntry[] {
  return Array.isArray(fakes);
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
  const { runs, minPassRate, expectations, findings, failOn, style, expectRuns } = definition;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    problems.push("name must be a non-empty string.");
  }
  if (caller !== undefined && turns !== undefined) {
    problems.push("Give caller (a simulated caller) or turns (scripted caller lines), not both.");
  } else if (caller === undefined && turns === undefined) {
    problems.push('Give caller: { goal: "..." } for a simulated caller, or turns: ["...", ...] for scripted caller lines.');
  }
  // A caller of your own is any function; what it says is its own.
  if (caller !== undefined && typeof caller !== "function") problems.push(...callerProblems(caller));
  if (turns !== undefined) problems.push(...turnsProblems(turns));
  if (maxTurns !== undefined) {
    if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
      problems.push(`maxTurns must be a whole number of caller turns, at least 1; got ${JSON.stringify(maxTurns)}.`);
    } else if (Array.isArray(turns) && maxTurns < turns.length) {
      problems.push(`maxTurns (${maxTurns}) is less than the ${turns.length} scripted turns; raise it or leave it out.`);
    } else if (caller !== undefined && maxTurns > MAX_SIMULATED_TURNS) {
      problems.push(`maxTurns (${maxTurns}) is more than a simulated caller may take; give at most ${MAX_SIMULATED_TURNS}.`);
    }
  }
  if (runs !== undefined) {
    const problem = runsProblem(runs);
    if (problem) problems.push(`runs ${problem}`);
  }
  if (minPassRate !== undefined && (typeof minPassRate !== "number" || !(minPassRate > 0 && minPassRate <= 1))) {
    problems.push(`minPassRate must be the share of runs that must pass, above 0 and at most 1 (0.8 for four in five); got ${preview(minPassRate)}.`);
  }
  if (expectations !== undefined) problems.push(...expectationsProblems(expectations));
  if (findings !== undefined) problems.push(...findingsProblems(findings));
  if (failOn !== undefined) problems.push(...failOnProblems(failOn, isRecord(findings) ? Object.keys(findings) : []));
  if (style !== undefined) problems.push(...styleLimitsProblems(style).map((problem) => `style: ${problem}`));
  if (client !== undefined) problems.push(...clientProblems(client));
  if (experiments !== undefined) problems.push(...experimentsProblems(experiments));
  if (fakes !== undefined) problems.push(...fakesProblems(fakes));
  if (expect !== undefined && typeof expect !== "function") {
    problems.push('expect must be a function that returns checks, e.g. ({ called }) => [called("book_meeting")].');
  }
  if (expectRuns !== undefined && typeof expectRuns !== "function") {
    problems.push('expectRuns must be a function of the runs that returns checks, e.g. (runs, { check }) => [check("books on most runs", runs.filter((run) => run.called("book").pass).length >= 2)].');
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
  if (Array.isArray(fakes)) {
    const notMade = fakes.flatMap((entry, index) =>
      isRecord(entry) && typeof entry.tool === "string" && "result" in entry ? [] : [index + 1],
    );
    if (notMade.length > 0) {
      return [`fakes: entry ${notMade.join(", ")} is not a fake; make each one with fake(tool, result).`];
    }
    try {
      return fakesProblems(fakesByName(fakes as ScenarioFakeEntry[]));
    } catch (error) {
      return [`${(error as Error).message}`];
    }
  }
  if (!isRecord(fakes)) {
    return ['fakes must be a list of fake(tool, result), or an object of tool name to the result its calls get, e.g. { create_claim: { ok: true, message: "Claim created." } }.'];
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

function expectationsProblems(expectations: unknown): string[] {
  if (!Array.isArray(expectations) || expectations.length === 0) {
    return ['expectations must be a non-empty list of sentences about the call, e.g. ["The agent reads the booking number back."].'];
  }
  const blank = expectations.flatMap((line, index) => (typeof line === "string" && line.trim() ? [] : [index + 1]));
  if (blank.length > 0) return [`expectations must hold one sentence per entry; entry ${blank.join(", ")} is empty or not a string.`];
  if (expectations.length > MAX_EXPECTATIONS) {
    return [`expectations holds ${expectations.length} sentences; give at most ${MAX_EXPECTATIONS}, and move the rest to a scenario of their own.`];
  }
  return [];
}

/** What is wrong with a scenario's own findings, one entry per problem. */
function findingsProblems(findings: unknown): string[] {
  const example = 'e.g. { canned_closing: "The agent ends a reply with a stock line." }';
  if (!isRecord(findings)) return [`findings must be an object of id to one sentence, ${example}.`];
  const entries = Object.entries(findings);
  if (entries.length > MAX_FINDINGS) {
    return [`findings holds ${entries.length} findings; give at most ${MAX_FINDINGS}, and move the rest to a scenario of their own.`];
  }
  return entries.flatMap(([id, sentence]) => {
    if (Object.hasOwn(JUDGE_FINDINGS, id)) return [`findings.${id} is a built-in finding, which the judge already asks; give yours another id.`];
    if (RESERVED_IDS.includes(id) || /^expectation_\d+$/.test(id)) return [`findings.${id}: the judge asks a question of its own under that id; give yours another one.`];
    if (!FINDING_ID.test(id)) return [`findings: ${preview(id)} is no finding id; write it in lowercase words joined by underscores, such as canned_closing.`];
    if (typeof sentence !== "string" || !sentence.trim()) return [`findings.${id} must be one sentence that is true of a call with this problem, ${example}.`];
    return [];
  });
}

function failOnProblems(failOn: unknown, own: readonly string[]): string[] {
  const known = [...Object.keys(JUDGE_FINDINGS), ...own];
  if (!Array.isArray(failOn)) return [`failOn must be a list of judge findings: ${known.join(", ")}.`];
  const unknown = failOn.filter((finding) => typeof finding !== "string" || !known.includes(finding));
  return unknown.length === 0
    ? []
    : [`failOn names ${unknown.map(preview).join(", ")}, which is no judge finding; the findings are ${known.join(", ")}.`];
}

/** What is wrong with `limits` as style limits (`{ wordsP90: 40 }`), one entry per problem. */
function styleLimitsProblems(limits: unknown): string[] {
  if (!isRecord(limits)) return [`give the highest value per style number, e.g. { wordsP90: 40 }; the numbers are ${STYLE_METRICS.join(", ")}.`];
  return Object.entries(limits).flatMap(([metric, limit]) => {
    if (!(STYLE_METRICS as readonly string[]).includes(metric)) {
      return [`"${metric}" is no style number; the numbers are ${STYLE_METRICS.join(", ")}.`];
    }
    return typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? [] : [`${metric} must be a number, 0 or more; got ${preview(limit)}.`];
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

/** What is wrong with `caller` as a simulated caller, one entry per problem. */
export function callerProblems(caller: unknown): string[] {
  if (!isRecord(caller)) return ['caller must be an object: { goal: "...", knows: "..." }.'];
  const problems = unknownFields(caller, CALLER_FIELDS, "caller");
  const { goal, knows, language, persona, behaviours } = caller;
  if (typeof goal !== "string" || !goal.trim()) {
    problems.push('caller.goal must say what the caller wants from the call, e.g. "Book a follow-up call for next week".');
  }
  if (knows !== undefined && typeof knows !== "string") {
    problems.push('caller.knows must be a string with what the caller can tell the agent, e.g. "Name Max Mustermann, email max@example.com".');
  }
  if (language !== undefined && !isLanguageTag(language)) {
    problems.push(`caller.language must be a language code such as "de" or "en-US"; got ${JSON.stringify(language)}.`);
  }
  if (persona !== undefined && (typeof persona !== "string" || !persona.trim())) {
    problems.push('caller.persona must say who the caller is and how they talk, e.g. "An elderly caller who talks slowly".');
  }
  if (behaviours !== undefined) {
    const known: readonly unknown[] = CALLER_BEHAVIOURS;
    const unknown = Array.isArray(behaviours) ? behaviours.filter((behaviour) => !known.includes(behaviour)) : [behaviours];
    if (unknown.length > 0) {
      problems.push(`caller.behaviours takes a list of ${CALLER_BEHAVIOURS.join(", ")}; got ${unknown.map(preview).join(", ")}.`);
    }
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
