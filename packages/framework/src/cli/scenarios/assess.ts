import {
  builtInChecks,
  checksOf,
  judge,
  type ConversationRecord,
  type JudgeFinding,
  type Scenario,
  type ScenarioCheck,
  type ScenarioTurn,
  type TestModel,
} from "../../testing/index.js";
import type { Assessment, JudgeAnswer, JudgeResult, RunError } from "./types.js";

/** The names of the checks the runner adds to the built-in ones. */
const BUILT_IN_CHECKS = { goal: "the caller reaches its goal" } as const;

/** A sentence as two of them are compared: ignoring case, punctuation and spacing. */
const sentenceKey = (sentence: string) => sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * What a finished conversation comes to: pass, fail, or error. Everything here reads a
 * {@link ConversationRecord}, so a conversation that just ran and one loaded from a saved run
 * are assessed by the same code. A run is an error when something other than the agent decided
 * it (the provider, the simulated caller, the turn limit, the judge): it says nothing about
 * the agent and is left out of the pass rate.
 */

/** What a scenario asks of each of its conversations. A saved conversation whose scenario is
 * gone is assessed with the settings saved beside it, and without `expect`. */
export type AssessmentSettings = {
  expectations: readonly string[];
  failOn: readonly JudgeFinding[];
  expect?: Scenario["expect"];
};

export function assessmentSettings(scenario: Scenario): AssessmentSettings {
  return { expectations: scenario.expectations ?? [], failOn: scenario.failOn ?? [], ...(scenario.expect ? { expect: scenario.expect } : {}) };
}

/** A caller line said this often in a row, to an agent that did not repeat itself, is a loop. */
export const CALLER_LOOP = 3;

