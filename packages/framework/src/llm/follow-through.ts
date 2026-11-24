/**
 * Follow-through: an action the model meant to take is taken, not only talked about.
 *
 * A model under a voice prompt fails at a tool in three ways that the conversation alone does
 * not repair, because each ends the turn looking finished:
 *
 * - it ends the call in the same step as a call that was refused (a required field left out),
 *   so the caller hears the goodbye and the refused action never happens;
 * - it writes the tool call as words ("add_to_list(reason=...)") instead of calling it;
 * - it says it is doing something ("I'm checking the calendar now", "you are off the list")
 *   and ends the turn without calling the tool that does it.
 *
 * The session refuses the first ({@link callStaysOpenAfter}), never says the second
 * ({@link namedTool}), and asks the model once more after the third ({@link FOLLOW_THROUGH_CHECK},
 * {@link followThroughTools}, {@link needsFollowThroughCheck}, {@link inventedNumber}).
 *
 * The check repairs a missed action; it must never add one the caller did not ask for. A plain
 * answer or a description ("the assistant notes the caller's number") can read like an
 * announcement, so the check ends the call only after an action of the turn, and never runs a
 * call whose input it made up.
 */

import { END_CALL_TOOL_NAME } from "../types.js";

/** What a refused `end_call` answers when another call of its step did not go through. */
export function callStaysOpenAfter(failed: readonly string[]): string {
  const names = failed.join(", ");
  return (
    `Not run: ${names} did not go through in this step, so the call stays open. ` +
    `Read its result, call it again with what it needs or tell the caller, and end the call after that.`
  );
}

/**
 * A tool name a reply writes in words, or undefined: only names no one says in a sentence
 * (with an underscore, a digit or an inner capital, like `find_slots` or `lookupOrder`), as a
 * whole word. A plain word like `transfer` is never matched, since a reply may say it.
 */
export function namedTool(text: string, toolNames: readonly string[]): string | undefined {
  for (const name of toolNames) {
    if (!/[_\d]|[a-z][A-Z]/.test(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text)) return name;
  }
  return undefined;
}

/** The note a reply that named `tool` in words leaves for the model's next try. */
export function namedToolNote(tool: string): string {
  return (
    `Your last reply was not said: it wrote the tool name ${tool} as words instead of calling it. ` +
    `Call the tool if you meant to, or answer the caller in plain words.`
  );
}

/**
 * The note the model reads, once per turn, after a turn that ended on a statement with no tool
 * call: whether the reply said it is doing, or has done, something a tool does. Its answer is
 * a tool call or nothing; words it writes here are never said.
 */
export const FOLLOW_THROUGH_CHECK =
  "Check your last reply before the caller answers. Did it say that you are doing something now, or have done it " +
  "(looking something up, booking, noting, removing, forwarding, ending the call), that one of your tools does, " +
  "without calling that tool in this turn? If so, call that tool now with the right input. If not, call no tool " +
  "and write nothing. A goodbye is an action: it ends the call. An offer, a suggestion or a question to the caller is not an action yet: it waits for the caller's answer, so " +
  "call no tool for it. An answer or a description of how something works, or of what someone else does, is not " +
  "an action you take now. Never call a tool the reply did not speak of, and never make up an input: if the " +
  "conversation does not give a value the tool needs, call no tool.";

/**
 * The tools a follow-through check offers: the actions a reply can announce that its turn has
 * not run yet (`ran`, by name). A tool that ran is never offered again, so a check cannot
 * repeat its effect. skip_turn and read_skill do nothing a reply announces. `end_call` is
 * offered only once the turn ran one of the agent's own actions: closing the call after an
 * action ("you are off the list, goodbye") is the goodbye a check repairs, while after a turn
 * that only answered, a check that misread the answer as a goodbye would cut the caller off.
 */
export function followThroughTools<T extends { scope: string; name: string }>(
  tools: readonly T[],
  ran: ReadonlySet<string>,
): T[] {
  const acted = tools.some((tool) => tool.scope !== "runtime" && ran.has(tool.name));
  return tools.filter(
    (tool) => !ran.has(tool.name) && (tool.scope !== "runtime" || (acted && tool.name === END_CALL_TOOL_NAME)),
  );
}

/** Fewer digits than this are left alone: a count, a time, a day or an amount, often said in words. */
const LONG_NUMBER_DIGITS = 6;

/**
 * The first long number (a phone, order or account number: six digits or more, spaces allowed
 * between them) in a check call's `input` that none of `heard` contains, or undefined. `heard`
 * is what the conversation holds: the instructions, the caller's and the agent's words, tool
 * results. A check that fills such a number made it up, so its call is not run.
 */
export function inventedNumber(input: unknown, heard: readonly string[]): string | undefined {
  const digits = heard.map((text) => text.replace(/\D/g, ""));
  for (const value of leafValues(input)) {
    for (const match of value.matchAll(/\d(?:[ \u00a0]?\d)*/g)) {
      const number = match[0].replace(/\D/g, "");
      if (number.length >= LONG_NUMBER_DIGITS && !digits.some((known) => known.includes(number))) return match[0];
    }
  }
  return undefined;
}

function leafValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(leafValues);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(leafValues);
  return [];
}

/**
 * Whether a turn that ended on `reply` is checked: it said something, did not end on a question
 * (a reply that waits for the caller has nothing to follow through yet), and the check has a
 * tool to offer ({@link followThroughTools}).
 */
export function needsFollowThroughCheck(reply: string, offered: readonly unknown[]): boolean {
  return reply.trim() !== "" && !/[?？]["'”’»)\]]*\s*$/.test(reply) && offered.length > 0;
}
