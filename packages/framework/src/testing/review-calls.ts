import { END_CALL_TOOL_NAME, type ToolResult } from "../types.js";
import type { ScenarioEndedBy } from "./checks.js";
import type { RecordedTool } from "./record.js";
import type { ScenarioToolCall, ScenarioTurn } from "./scenario.js";

/**
 * The calls `curb review` reads, from the four shapes a file can have. A file is recognised by
 * what it holds, never by its name, and each call becomes the turns the judge reads, with what
 * its source knows beyond the words: whether tool calls are recorded, and who ended the call.
 */

/** One call to review. */
export type ReviewCall = {
  /** How the report names the call: its id where it comes from. */
  id: string;
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
  return { id: `conversation ${String(conversation.id)}`, turns: turnsOf(lines), endedBy: ended ? "agent" : null, recordsTools: true };
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

/** One line of a Calls export. It holds what was said, and no tool calls. */
function exportedCall(call: Record<string, unknown>): ReviewCall {
  const spoken = isRecord(call.transcript) && Array.isArray(call.transcript.turns) ? call.transcript.turns.filter(isRecord) : [];
  const lines = spoken.flatMap((turn): Line[] => {
    const by = speaker(turn.speaker);
    return by && typeof turn.text === "string" ? [{ by, text: turn.text }] : [];
  });
  const endedBy = typeof call.endReason === "string" && Object.hasOwn(ENDED_BY, call.endReason) ? ENDED_BY[call.endReason]! : null;
  return { id: String(call.callId), turns: turnsOf(lines), endedBy, recordsTools: false };
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
  return { id, turns: turnsOf(lines), endedBy: null, recordsTools: false };
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