export async function assessConversation(params: {
  record: ConversationRecord;
  settings: AssessmentSettings;
  /** The judge's model. Asked once, when the conversation has a simulated caller or expectations. */
  judge: TestModel;
}): Promise<Assessment> {
  const { record, settings } = params;
  const { turns, ending, caller } = record;
  const checks = builtInChecks(record);

  let error = brokenRun(record);
  let judged: JudgeResult | null = null;
  // A conversation that stopped on an error is not judged: half a call reaches no goal.
  const brokeOff = ending.by === "error" || ending.by === "simulator";
  const judges = caller !== null || settings.expectations.length > 0;
  if (judges && !error && !brokeOff) {
    try {
      const { promptVersion, model, answers } = await judge(record, { expectations: settings.expectations, model: params.judge });
      judged = { promptVersion, model, answers };
    } catch (cause) {
      error = { kind: "judge", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  const notJudged = (name: string): ScenarioCheck => ({
    name,
    pass: false,
    detail: `not judged: ${error && !brokeOff ? error.message : "the conversation broke off before it ended"}`,
    notJudged: true,
  });
  const answers = judged?.answers ?? [];

  if (caller) {
    const goal = answers.find((answer) => answer.kind === "goal");
    checks.push(goal ? judgedCheck(BUILT_IN_CHECKS.goal, goal, goal.answer === "yes") : notJudged(BUILT_IN_CHECKS.goal));
  }
  for (const [index, sentence] of settings.expectations.entries()) {
    const name = `expectation: ${sentence}`;
    const answer = answers.find((candidate) => candidate.id === `expectation_${index + 1}`);
    // An unknown is no evidence against the agent: it is shown and counted, and fails nothing.
    checks.push(answer ? judgedCheck(name, answer, answer.answer !== "no") : notJudged(name));
  }
  for (const finding of settings.failOn) {
    const answer = answers.find((candidate) => candidate.id === finding);
    if (answer) checks.push(judgedCheck(`no judge finding: ${finding}`, answer, answer.answer !== "yes"));
  }
  checks.push(...(await authorChecks(settings.expect, record)));

  // The turn limit cut the caller off, the goal was not reached, and nothing shows the agent
  // caused it: the limit, not the agent, decided this run.
  if (!error && ending.by === "max_turns" && caller && !checks.every((check) => check.pass)) {
    const onlyGoalFailed = checks.every((check) => check.pass || check.name === BUILT_IN_CHECKS.goal);
    const agentFault = answers.some((answer) => answer.kind === "finding" && answer.answer === "yes");
    if (onlyGoalFailed && !agentFault) {
      error = {
        kind: "max_turns",
        message: `the call was cut off at maxTurns (${ending.maxTurns}) before the caller was done, and no fault of the agent's was found. Raise maxTurns, or give the caller a goal it reaches sooner.`,
      };
    }
  }

  return {
    outcome: error ? "error" : checks.every((check) => check.pass) ? "pass" : "fail",
    ...(error ? { error } : {}),
    checks,
    notes: notesOf(record, settings, answers),
    judge: judged,
  };
}

/** A check from the judge's answer: its reason as the detail, and what it pointed at. */
function judgedCheck(name: string, answer: JudgeAnswer, pass: boolean): ScenarioCheck {
  const prefix = answer.answer === "unknown" ? "unknown: " : "";
  return { name, pass, detail: `${prefix}${answer.reason}`, evidence: { answer: answer.answer, turn: answer.turn, quote: answer.quote } };
}

/** Why the conversation itself says nothing about the agent, read from the record alone. */
function brokenRun(record: ConversationRecord): RunError | undefined {
  const { ending, turns, caller } = record;
  if (ending.by === "simulator") {
    return { kind: "simulator", message: `the simulated caller could not go on: ${ending.reason ?? "it gave no line"}` };
  }
  if (ending.providerError) {
    return { kind: "provider", message: `the agent's LLM provider failed, after the retries: ${ending.reason ?? "no reason given"}` };
  }
  if (!caller) return undefined;
  const invented = inventedFact(record);
  if (invented) return { kind: "invented_fact", message: invented };
  const loop = callerLoop(turns);
  return loop ? { kind: "simulator_loop", message: loop } : undefined;
}

/** The caller repeating one line {@link CALLER_LOOP} times in a row while the agent's replies
 * to it differ: the simulator is stuck. An agent that repeats itself too is the agent's loop. */
function callerLoop(turns: readonly ScenarioTurn[]): string | undefined {
  const spoken = turns.filter((turn) => turn.caller !== null);
  for (let start = 0; start + CALLER_LOOP <= spoken.length; start += 1) {
    const run = spoken.slice(start, start + CALLER_LOOP);
    const line = sentenceKey(run[0]!.caller!);
    if (!line || !run.every((turn) => sentenceKey(turn.caller!) === line)) continue;
    if (new Set(run.map((turn) => sentenceKey(turn.reply))).size === 1) continue;
    return `the simulated caller said ${JSON.stringify(run[0]!.caller)} ${CALLER_LOOP} times in a row from turn ${run[0]!.turn}, while the agent's replies moved on.`;
  }
  return undefined;
}

/** What counts as a hard fact in a caller's line: an email address, a number of five or more
 * digits (a phone, a policy, a postcode), or a reference in capitals such as "KV-123". */
const FACTS = [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, /(?<![\w.])\+?\d(?:[\s./-]?\d){4,}(?!\w)/g, /\b[A-Z]{1,6}-?\d{3,}\b/g];

const digitsOf = (text: string) => text.replace(/\D/g, "");
/** Text as two spellings of one fact are compared: ignoring case, spaces and hyphens. */
const compact = (text: string) => text.toLowerCase().replace(/[\s-]+/g, "");

/**
 * The first hard fact the caller said that it was never given: not in its goal, `knows` or
 * persona, and not said by the agent before. Only what can be compared by its characters is
 * looked at ({@link FACTS}); a made-up name or a number spelled out in words is not caught.
 * Only a simulated caller is asked: scripted lines are the author's own words. A caller
 * without `knows` was told it has no details, so for it every such fact is made up unless its
 * goal or the agent said it.
 */
function inventedFact(record: ConversationRecord): string | undefined {
  const caller = record.caller!;
  let given = [caller.goal, caller.knows ?? "", caller.persona ?? ""].join("\n");
  for (const turn of record.turns) {
    if (turn.caller !== null) {
      for (const pattern of FACTS) {
        for (const [fact] of turn.caller.matchAll(pattern)) {
          const digits = digitsOf(fact);
          const numeric = digits.length >= 5 && !/[A-Za-z@]/.test(fact);
          const known = numeric ? digitsOf(given).includes(digits) : compact(given).includes(compact(fact));
          if (!known) {
            const missing = caller.knows?.trim() ? "which is not in caller.knows" : "and the scenario gives its caller no knows";
            return `turn ${turn.turn}: the simulated caller said ${JSON.stringify(fact.trim())}, ${missing}. Add it to caller.knows if the caller should know it; otherwise the caller made it up.`;
          }
        }
      }
    }
    // What the agent said is known to the caller from here on, and so is what it said itself.
    given += `\n${turn.caller ?? ""}\n${turn.reply}`;
  }
  return undefined;
}

function notesOf(record: ConversationRecord, settings: AssessmentSettings, answers: readonly JudgeAnswer[]): string[] {
  const notes = record.unusedFakes.map((tool) => `the fake for ${tool} was never used: no call of ${tool} ran`);
  if (!settings.expect && settings.expectations.length === 0) {
    notes.push("this scenario has no checks of its own (expect), so only the built-in checks ran");
  }
  const goal = answers.find((answer) => answer.kind === "goal");
  const said = record.ending.caller?.goalMet;
  if (goal && goal.answer !== "unknown" && said !== null && said !== undefined && said !== (goal.answer === "yes")) {
    notes.push(`the caller said its goal was ${said ? "met" : "not met"}, and the judge says it was ${goal.answer === "yes" ? "reached" : "not reached"}`);
  }
  return notes;
}

/** The author's `expect` checks. Whatever it does wrong becomes a failed check that says so. */
async function authorChecks(expect: Scenario["expect"], record: ConversationRecord): Promise<ScenarioCheck[]> {
  if (!expect) return [];
  let returned: unknown;
  try {
    returned = await expect(checksOf(record));
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
