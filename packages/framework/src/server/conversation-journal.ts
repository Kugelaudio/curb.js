import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "../authoring.js";
import type { AgentAssistantMessage, AgentToolCallRecord, AgentUserMessage } from "../llm/types.js";
import type { ToolResult } from "../types.js";
import { logWarn } from "./log.js";

/**
 * The file behind `ConversationStore`: one JSON record per line, appended, never rewritten.
 *
 * Replaying the lines in order rebuilds the store, and a later record wins over an earlier
 * one for the same thing (a message at the same (conversation, seq), a newer system prompt
 * or state). Plain `node:fs` and no native module, so the store runs wherever Node's file
 * API does.
 */

/** A transcript message as the journal keeps it: the fields `restoreMessages` gives back. */
export type StoredMessage =
  | { role: "user"; content: string; at?: number; kind?: NonNullable<AgentUserMessage["kind"]> }
  | {
      role: "assistant";
      content: string;
      at?: number;
      toolCalls?: AgentToolCallRecord[];
      interruption?: NonNullable<AgentAssistantMessage["interruption"]>;
    }
  | {
      role: "tool";
      content: string;
      at?: number;
      toolCallId?: string;
      toolName?: string;
      result?: ToolResult;
      contextDiff?: string[];
    };

/** One line of the journal. */
export type JournalRecord =
  | { t: "conversation"; id: number; agentId: string; startedAt: string }
  | { t: "message"; conversation: number; seq: number; writtenAt: string; message: StoredMessage }
  | { t: "system_prompt"; conversation: number; systemPrompt: string }
  | { t: "state"; conversation: number; state: unknown };

/** A journal line that is not a record, anywhere but at the end of the file. */
export class ConversationJournalError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    cause: string,
  ) {
    super(
      `Conversation store ${path}:${line} is not a conversation record: ${cause}.\n` +
        "Records follow it, so this is not a write cut off by a crash. Fix or delete that line, " +
        "or move the file away to start a new history.",
    );
    this.name = "ConversationJournalError";
  }
}

/** The first 16 bytes of every SQLite database file. */
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

/** What the journal hands each record to, in file order. */
export type JournalHandlers = {
  /** Take one record into the index; throw to refuse it. */
  apply(record: JournalRecord): void;
  /** Forget everything: the file is about to be read again from its first line. */
  reset(): void;
};

export class ConversationJournal {
  /** Bytes of the file taken into the index so far. */
  private offset = 0;
  /** Lines of the file taken into the index so far. */
  private lines = 0;
  /** The file's identity when it was last read; another one at the path is read afresh. */
  private ino: number | null = null;
  /** The last line taken in has no newline yet; the next append writes one first. */
  private needsNewline = false;

  constructor(
    readonly path: string,
    private readonly handlers: JournalHandlers,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.catchUp();
  }

  /**
   * Take in whatever was appended since the file was last read.
   *
   * Another process can write the same file (`curb say` while `curb dev` runs), so every
   * read and write of the store starts here. A file that shrank, was replaced or was deleted
   * is read again from the start.
   */
  catchUp(): void {
    const stat = statSync(this.path, { throwIfNoEntry: false });
    if (!stat) {
      if (this.offset > 0) this.restart("it was deleted");
      this.ino = null;
      return;
    }
    if (this.ino !== null && (stat.ino !== this.ino || stat.size < this.offset)) {
      this.restart(stat.ino !== this.ino ? "another file replaced it" : "it shrank");
    }
    this.ino = stat.ino;
    if (stat.size > this.offset) this.ingest(readRange(this.path, this.offset, stat.size));
  }

  /**
   * Append `record` (already serialized as `line`, without its newline) and hand it to the
   * index. When another process appended in between, the file is read again from the start
   * instead, which takes this record in at its place among theirs.
   */
  write(line: string, record: JournalRecord): void {
    const text = `${this.needsNewline ? "\n" : ""}${line}\n`;
    const expected = this.offset + Buffer.byteLength(text);
    appendFileSync(this.path, text);
    const stat = statSync(this.path);
    if (stat.size === expected && (this.ino === null || stat.ino === this.ino)) {
      this.offset = expected;
      this.lines += 1;
      this.needsNewline = false;
      this.ino = stat.ino;
      this.handlers.apply(record);
      return;
    }
    this.restart("another process wrote to it at the same time");
    this.catchUp();
  }

  private restart(reason: string): void {
    logWarn("curb", `conversation store ${this.path}: ${reason}; reading it again from the start`);
    this.handlers.reset();
    this.offset = 0;
    this.lines = 0;
    this.ino = null;
    this.needsNewline = false;
  }

