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
 * not tried yet (`ran`, by name). A tool that was called is never offered again, so a check
 * cannot repeat its effect or retry a call that was refused. skip_turn and read_skill do
 * nothing a reply announces. `end_call` is offered only once one of the agent's own actions
 * succeeded in the turn (`done`): closing the call after an action ("you are off the list,
 * goodbye") is the goodbye a check repairs, while after a turn that only answered, or whose
 * action was refused, a check that misread the reply as a goodbye would cut the caller off.
 */
export function followThroughTools<T extends { scope: string; name: string }>(
  tools: readonly T[],
  ran: ReadonlySet<string>,
  done: ReadonlySet<string>,
): T[] {
  const acted = tools.some((tool) => tool.scope !== "runtime" && done.has(tool.name));
  return tools.filter(
    (tool) => !ran.has(tool.name) && (tool.scope !== "runtime" || (acted && tool.name === END_CALL_TOOL_NAME)),
  );
}

/** Fewer digits than this, as written, are left alone: a count, a time, a day or an amount. */
const LONG_NUMBER_DIGITS = 6;
/** A country code as written: one to three digits after the `+`, then a space, dash, dot, slash or bracket. */
const COUNTRY_CODE = /^\+(\d{1,3})(?=[ \u00a0./(-])/;
/**
 * A number as written: groups of digits, a leading `+`, a group in brackets, at most one space,
 * dash, slash or dot between groups. Words between numbers keep them apart.
 */
const WRITTEN_NUMBER = /\+?(?:\(\d+\)|\d)(?:[ \u00a0./-]?(?:\(\d+\)|\d))*/g;
/** A date is not a number someone gives: the check may write tomorrow's. */
const DATE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/;

/** A number's digits; whether it was written with a leading `+`; its country code, when written apart. */
type WrittenNumber = { written: string; digits: string; international: boolean; countryCode?: string };

/** A field name that ends in a phone word: `phone`, `callerPhone`, `mobile_number`, `telefonnummer`. */
const PHONE_NAME = /(?:^|[ _-])(?:tele)?(?:phone|tel|mobile|cell|telefon|handy)(?:[ _-]?(?:numbers?|nos?|nr|nummer))?s?$/i;
/** A schema `format` for a phone number. */
const PHONE_FORMAT = /^(?:tel|phone|phone-number|telephone|e164)$/i;
/** A field name that says it holds an identifier, never a phone number, whatever else it says. */
const ID_NAME = /(?:^|[ _-])(?:id|ids|account|plan|contract|order|code|pin|ext|extension)(?:[ _-]|$)/i;

/**
 * The first long number (six digits or more as written, leading zeros included, like
 * `+1 (202) 555-0142`, `030/1234567` or `012345`) in a check call's `input` that nothing in
 * `heard` holds, or undefined. `heard` is what the conversation holds: the instructions, the
 * caller's and the agent's words, tool results. A number in an order, account or any other
 * field matches only digit for digit, as written. A phone field ({@link isPhoneField}) holds one
 * phone number and nothing else (`000`, `17:20`, `unknown (030 1234567)` or an empty value are
 * returned whole), and that number must be one the conversation gave as a phone number
 * ({@link heardPhones}), with or without its country code ({@link samePhone}): an order number
 * never backs a phone field. A check that fills such a value made it up, so its call is not run.
 * Dates are left alone.
 */
export function inventedNumber(input: unknown, heard: readonly unknown[], schema?: unknown): string | undefined {
  const known = leafValues(heard).flatMap((text) => writtenNumbers(text));
  const phones = heardPhones(heard, "words", new WeakSet());
  for (const { text, phone } of fieldValues(input, schema, false, new WeakSet())) {
    if (phone) {
      const number = wholeNumber(text);
      if (number === undefined || !phones.some((said) => samePhone(number, said))) return text;
      continue;
    }
    const numbers = writtenNumbers(text).filter(({ digits }) => digits.length >= LONG_NUMBER_DIGITS);
    const invented = numbers.find((number) => !known.some((said) => sameDigits(number, said)));
    if (invented) return invented.written;
  }
  return undefined;
}

/** `text` when it is one long number and nothing else, spaces around it aside. */
function wholeNumber(text: string): WrittenNumber | undefined {
  const trimmed = text.trim();
  const [number] = writtenNumbers(trimmed);
  return number?.written === trimmed && number.digits.length >= LONG_NUMBER_DIGITS ? number : undefined;
}

/** The strings and numbers in `value`, each with whether it sits in a phone field, read along
 * `schema`. A field is a phone field by its own marker only, never its parent object's; a list's
 * items are the field's values. */
function fieldValues(
  value: unknown,
  schema: unknown,
  phone: boolean,
  seen: WeakSet<object>,
): { text: string; phone: boolean }[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return [{ text: String(value), phone }];
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => fieldValues(item, schemaPart(schema, "items"), phone, seen));
  const properties = schemaPart(schema, "properties");
  return Object.entries(value).flatMap(([name, item]) => {
    const field = schemaPart(properties, name);
    return fieldValues(item, field, isPhoneField(name, field), seen);
  });
}

/**
 * Whether the field `name` (described by `field`) holds a phone number: its name ends in a phone
 * word or its `format` is a phone format. A description is never read: it may speak of a phone
 * number and describe another value ("Account ID for the caller's phone number"). A name that
 * says id, account, plan or code is never a phone field.
 */
function isPhoneField(name: string, field: unknown): boolean {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (ID_NAME.test(words)) return false;
  const format = schemaPart(field, "format");
  return PHONE_NAME.test(words) || (typeof format === "string" && PHONE_FORMAT.test(format));
}

function schemaPart(schema: unknown, key: string): unknown {
  return schema !== null && typeof schema === "object" ? (schema as Record<string, unknown>)[key] : undefined;
}

function writtenNumbers(text: string): (WrittenNumber & { index: number })[] {
  return [...text.matchAll(WRITTEN_NUMBER)]
    .map((match) => ({
      written: match[0],
      index: match.index,
      digits: match[0].replace(/\D/g, ""),
      international: match[0].startsWith("+"),
      countryCode: COUNTRY_CODE.exec(match[0])?.[1],
    }))
    .filter(({ written }) => !DATE.test(written));
}

/** A word that names an identifier: an order, account, customer or contract number. */
const ID_WORD =
  /^(?:ids?|orders?|accounts?|customers?|clients?|contracts?|invoices?|tickets?|ref|references?|bookings?|reservations?|polic(?:y|ies)|claims?|cases?|members?|membership|serial|tracking|iban|pins?|codes?|plans?|rooms?|(?:bestell|auftrag|kunde|konto|vertrag|rechnung|referenz|buchung|vorgang|police|versicherung|mitglied|sendung|zimmer)\p{L}*)$/u;
/** A word that names a phone number or a call: `phone`, `call me`, `Telefon`, `Handynummer`. */
const PHONE_WORD =
  /^(?:(?:tele)?phones?|tel|cell(?:phone)?|mobiles?|calls?|called|reach|whatsapp|(?:telefon|handy|mobil|ruf|anruf|rückruf|zurückruf|erreich|festnetz)\p{L}*)$/u;
/** A bare "number": a phone number unless an id word comes right before it ("order number"). */
const NUMBER_WORD = /^(?:numbers?|nummer\p{L}*)$/u;
/** How many words around a number may name it. */
const CONTEXT_WORDS = 6;

type NumberKind = "phone" | "id" | undefined;

/**
 * The numbers in `heard` given as phone numbers. In a tool result only a value under a phone key
 * (`phone`, `callerPhone`) is one; a value under any other key (`customerNumber`, `orderId`,
 * `note`) never is, whatever it looks like. In words, the nearest naming word on each side of
 * the number says it ({@link spokenKind}). `place` is where `value` sits: in words, or under a
 * phone key or another key of a tool result.
 */
function heardPhones(value: unknown, place: "words" | "phone" | "other", seen: WeakSet<object>): WrittenNumber[] {
  if (typeof value === "number" || typeof value === "bigint") return place === "phone" ? writtenNumbers(String(value)) : [];
  if (typeof value === "string") {
    if (place !== "words") return place === "phone" ? writtenNumbers(value) : [];
    return writtenNumbers(value).filter((number) => spokenKind(value, number) === "phone");
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => heardPhones(item, place, seen));
  return Object.entries(value).flatMap(([name, item]) =>
    heardPhones(item, isPhoneField(name, undefined) ? "phone" : "other", seen),
  );
}

/**
 * What the words around `number` in `text` call it. An id label on either side ("order number",
 * "Kundennummer") makes it an id, whatever callback words stand on the other side; else a phone
 * word on either side ("my number is", "call me on", "Telefonnummer") makes it a phone number.
 * A label right before the next long number names that one ({@link ownWordsAfter}). A
 * number no word names is a phone number when it is written as one: a country code or a trunk
 * zero.
 */
function spokenKind(text: string, number: WrittenNumber & { index: number }): NumberKind {
  const before = words(text.slice(0, number.index).split(/[.!?;\n](?=\s|$)/).pop() ?? "").reverse();
  const after = words(ownWordsAfter(text.slice(number.index + number.written.length).split(/[.!?;\n](?=\s|$)/)[0] ?? ""));
  const kinds = [wordKind(before), wordKind(after.filter((word) => !/^\d/.test(word)))];
  if (kinds.includes("id")) return "id";
  if (kinds.includes("phone")) return "phone";
  return number.international || /^0[1-9]/.test(number.digits) ? "phone" : undefined;
}

/**
 * The part of `after`, the words following a number, that names that number. The words right
 * before the next long number, with no comma between them and it, name that number instead
 * ("and my order is 12345678"); a time or a short number takes no label.
 */
function ownWordsAfter(after: string): string {
  const next = writtenNumbers(after).find(({ digits }) => digits.length >= LONG_NUMBER_DIGITS);
  if (next === undefined) return after;
  const lead = after.slice(0, next.index);
  return lead.slice(0, Math.max(0, lead.search(/[,;][^,;]*$/)));
}

/** The words of `text`, lower case, camelCase split (`customerNumber`: customer number). */
function words(text: string): string[] {
  return text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").toLowerCase().match(/[\p{L}\d]+/gu) ?? [];
}

/** The kind the first naming word in `nearestFirst` gives; another number on the way ends the search. */
function wordKind(nearestFirst: readonly string[]): NumberKind {
  for (const [at, word] of nearestFirst.slice(0, CONTEXT_WORDS).entries()) {
    if (/^\d/.test(word)) return undefined;
    if (ID_WORD.test(word)) return "id";
    if (PHONE_WORD.test(word)) return "phone";
    if (NUMBER_WORD.test(word)) return ID_WORD.test(nearestFirst[at + 1] ?? "") ? "id" : "phone";
  }
  return undefined;
}

/** The same number, digit for digit as written: an order or account number. */
function sameDigits(written: WrittenNumber, said: WrittenNumber): boolean {
  return written.digits === said.digits;
}

/**
 * The same phone number, in one canonical form: digit for digit, or a number written without a
 * country code that, its single trunk zero aside, is exactly the digits after the other one's
 * country code as written (`+49 89 1234567`: `49`). Two numbers that both carry a country code,
 * or a country code not written apart from the rest (`+49891234567`), match only in full; no
 * other digit is ever dropped.
 */
function samePhone(written: WrittenNumber, said: WrittenNumber): boolean {
  if (written.digits === said.digits) return true;
  if (written.international === said.international) return false;
  const [withCode, without] = written.international ? [written, said] : [said, written];
  const national = without.digits.replace(/^0/, "");
  return (
    withCode.countryCode !== undefined &&
    national.length >= LONG_NUMBER_DIGITS &&
    withCode.digits === withCode.countryCode + national
  );
}

/** Every string and number in `value`, however deep; each object is read once. */
function leafValues(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "bigint") return [String(value)];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).flatMap((item) => leafValues(item, seen));
}

/**
 * Whether a turn that ended on `reply` is checked: it said something, did not end on a question
 * (a reply that waits for the caller has nothing to follow through yet), and the check has a
 * tool to offer ({@link followThroughTools}).
 */
export function needsFollowThroughCheck(reply: string, offered: readonly unknown[]): boolean {
  return reply.trim() !== "" && !/[?？]["'”’»)\]]*\s*$/.test(reply) && offered.length > 0;
}
