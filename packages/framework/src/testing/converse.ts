import { CALLER_PROMPT_VERSION, askCallerAfterHangUp, nextCallerLine } from "./caller.js";
import type { Call } from "./call.js";
import type { ScenarioEndedBy } from "./checks.js";
import { clientOf, testModel, type TestModel } from "./model.js";
import type { CallerEnding, ConversationRecord } from "./record.js";
import { describeProviderError } from "./resilience.js";
import { callerProblems, DEFAULT_MAX_TURNS, type ScenarioCaller, type ScenarioTurn } from "./scenario.js";

/**
 * Callers, and a whole conversation played between one and the agent. A caller is one
 * function: from the conversation so far to the caller's next line, or null to hang up. Any
 * function of that shape is a caller; `simulatedCaller` and `scriptedCaller` are two.
 */

/** What a caller says next: a line; null to hang up; or a line (null for none) and how the call
 * ended for the caller, `end`, as the simulated caller says it with its hang-up marker. */
export type CallerAnswer = string | null | { line: string | null; end?: CallerEnding };

/** What a caller is told beside the conversation: the language the agent speaks, and whether
 * the agent has just hung up (`hungUp`), when the answer is how the call ended for the caller
 * (`{ line: null, end }`), or null when it does not say. */
export type CallerContext = { language: string; hungUp: boolean };

export type Caller = ((turns: readonly ScenarioTurn[], call: CallerContext) => CallerAnswer | Promise<CallerAnswer>) & {
  /** A scripted caller's lines: the conversation ends when every one was said. */
  readonly lines?: readonly string[];
  /** The simulated caller as it was defined: its record holds it, and the judge judges its goal. */
  readonly definition?: ScenarioCaller;
};

/** A model the simulated caller speaks with: a `testModel`, or any function of the same shape. */
type CallerModel = (system: string, input: string) => Promise<string>;

/**
 * A caller an LLM plays: it answers the agent's last reply toward `goal`, one spoken line at a
 * time, says only what `knows` holds, and hangs up itself with a marker that says whether its
 * goal was met. Asked after the agent hung up, it says whether it was done. `model` defaults to
 * `testModel({ role: "caller" })`. Throws, naming every field that is wrong, on a caller that
 * cannot run.
 */
export function simulatedCaller(definition: ScenarioCaller, options: { model?: CallerModel } = {}): Caller {
  const problems = callerProblems(definition);
  if (problems.length > 0) throw new Error(`simulatedCaller(): ${problems.join(" ")}`);
  let model: CallerModel | TestModel | undefined = options.model;
  const llm = async () => clientOf((model ??= await testModel({ role: "caller" })));
  const caller = async (turns: readonly ScenarioTurn[], call: CallerContext): Promise<CallerAnswer> => {
    const language = definition.language ?? call.language;
    if (call.hungUp) {
      try {
        const answer = await askCallerAfterHangUp({ llm: await llm(), caller: definition, language, turns });
        if (!answer) return null;
        return { line: null, end: answer.done ? { done: true, ...answer.end } : { done: false, goalMet: null, reason: answer.wanted } };
      } catch {
        // KEEP-JUSTIFIED: no answer IS the answer "the caller did not say"; the hang-up check reports it.
        return null;
      }
    }
    const answer = await nextCallerLine({ llm: await llm(), caller: definition, language, turns });
    return { line: answer.line || null, ...(answer.end ? { end: { done: true, ...answer.end } } : {}) };
  };
  return Object.assign(caller, { definition });
}

/** The version of the simulated caller's prompt, which a saved run records. */
simulatedCaller.promptVersion = CALLER_PROMPT_VERSION;

/** A caller that says `lines`, one per turn, and has nothing more to say after the last. */
export function scriptedCaller(lines: readonly string[]): Caller {
  const blank = lines.flatMap((line, index) => (typeof line === "string" && line.trim() ? [] : [index + 1]));
  if (lines.length === 0 || blank.length > 0) {
    throw new Error(`scriptedCaller(): give one caller line per entry${blank.length > 0 ? `; entry ${blank.join(", ")} is empty or not a string` : ", at least one"}.`);
  }
  const said = [...lines];
  const caller = (turns: readonly ScenarioTurn[]) => said[turns.filter((turn) => turn.caller !== null).length] ?? null;
  return Object.assign(caller, { lines: said });
}

/**
 * Play a whole conversation between `caller` and the agent on `call`, and return its record. It
 * ends when the agent hangs up, the caller hangs up or runs out of lines, `maxTurns` caller turns
 * were said (default: a scripted caller's lines, else 12), a turn reports an error, or the caller
 * cannot go on (it threw). When the agent hung up on a line that did not end the call for the
 * caller, the caller is asked whether it was done. `onTurn` hears each turn, the opening first,
 * as soon as it is over. The call is closed at the end.
 */
export async function converse(
  call: Call,
  caller: Caller,
  options: { maxTurns?: number; onTurn?: (turn: ScenarioTurn) => void } = {},
): Promise<ConversationRecord> {
  const lines = caller.lines;
  const maxTurns = options.maxTurns ?? lines?.length ?? DEFAULT_MAX_TURNS;
  let endedBy: ScenarioEndedBy | null = null;
  let stopReason: string | undefined;
  let callerEnding: CallerEnding | null = null;
  const after = (turn: ScenarioTurn) => {
    options.onTurn?.(turn);
    if (turn.errors.length > 0) endedBy = "error";
    else if (turn.endedCall) endedBy = "agent";
  };
  if (call.opening) after(call.opening);

  let said = call.turns.filter((turn) => turn.caller !== null).length;
  while (endedBy === null) {
    if (lines && said >= lines.length) {
      endedBy = "script";
      break;
    }
    if (said >= maxTurns) {
      endedBy = "max_turns";
      break;
    }
    let answer: CallerAnswer;
    try {
      answer = await caller(call.turns, { language: call.language, hungUp: false });
    } catch (error) {
      endedBy = "simulator";
      stopReason = describeProviderError(error);
      break;
    }
    const { line, end = null } = typeof answer === "object" && answer !== null ? answer : { line: answer };
    if (!line) {
      endedBy = "caller";
      callerEnding = end;
      break;
    }
    said += 1;
    after(await call.say(line));
    if (end) {
      callerEnding = end;
      endedBy ??= "caller";
    }
  }
  // Turns set it from a callback, which the compiler does not follow.
  const ended = endedBy as ScenarioEndedBy;

  // The agent hung up on a line of the caller's that did not say it was done: ask the caller.
  if (ended === "agent" && !lines && !callerEnding) {
    try {
      const answer = await caller(call.turns, { language: call.language, hungUp: true });
      callerEnding = typeof answer === "object" && answer !== null ? (answer.end ?? null) : null;
    } catch {
      // KEEP-JUSTIFIED: no answer IS the answer "the caller did not say"; the hang-up check reports it.
      callerEnding = null;
    }
  }

  const base = call.record();
  call.close();
  const reason = ended === "error" ? base.ending.reason : stopReason;
  return {
    ...base,
    caller: caller.definition ?? null,
    ending: {
      by: ended,
      ...(reason === undefined ? {} : { reason }),
      unsaid: [...(lines?.slice(said) ?? [])],
      maxTurns,
      ...(ended === "error" && base.ending.providerError ? { providerError: true as const } : {}),
      caller: callerEnding,
    },
  };
}