  /** Take in `chunk`, the file's bytes from `this.offset` on. */
  private ingest(chunk: Buffer): void {
    if (this.offset === 0 && chunk.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
      throw new AgentAuthoringError({
        code: AUTHORING_DIAGNOSTIC_CODES.conversationStoreSqlite,
        severity: "error",
        message:
          `${this.path} is an SQLite database from an older curb. Conversations are now recorded as ` +
          "JSON lines, and that file is not read.",
        location: {},
        fix: "Point KUGEL_CONVERSATIONS_DB at a new file (the default is .data/conversations.jsonl), or unset it.",
      });
    }
    const segments = splitLines(chunk);
    const last = segments.findLastIndex((segment) => segment.text.trim() !== "");
    for (const [index, segment] of segments.entries()) {
      const line = this.lines + 1;
      if (segment.text.trim() !== "") {
        try {
          this.handlers.apply(parseRecord(segment.text));
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error);
          if (index !== last) throw new ConversationJournalError(this.path, line, cause);
          this.dropTail(line, cause, chunk.length - segment.start);
          return;
        }
      }
      this.lines = line;
      this.offset += segment.byteLength;
      this.needsNewline = !segment.terminated;
    }
  }

  /**
   * The last line is not a record: what a crash in the middle of an append leaves behind.
   * Cut it off, so the next append starts a line of its own instead of extending the broken
   * one into a corrupt line in the middle of the file.
   */
  private dropTail(line: number, cause: string, bytes: number): void {
    truncateSync(this.path, this.offset);
    this.needsNewline = false;
    logWarn(
      "curb",
      `conversation store ${this.path}:${line}: dropped the last line (${bytes} bytes), which is not a ` +
        `record (${cause}). A write cut off by a crash leaves this; the records before it are intact.`,
    );
  }
}

type Segment = { text: string; start: number; byteLength: number; terminated: boolean };

/** `chunk` cut at each newline; the last segment is unterminated when it does not end in one. */
function splitLines(chunk: Buffer): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start);
    const end = newline === -1 ? chunk.length : newline;
    segments.push({
      text: chunk.toString("utf8", start, end),
      start,
      byteLength: end - start + (newline === -1 ? 0 : 1),
      terminated: newline !== -1,
    });
    start = end + 1;
  }
  return segments;
}

function readRange(path: string, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(to - from);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, from + read);
      if (count === 0) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// --- the record shapes ---------------------------------------------------------------

/** One journal line as a record; throws naming what is wrong with it. */
export function parseRecord(text: string): JournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const record = object(value, "the line");
  switch (record.t) {
    case "conversation":
      integer(record, "id", 1);
      string(record, "agentId");
      string(record, "startedAt");
      return record as JournalRecord;
    case "message":
      integer(record, "conversation", 1);
      integer(record, "seq", 0);
      string(record, "writtenAt");
      storedMessage(record.message);
      return record as JournalRecord;
    case "system_prompt":
      integer(record, "conversation", 1);
      string(record, "systemPrompt");
      return record as JournalRecord;
    case "state":
      integer(record, "conversation", 1);
      if (!("state" in record)) throw new Error('"state" is missing');
      return record as JournalRecord;
    default:
      throw new Error(`unknown record type ${JSON.stringify(record.t)}`);
  }
}

function storedMessage(value: unknown): void {
  const message = object(value, '"message"');
  string(message, "content");
  if (message.at !== undefined && (typeof message.at !== "number" || !Number.isFinite(message.at))) {
    throw new Error('"message.at" is not a number');
  }
  if (message.role === "user") {
    if (message.kind !== undefined && message.kind !== "context_event" && message.kind !== "synthetic") {
      throw new Error(`"message.kind" ${JSON.stringify(message.kind)} is not a user message kind`);
    }
    return;
  }
  if (message.role === "assistant") {
    if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) throw new Error('"message.toolCalls" is not a list');
    if (message.interruption !== undefined) object(message.interruption, '"message.interruption"');
    return;
  }
  if (message.role === "tool") {
    for (const key of ["toolCallId", "toolName"]) {
      if (message[key] !== undefined && typeof message[key] !== "string") throw new Error(`"message.${key}" is not a string`);
    }
    if (message.result !== undefined) object(message.result, '"message.result"');
    const diff = message.contextDiff;
    if (diff !== undefined && !(Array.isArray(diff) && diff.every((line) => typeof line === "string"))) {
      throw new Error('"message.contextDiff" is not a list of strings');
    }
    return;
  }
  throw new Error(`"message.role" ${JSON.stringify(message.role)} is not user, assistant or tool`);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

function string(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== "string") throw new Error(`"${key}" is not a string`);
}

function integer(record: Record<string, unknown>, key: string, min: number): void {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`"${key}" is not a whole number of ${min} or more`);
  }
}
