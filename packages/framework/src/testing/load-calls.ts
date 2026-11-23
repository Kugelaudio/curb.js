import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { recordedConversations } from "../cli/conversations.js";
import { resolveProjectRoot } from "../project.node.js";
import { END_CALL_TOOL_NAME, type ToolResult } from "../types.js";
import type { ScenarioEndedBy } from "./checks.js";
import type { ConversationRecord, ConversationSource, RecordedTool } from "./record.js";
import type { ScenarioToolCall, ScenarioTurn } from "./scenario.js";

/**
 * Calls from the files they come in, as conversation records: a saved test run, a Calls export
 * of the KugelAudio dashboard, `curb conversations --json`, a written transcript, and the
 * `curb dev` store itself. A file is recognised by what it holds, never by its name, and each
 * call becomes the record every check and judge reads, with what its source knows beyond the
 * words: whether tool calls are recorded, and who ended the call.
 */

/** One call as its source holds it. */
export type ReviewCall = {
  /** How the report names the call: its id where it comes from. */
  id: string;
  source: ConversationSource;
  startedAt?: string;
  durationMs?: number;
  /** The record itself, for a conversation of a saved test run. */
  record?: ConversationRecord;
  turns: ScenarioTurn[];
  /** Who ended the call; null when the source does not say. */
  endedBy: ScenarioEndedBy | null;
  /** Whether the source records the agent's tool calls. Where it does not, a call without one
   * says nothing about the tools. */
  recordsTools: boolean;
  /** The tools the agent was offered, where the source holds them. */
  tools?: readonly RecordedTool[];
};

/** The calls of one source, and how many it held that have no transcript. */
export type ReadCalls = { calls: ReviewCall[]; skipped: number };

/** The shapes `curb review` reads, as a refusal lists them. */
export const REVIEW_SHAPES = [
  "a saved test run (.curb/test-runs/<id>.json)",
  "a Calls export from the KugelAudio dashboard (JSON Lines, one call per line)",
  "the output of `npx curb conversations --json`",
  'a text or Markdown file with one call, whose lines start with "Caller:" and "Agent:"',
].join("; ");

type Line = { by: "caller" | "agent"; text: string; toolCalls?: ScenarioToolCall[] };

/** What a turn read from a transcript has beyond its words: nothing. */
const NO_TURN = { reply: "", fallback: null, confirmation: null, skillPath: "", skipped: false, endedCall: false, steps: 0 };

/** Spoken lines as turns: each caller line opens one, and what the agent says and calls until
 * the next caller line is its answer. An agent that speaks first opens with turn 0. */
function turnsOf(lines: readonly Line[]): ScenarioTurn[] {
  const turns: ScenarioTurn[] = [];
  const join = (before: string, text: string) => [before, text.trim()].filter(Boolean).join(" ");
  for (const line of lines) {
    const calls = line.toolCalls ?? [];
    if (!line.text.trim() && calls.length === 0) continue;
    let last = turns.at(-1);
    const answered = last !== undefined && (last.reply !== "" || last.toolCalls.length > 0);
    if (line.by === "caller" && last && last.caller !== null && !answered) last.caller = join(last.caller, line.text);
    else if (line.by === "caller" || !last) {
      const caller = line.by === "caller" ? line.text.trim() : null;
      const turn = caller === null ? 0 : (last?.turn ?? 0) + 1;
      last = { ...NO_TURN, turn, caller, toolCalls: [], errors: [], contextDiff: [] };
      turns.push(last);
    }
    if (line.by === "agent") {
      last.reply = join(last.reply, line.text);
      last.toolCalls.push(...calls);
      last.endedCall ||= calls.some((call) => call.name === END_CALL_TOOL_NAME);
    }
  }
  return turns;
}

/** A conversation of a saved test run, which is already the record the judge reads. */
function savedCall(conversation: unknown): ReviewCall | null {
  if (!isRecord(conversation) || !Array.isArray(conversation.turns)) return null;
  const scenario = isRecord(conversation.scenario) ? conversation.scenario : {};
  const ending = isRecord(conversation.ending) ? conversation.ending : {};
  return {
    id: `${String(scenario.name ?? "conversation")} run ${String(scenario.run ?? 1)}`,
    source: "scenario",
    record: conversation as ConversationRecord,
    turns: conversation.turns as ScenarioTurn[],
    endedBy: typeof ending.by === "string" ? (ending.by as ScenarioEndedBy) : null,
    recordsTools: true,
    ...(Array.isArray(conversation.tools) ? { tools: conversation.tools as RecordedTool[] } : {}),
  };
}

const parsed = (json: unknown): unknown => {
  try {
    return typeof json === "string" ? JSON.parse(json) : null;
  } catch {
    // KEEP-JUSTIFIED: not JSON IS the answer "no value"; the message or the file is read without it.
    return null;
  }
};

/**
 * A conversation of the `curb dev` store, as `curb conversations --json` prints it. A tool
 * result belongs to the earliest call of that tool that has none yet. The agent ended the call
 * when it called end_call; otherwise the store does not say how the conversation stopped.
 */
export function storedCall(conversation: unknown): ReviewCall | null {
  if (!isRecord(conversation) || !Array.isArray(conversation.messages)) return null;
  const lines: Line[] = [];
  const calls: ScenarioToolCall[] = [];
  for (const message of conversation.messages.filter(isRecord)) {
    const text = typeof message.content === "string" ? message.content : "";
    if (message.role === "user") lines.push({ by: "caller", text });
    else if (message.role === "assistant") {
      const called = parsed(message.tool_calls);
      const toolCalls = (Array.isArray(called) ? called : []).filter(isRecord).map((call): ScenarioToolCall => ({
        name: String(call.name),
        input: isRecord(call.input) ? call.input : {},
        ok: false,
        result: null,
      }));
      calls.push(...toolCalls);
      lines.push({ by: "agent", text, toolCalls });
    } else if (message.role === "tool") {
      const call = calls.find((candidate) => candidate.name === message.tool_name && candidate.result === null);
      const result = parsed(message.tool_result);
      if (call && isRecord(result)) Object.assign(call, { result: result as ToolResult, ok: result.ok === true });
    }
  }
  const ended = calls.some((call) => call.name === END_CALL_TOOL_NAME && call.ok);
  return {
    id: `conversation ${String(conversation.id)}`,
    source: "dev",
    ...(typeof conversation.startedAt === "string" ? { startedAt: conversation.startedAt } : {}),
    turns: turnsOf(lines),
    endedBy: ended ? "agent" : null,
    recordsTools: true,
  };
}

/** Who ended a hosted call, from the export's `endReason`. */
const ENDED_BY: Readonly<Record<string, ScenarioEndedBy>> = {
  agent_completed: "agent",
  caller_ended: "caller",
  caller_hangup: "caller",
  client_disconnect: "caller",
};

const isExportedCall = (value: unknown): value is Record<string, unknown> => isRecord(value) && typeof value.callId === "string";

const CALLER_LABELS = ["caller", "user", "customer"];
const AGENT_LABELS = ["agent", "assistant", "bot"];

/** Who a speaker label names, whatever its case; null for a label of neither. */
function speaker(label: unknown): Line["by"] | null {
  const name = typeof label === "string" ? label.trim().toLowerCase() : "";
  return CALLER_LABELS.includes(name) ? "caller" : AGENT_LABELS.includes(name) ? "agent" : null;
}

/** The outcomes of a tool call that ran and succeeded, as an exported call's `toolCalls` word them. */
const OK_OUTCOMES = new Set(["ok", "success", "succeeded", "completed"]);

/** A line's `error`: its words, whether it is a string or an object with a message. */
function errorText(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) return error;
  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) return error.message;
  return undefined;
}

/** The fields of a result as a hosted call's tool event carries it (`curb.tool` of the host
 * protocol): `{ message?, data?, truncated? }`, with whether the call succeeded beside it. */
const EVENT_RESULT_FIELDS = new Set(["message", "data", "truncated"]);

/** Whether `result` is a tool event's result: an object with nothing but those fields, at least
 * one of them, and a `message` that is text. Any other object is the tool's data. */
function isEventResult(result: unknown): result is { message?: string; data?: unknown; truncated?: unknown } {
  if (!isRecord(result)) return false;
  const fields = Object.keys(result);
  if (fields.length === 0 || !fields.every((field) => EVENT_RESULT_FIELDS.has(field))) return false;
  return result.message === undefined || typeof result.message === "string";
}

/** One entry of an exported call's `toolCalls` (`{ name, offsetMs, ok | outcome, input | arguments,
 * result, error }`) as the tool call a turn holds; null for an entry without a name. `ok`, when
 * the entry has it, says whether the call succeeded; otherwise its `outcome` does, and without
 * either it succeeded when it has no error. Its `result` is a whole `{ ok, message, data }`, a
 * tool event's `{ message, data }` beside the entry's own `ok`, or else the tool's data. */
function exportedToolCall(entry: Record<string, unknown>): ScenarioToolCall | null {
  if (typeof entry.name !== "string" || !entry.name.trim()) return null;
  const input = isRecord(entry.input) ? entry.input : isRecord(entry.arguments) ? entry.arguments : {};
  const outcome = typeof entry.outcome === "string" ? entry.outcome.trim().toLowerCase() : undefined;
  const error = errorText(entry.error);
  const heldFor = typeof entry.heldFor === "string" ? entry.heldFor : undefined;
  const ok = typeof entry.ok === "boolean" ? entry.ok : outcome !== undefined ? OK_OUTCOMES.has(outcome) : error === undefined && heldFor === undefined;
  let result: ToolResult | null = null;
  if (isRecord(entry.result) && typeof entry.result.ok === "boolean") {
    result = { ...(entry.result as ToolResult), ...(error && typeof entry.result.message !== "string" ? { message: error } : {}) };
  } else if (isEventResult(entry.result)) {
    const message = entry.result.message ?? error;
    result = { ok, ...(message !== undefined ? { message } : {}), ...(entry.result.data !== undefined ? { data: entry.result.data } : {}) };
  } else if (entry.result !== undefined || error !== undefined) {
    result = { ok, ...(error !== undefined ? { message: error } : {}), ...(entry.result !== undefined ? { data: entry.result } : {}) };
  }
  return { name: entry.name, input, ok, result, ...(heldFor !== undefined ? { heldFor } : {}) };
}

/**
 * What was said and what the agent called in an exported call, in the order it happened: each
 * line at the time it was said (`startOffsetMs`), each tool call at its `offsetMs`. At the same
 * time a caller's line comes first, then the tool call, then the agent's words, so a tool call
 * goes with the agent turn that answers the caller. A line or a tool call without a time goes
 * where the one before it was.
 */
function inCallOrder(spoken: readonly Line[], times: readonly unknown[], calls: ReadonlyArray<{ call: ScenarioToolCall; at: unknown }>): Line[] {
  const timed: Array<{ line: Line; at: number; rank: number; index: number }> = [];
  const place = (line: Line, at: unknown, rank: number, previous: number) => {
    const when = typeof at === "number" && Number.isFinite(at) ? at : previous;
    timed.push({ line, at: when, rank, index: timed.length });
    return when;
  };
  let previous = 0;
  spoken.forEach((line, index) => {
    previous = place(line, times[index], line.by === "caller" ? 0 : 2, previous);
  });
  previous = 0;
  for (const { call, at } of calls) previous = place({ by: "agent", text: "", toolCalls: [call] }, at, 1, previous);
  return timed.sort((a, b) => a.at - b.at || a.rank - b.rank || a.index - b.index).map((entry) => entry.line);
}

/** One line of a Calls export: what was said, and, where the line carries `toolCalls`, what the
 * agent called and when, each tool call in the agent turn it happened in. A line without
 * `toolCalls` holds no tool calls, so the record says it does not record them. */
function exportedCall(call: Record<string, unknown>): ReviewCall {
  const spoken = isRecord(call.transcript) && Array.isArray(call.transcript.turns) ? call.transcript.turns.filter(isRecord) : [];
  const said = spoken.flatMap((turn) => {
    const by = speaker(turn.speaker);
    return by && typeof turn.text === "string" ? [{ line: { by, text: turn.text } as Line, at: turn.startOffsetMs }] : [];
  });
  const recordsTools = Array.isArray(call.toolCalls);
  const toolCalls = (recordsTools ? (call.toolCalls as unknown[]) : []).filter(isRecord).flatMap((entry) => {
    const toolCall = exportedToolCall(entry);
    return toolCall ? [{ call: toolCall, at: entry.offsetMs }] : [];
  });
  const lines = recordsTools ? inCallOrder(said.map((entry) => entry.line), said.map((entry) => entry.at), toolCalls) : said.map((entry) => entry.line);
  // The end reason says who ended the call; where it does not, an end_call that ran says the agent did.
  const endedBy = typeof call.endReason === "string" && Object.hasOwn(ENDED_BY, call.endReason)
    ? ENDED_BY[call.endReason]!
    : toolCalls.some(({ call: toolCall }) => toolCall.name === END_CALL_TOOL_NAME && toolCall.ok) ? "agent" : null;
  // The dashboard's export writes the call's length in seconds; a line may hold milliseconds instead.
  const seconds = call.durationSeconds;
  const durationMs = typeof call.durationMs === "number"
    ? call.durationMs
    : typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  return {
    id: String(call.callId),
    source: "calls-export",
    ...(typeof call.startedAt === "string" ? { startedAt: call.startedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    turns: turnsOf(lines),
    endedBy,
    recordsTools,
  };
}

/** A line that starts with who speaks, with or without Markdown bold around the label. */
const SPEAKER = new RegExp(`^\\s*(?:\\*\\*|__)?\\s*(${[...CALLER_LABELS, ...AGENT_LABELS].join("|")})\\s*(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*(.*)$`, "i");

/** The one call of a text or Markdown transcript; null when it has no line of each speaker. A
 * line without a label goes on with the line before it, and what stands before the first label
 * is no part of the call. */
function writtenCall(id: string, text: string): ReviewCall | null {
  const lines: Line[] = [];
  for (const row of text.split(/\r?\n/)) {
    const [, label, said] = SPEAKER.exec(row) ?? [];
    if (label !== undefined) lines.push({ by: speaker(label)!, text: said ?? "" });
    else if (lines.length > 0 && row.trim()) lines.at(-1)!.text += ` ${row.trim()}`;
  }
  if (!lines.some((line) => line.by === "caller") || !lines.some((line) => line.by === "agent")) return null;
  return { id, source: "transcript", turns: turnsOf(lines), endedBy: null, recordsTools: false };
}

/**
 * The calls in the text of one file, named `name`; null when it has none of the shapes
 * ({@link REVIEW_SHAPES}). A call without a transcript is left out and counted.
 */
export function callsIn(name: string, text: string): ReadCalls | null {
  const whole = parsed(text);
  const rows = text.split(/\r?\n/).filter((row) => row.trim()).map(parsed);
  let found: Array<ReviewCall | null> | null = null;
  if (isRecord(whole) && Array.isArray(whole.conversations)) {
    found = whole.conversations.map(whole.format === "curb.test-run" ? savedCall : storedCall);
  } else if (rows.length > 0 && rows.every(isExportedCall)) found = rows.map(exportedCall);
  else if (whole === null) found = [writtenCall(name, text)];
  if (found === null || found.includes(null)) return null;
  const calls = (found as ReviewCall[]).filter((call) => call.turns.length > 0);
  return { calls, skipped: found.length - calls.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The record of one call: a saved run's conversation as it is, with its id; any other call
 * with what its source holds. */
function recordOf(call: ReviewCall): ConversationRecord {
  if (call.record) return { ...call.record, id: call.id };
  return {
    format: "curb.conversation",
    version: 1,
    source: call.source,
    id: call.id,
    caller: null,
    experiments: {},
    startedAt: call.startedAt ?? null,
    durationMs: call.durationMs ?? 0,
    turns: call.turns,
    ...(call.tools ? { tools: [...call.tools] } : {}),
    ending: { by: call.endedBy, unsaid: [], maxTurns: call.turns.filter((turn) => turn.caller !== null).length, caller: null },
    endState: null,
    unusedFakes: [],
    usage: null,
    ...(call.recordsTools ? {} : { recordsToolCalls: false as const }),
  };
}

/** The calls `loadCalls` read: every call with a transcript, how many it left out for having
 * none, and the files in a folder it left out for holding no calls. */
export type LoadedCalls = { calls: ConversationRecord[]; skipped: number; ignored: string[] };

const READ_EXTENSIONS = [".json", ".jsonl", ".md", ".txt"];

/** Whether `text` is the `curb dev` store: JSON lines, each a record of its journal, but for a
 * last one cut short by a process that stopped while it wrote. */
function isDevStore(text: string): boolean {
  const rows = text.split(/\r?\n/).filter((row) => row.trim()).map(parsed);
  const records = rows.slice(0, -1).every(isRecord) ? rows.filter(isRecord) : [];
  return records.some((row) => row.t === "conversation") && records.every((row) => typeof row.t === "string");
}

/**
 * The calls in files, as conversation records. A path is a file, or a folder whose .json,
 * .jsonl, .md and .txt files are read; a relative one is read from `root`. A file is one of
 * {@link REVIEW_SHAPES}, or the `curb dev` store itself (`.data/conversations.jsonl`), of which
 * `last` picks the newest conversations. Throws, naming the file and the shapes there are, on a
 * file given by name that holds no calls; in a folder, such a file (a README beside the exports)
 * is left out and named in `ignored`.
 */
export function loadCalls(paths: string | readonly string[], options: { last?: number; root?: string } = {}): LoadedCalls {
  const root = options.root ?? resolveProjectRoot();
  const read: LoadedCalls = { calls: [], skipped: 0, ignored: [] };
  for (const given of typeof paths === "string" ? [paths] : paths) {
    const path = resolve(root, given);
    if (!existsSync(path)) throw new Error(`[CURB_REVIEW_NOT_FOUND] No file or folder at ${given}.\nFix: pass ${REVIEW_SHAPES}; or a folder of such files.`);
    const isCallFile = (name: string) => READ_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
    const folder = statSync(path).isDirectory();
    // Each file as a refusal or a note names it: the way it was given.
    const files = folder ? readdirSync(path).filter(isCallFile).sort().map((name) => join(given, name)) : [given];
    for (const file of files) {
      const text = readFileSync(resolve(root, file), "utf8");
      const found = !folder && isDevStore(text) ? storedCalls(resolve(root, file), options.last) : callsIn(basename(file), text);
      if (!found && folder) read.ignored.push(file);
      else if (!found) throw new Error(`[CURB_REVIEW_UNREADABLE] ${file} holds no calls in a shape curb review reads.\nFix: pass ${REVIEW_SHAPES}.`);
      else {
        read.calls.push(...found.calls.map(recordOf));
        read.skipped += found.skipped;
      }
    }
  }
  return read;
}

/** The shapes {@link loadCalls} reads, as a refusal lists them. */
loadCalls.shapes = REVIEW_SHAPES;

/** The newest `last` conversations of the `curb dev` store at `file` (all of them without). */
function storedCalls(file: string, last = Number.MAX_SAFE_INTEGER): ReadCalls {
  const found = recordedConversations(dirname(file), file, { last, id: null, json: false }).map((conversation) => storedCall(conversation)!);
  const calls = found.filter((call) => call.turns.length > 0);
  return { calls, skipped: found.length - calls.length };
}
