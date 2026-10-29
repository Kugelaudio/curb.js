import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSession } from "../agent-session.js";
import { MANAGEMENT_ADDRESS_ENV } from "../hosted/management-server.js";
import type { AgentChatMessage } from "../llm/types.js";
import { resolveProjectRoot } from "../project.node.js";
import type { ConversationState } from "./conversation-restore.js";
import { ConversationJournal, parseRecord, type JournalRecord, type StoredMessage } from "./conversation-journal.js";
import { logError, logInfo } from "./log.js";

/**
 * Durable sink for hosted conversation transcripts.
 *
 * The framework decides WHAT a transcript is; the host decides WHERE it lives.
 * Two required methods, because the append path and the barge-in rewrite path are
 * the same operation on (conversationId, seq), and one optional method for the
 * system prompt the conversation ran with.
 *
 * The default implementation is the JSON-lines `ConversationStore` below, which is
 * what a scaffolded project gets and what `KUGEL_CONVERSATIONS_DB=off` turns
 * off. A host that needs something else registers it (see
 * `loadConfiguredConversationSink`). The framework never gains a database
 * driver of its own for that: it imports the module the host named.
 *
 * WHAT THE FRAMEWORK DOES WHEN A CALL REJECTS. The transcript is a record; the call is
 * the product. So a rejection never reaches the session: the turn, and a live voice
 * call, carry on. The write is not dropped either. It is logged at error level, counted
 * (`getConversationSinkStatus().failedWrites`), and kept pending, then retried on the
 * next transcript change and once more when the session ends. Whatever the sink still
 * refuses at session end is logged at error level with the conversation id and the
 * number of messages lost, and counted in `lostMessages`.
 *
 * Ordering: calls for one session are serialized, never concurrent. Within a
 * conversation, messages are written in `seq` order, and a conversation's writes all
 * come before those of the conversation a reset started after it. A write that keeps
 * failing therefore holds back the writes behind it rather than being skipped. The
 * framework puts no timeout on a call, so a sink should bound its own.
 *
 * What a sink must provide, given retries:
 * - `recordMessage` must be an upsert on (conversationId, seq). A retry repeats a write
 *   whose outcome the framework never learned, and a barge-in rewrites a seq that is
 *   already stored; both must replace the stored message, never add a second one.
 * - `startConversation` is retried only after it rejected, so a rejection must mean no
 *   conversation was created. A sink that can fail after creating one leaves an empty
 *   conversation behind on the retry.
 */
export interface ConversationSink {
  /**
   * Begin a conversation and return its stable id.
   *
   * `metadata` is OPAQUE to the framework: it is the host's own session info
   * (whatever arrived over `set_info`) and the framework never reads a key out
   * of it. That is deliberate. Naming a key here would put one host's schema
   * into a published package.
   */
  startConversation(agentId: string, metadata: Readonly<Record<string, unknown>>): Promise<string>;

  /**
   * Write message `seq` of `conversationId`. Idempotent on
   * (conversationId, seq): writing an existing seq REPLACES it, which is
   * exactly what a barge-in rewrite, and a retried write, need.
   */
  recordMessage(conversationId: string, seq: number, message: AgentChatMessage): Promise<void>;

  /**
   * Optional. Store the system prompt `conversationId` runs with: what its latest
   * model call carried, the framework's spoken-reply rules included on a voice turn.
   * Called after the conversation started and again whenever the prompt changes,
   * retried like a message write, and it REPLACES the prompt stored before. A sink
   * without it records the transcript only.
   */
  recordSystemPrompt?(conversationId: string, systemPrompt: string): Promise<void>;

  /**
   * Optional. Store what the conversation keeps besides its transcript (its open skills,
   * store data and page info, as plain JSON), which is what continuing it needs: the preview
   * puts it back after `curb dev` reloads the agent instead of running the tools again.
   * Called when it changes, retried like a message write, and it REPLACES the state stored
   * before. Opaque to the sink: store it as it comes.
   */
  recordState?(conversationId: string, state: ConversationState): Promise<void>;
}

/**
 * JSON-lines mirror of every hosted conversation, for debugging — the preview UI
 * shows only the chat text, so tool calls (which query ran, with which
 * filters, what came back) were invisible without tailing the bridge log.
 *
 * One append-only file (`.data/conversations.jsonl` by default), one record per line
 * (`conversation-journal.ts`): a conversation starting, a message at (conversation, seq),
 * the system prompt, the state. Opening the store replays the file into memory, and
 * every write appends one line before it lands in memory; a later record for the same
 * thing wins. Assistant messages carry their native tool calls, tool messages the full
 * result and the context diff it caused. Attached centrally in
 * `bootstrap.createAgentSession`, so every host records without extra wiring.
 *
 * `:memory:` keeps everything in memory and writes no file.
 *
 * Inspect with `curb conversations` (cli/conversations.ts), or read the file: every
 * line is one JSON object.
 */
export class ConversationStore implements ConversationSink {
  private readonly conversations = new Map<number, StoredConversation>();
  private nextId = 1;
  private readonly journal: ConversationJournal | null;
  private closed = false;

  constructor(path: string) {
    const handlers = { apply: (record: JournalRecord) => this.apply(record), reset: () => this.reset() };
    this.journal = path === ":memory:" ? null : new ConversationJournal(path, handlers);
  }

  /**
   * `ConversationSink.startConversation`. `metadata` is accepted and ignored:
   * this mirror keeps no host session info, and inventing a field for it here
   * would make the framework's default store the place a product's keys land.
   */
  async startConversation(
    agentId: string,
    _metadata: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    this.read();
    const id = this.nextId;
    this.commit({ t: "conversation", id, agentId, startedAt: new Date().toISOString() });
    return String(id);
  }

  /** `ConversationSink.recordMessage`, on the integer ids this store hands out. */
  async recordMessage(
    conversationId: string,
    seq: number,
    message: AgentChatMessage,
  ): Promise<void> {
    this.insertMessage(integerId(conversationId), seq, message);
  }

  /** `ConversationSink.recordSystemPrompt`: replaces the prompt stored for the conversation. */
  async recordSystemPrompt(conversationId: string, systemPrompt: string): Promise<void> {
    const id = integerId(conversationId);
    this.read();
    this.conversation(id, "record a system prompt for");
    this.commit({ t: "system_prompt", conversation: id, systemPrompt });
  }

  /** `ConversationSink.recordState`: replaces the state stored for the conversation. */
  async recordState(conversationId: string, state: ConversationState): Promise<void> {
    const id = integerId(conversationId);
    this.read();
    this.conversation(id, "record a state for");
    this.commit({ t: "state", conversation: id, state });
  }

  /**
   * Write one message at (conversation, seq), REPLACING whatever is there.
   *
   * It used to be insert-or-ignore, and that was the bug: a barge-in rewrites a
   * message already stored (the reconciled content and its spoken/unspoken split),
   * and the ignore dropped both, so every interrupted reply persisted as if it had
   * been spoken in full. Replace-on-conflict makes the append path and the rewrite
   * path one operation, which is why the host's record loop needs no second pass and
   * why the sink contract is two methods rather than three. `created_at` keeps its
   * first-write value; it is not an ordering key.
   */
  insertMessage(conversationId: number, seq: number, message: AgentChatMessage): void {
    this.read();
    this.conversation(conversationId, "record a message for");
    this.commit({
      t: "message",
      conversation: conversationId,
      seq,
      writtenAt: new Date().toISOString(),
      message: storedMessage(message),
    });
  }

  /** Most recent conversations, newest first; only those with a message. */
  listConversations(limit: number): Array<{ id: number; agent_id: string; started_at: string; message_count: number }> {
    this.read();
    return [...this.conversations.values()]
      .filter((conversation) => conversation.messages.size > 0)
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.max(0, limit))
      .map((conversation) => ({
        id: conversation.id,
        agent_id: conversation.agentId,
        started_at: conversation.startedAt,
        message_count: conversation.messages.size,
      }));
  }

  listMessages(conversationId: number): Array<{
    seq: number;
    role: string;
    content: string;
    tool_calls: string | null;
    tool_name: string | null;
    tool_result: string | null;
    created_at: string;
  }> {
    return this.messagesOf(conversationId).map(({ seq, message, createdAt }) => ({
      seq,
      role: message.role,
      content: message.content,
      tool_calls: message.role === "assistant" && message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      tool_name: message.role === "tool" ? (message.toolName ?? null) : null,
      tool_result: message.role === "tool" && message.result !== undefined ? JSON.stringify(message.result) : null,
      created_at: createdAt,
    }));
  }

  /**
   * Rebuild one conversation's transcript as the framework's own messages.
   *
   * The exact inverse of insertMessage (through `storedMessage`), and it lives beside it
   * for that reason: a reader that drifted from the writer would return a transcript that
   * looks right and fails on the next turn.
   *
   * A tool message stored without its `toolCallId` gets one synthesised from the
   * conversation and sequence. It is stable and unique, which is all the pairing needs:
   * the provider pairs tool_use with tool_result on exactly that id, and a rebuilt
   * transcript missing it is refused by the next turn rather than by the restore, which
   * is a long way from the cause.
   *
   * A user message stored without `kind` restores as speech, and one without `at`
   * without a time: neither was recorded, so neither can be recovered.
   */
  restoreMessages(conversationId: number): AgentChatMessage[] {
    return this.messagesOf(conversationId).map(({ seq, message: stored }): AgentChatMessage => {
      const message = structuredClone(stored);
      if (message.role !== "tool") return message;
      return {
        ...message,
        toolCallId: message.toolCallId ?? `restored-${conversationId}-${seq}`,
        toolName: message.toolName ?? "",
        result: message.result ?? { ok: true },
        contextDiff: message.contextDiff ?? [],
      };
    });
  }

  /**
   * The system prompt the conversation ran with, as `recordSystemPrompt` stored it.
   * Null when none was recorded: a conversation that never reached the model, or an
   * unknown id. Lives beside `restoreMessages` for the same reason.
   */
  restoreSystemPrompt(conversationId: number): string | null {
    this.read();
    return this.conversations.get(conversationId)?.systemPrompt ?? null;
  }

  /**
   * The state the conversation kept besides its transcript, as `recordState` stored it. Null
   * when none was recorded (a host that keeps none, or an unknown id), and for a value this
   * version cannot read: such a conversation still restores, its state starting over, rather
   * than not at all.
   */
  restoreState(conversationId: number): ConversationState | null {
    this.read();
    const state = this.conversations.get(conversationId)?.state;
    if (state === undefined) return null;
    const copy: unknown = structuredClone(state);
    return isConversationState(copy) ? copy : null;
  }

  close(): void {
    this.closed = true;
  }

  /** Before every read and write: refuse a closed store, and take in what another process appended. */
  private read(): void {
    if (this.closed) throw new Error("ConversationStore is closed.");
    this.journal?.catchUp();
  }

  private conversation(id: number, purpose: string): StoredConversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error(`ConversationStore has no conversation ${id} to ${purpose}.`);
    return conversation;
  }

  private messagesOf(conversationId: number): Array<{ seq: number; message: StoredMessage; createdAt: string }> {
    this.read();
    const messages = this.conversations.get(conversationId)?.messages;
    if (!messages) return [];
    return [...messages.entries()].sort(([a], [b]) => a - b).map(([seq, entry]) => ({ seq, ...entry }));
  }

  /**
   * Write `record` and take it in. It goes through the same parser the replay uses, so a
   * record the next open would refuse is refused here, at the write that made it, and the
   * index holds exactly what the file says rather than the caller's live objects.
   */
  private commit(record: JournalRecord): void {
    const line = JSON.stringify(record);
    const parsed = parseRecord(line);
    if (this.journal) this.journal.write(line, parsed);
    else this.apply(parsed);
  }

  /** Take one record into the index: on replay, and after each write. */
  private apply(record: JournalRecord): void {
    if (record.t === "conversation") {
      if (this.conversations.has(record.id)) throw new Error(`conversation ${record.id} is started twice`);
      this.conversations.set(record.id, {
        id: record.id,
        agentId: record.agentId,
        startedAt: record.startedAt,
        systemPrompt: null,
        messages: new Map(),
      });
      this.nextId = Math.max(this.nextId, record.id + 1);
      return;
    }
    const conversation = this.conversations.get(record.conversation);
    if (!conversation) throw new Error(`it names conversation ${record.conversation}, which no earlier line starts`);
    if (record.t === "message") {
      const createdAt = conversation.messages.get(record.seq)?.createdAt ?? record.writtenAt;
      conversation.messages.set(record.seq, { message: record.message, createdAt });
    } else if (record.t === "system_prompt") {
      conversation.systemPrompt = record.systemPrompt;
    } else {
      conversation.state = record.state;
    }
  }

  private reset(): void {
    this.conversations.clear();
    this.nextId = 1;
  }
}

/** One conversation as the store keeps it in memory. */
type StoredConversation = {
  id: number;
  agentId: string;
  startedAt: string;
  systemPrompt: string | null;
  /** As `recordState` stored it; undefined until then. */
  state?: unknown;
  /** By seq. `createdAt` is when the seq was first written. */
  messages: Map<number, { message: StoredMessage; createdAt: string }>;
};

/** The fields of `message` the store keeps, which are exactly what `restoreMessages` gives back. */
function storedMessage(message: AgentChatMessage): StoredMessage {
  const at = message.at === undefined || message.at === null ? {} : { at: message.at };
  if (message.role === "user") {
    return { role: "user", content: message.content, ...at, ...(message.kind ? { kind: message.kind } : {}) };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...at,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.interruption ? { interruption: message.interruption } : {}),
    };
  }
  return {
    role: "tool",
    content: message.content,
    ...at,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    result: message.result,
    contextDiff: message.contextDiff,
  };
}

/** Whether a stored value has the shape `restoreConversation` needs. */
function isConversationState(value: unknown): value is ConversationState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<ConversationState>;
  return (
    Array.isArray(state.loadedSkills) &&
    state.loadedSkills.every((path) => typeof path === "string") &&
    typeof state.stores === "object" &&
    state.stores !== null &&
    (state.client === undefined || (typeof state.client === "object" && state.client !== null))
  );
}

/** The integer ids `ConversationStore` hands out, read back from a sink's string id. */
function integerId(conversationId: string): number {
  const id = Number(conversationId);
  if (!Number.isInteger(id)) {
    throw new Error(
      `ConversationStore conversation ids are integers; got ${JSON.stringify(conversationId)}.`,
    );
  }
  return id;
}

export const DEFAULT_CONVERSATIONS_DB_PATH = ".data/conversations.jsonl";

/** The file the store wrote before it was JSON lines, by its default name. */
const LEGACY_HISTORY_FILE = "conversations.db";

/**
 * One line saying that a history file of an older curb sits beside the store at
 * `storePath` and is not read, or null when there is none. There is no migration: the
 * old file is left as it is.
 */
export function legacyHistoryNotice(storePath: string): string | null {
  if (storePath === ":memory:") return null;
  const store = resolve(storePath);
  const legacy = join(dirname(store), LEGACY_HISTORY_FILE);
  if (legacy === store || !existsSync(legacy)) return null;
  return `${legacy} is the SQLite conversation history of an older curb and is no longer read; conversations are recorded to ${store}.`;
}

let defaultStore: ConversationStore | null | undefined;

/**
 * Process-wide store used by the hosts. Path from KUGEL_CONVERSATIONS_DB
 * (default `.data/conversations.jsonl`, relative to the working directory);
 * set it to `off` to disable. Disabled automatically under vitest so unit
 * tests never write a shared file, and in managed hosting because the platform
 * is already the durable conversation store. A broken path or a file that is not
 * a conversation journal throws at first use — the host must fail loudly rather
 * than silently not record.
 */
export function getDefaultConversationStore(): ConversationStore | null {
  if (defaultStore !== undefined) return defaultStore;
  const path = defaultStorePath();
  defaultStore = path === null ? null : new ConversationStore(path);
  const notice = path === null ? null : legacyHistoryNotice(path);
  if (notice) logInfo("curb", notice);
  return defaultStore;
}

/** The default store's path, or null when it is off. Reads the environment, opens nothing. */
function defaultStorePath(): string | null {
  const configured = process.env.KUGEL_CONVERSATIONS_DB;
  if (configured === "off" || configured === "0" || process.env.VITEST || isManagedRunner()) {
    return null;
  }
  return configured ?? DEFAULT_CONVERSATIONS_DB_PATH;
}

/** A managed runner: the platform is already the durable conversation store. */
function isManagedRunner(): boolean {
  return Boolean(process.env[MANAGEMENT_ADDRESS_ENV]?.trim());
}

// --- the registered sink -------------------------------------------------------------

/**
 * Environment variable naming the module that provides the conversation sink.
 *
 * A MODULE PATH, NOT A DRIVER NAME. The framework imports what the host names and
 * calls `setConversationSink` with its default export; the storage code, and every
 * dependency it needs, stays in the host's own package. That is what keeps a database
 * driver out of this published package — a provider registry here would put one in.
 *
 * Relative paths resolve against the project root (AGENT_PROJECT_DIR, else the working
 * directory), so `KUGEL_CONVERSATION_SINK=./lib/conversation-sink.ts` works from a
 * project the same way `src/agent/` discovery does.
 */
export const CONVERSATION_SINK_MODULE_ENV = "KUGEL_CONVERSATION_SINK";

let registeredSink: ConversationSink | null = null;
/** Where `registeredSink` came from, for the boot line. */
let registeredSinkSource: string | null = null;
let sinkLoad: Promise<void> | null = null;

/**
 * Register the durable sink for this process, replacing whatever was registered.
 *
 * `null` clears the registration, which restores the file store default and re-arms the
 * configured-module load. An explicit call WINS over `CONVERSATION_SINK_MODULE_ENV`:
 * a host that registers its own sink in code has already made the decision the env
 * var exists to make.
 */
export function setConversationSink(sink: ConversationSink | null): void {
  registeredSink = sink;
  registeredSinkSource = sink ? "registered in code (setConversationSink)" : null;
  sinkLoad = sink ? Promise.resolve() : null;
}

/**
 * The sink in force right now: the registered one, else the file store default, else
 * nothing. `null` means "do not record" — `KUGEL_CONVERSATIONS_DB=off` and the test
 * runner both land here, and both are the pre-existing behaviour.
 */
export function getConversationSink(): ConversationSink | null {
  return registeredSink ?? getDefaultConversationStore();
}

/**
 * Import and register the configured sink module, once per process.
 *
 * Called at server startup so a misconfigured path fails at boot rather than
 * mid-conversation, and awaited again per session so hosts that never go through
 * `createAgentServer` (the voice host, tests) still get the configured sink. The
 * second call is free.
 */
export function loadConfiguredConversationSink(): Promise<void> {
  sinkLoad ??= importConfiguredSink();
  return sinkLoad;
}

/**
 * The conversation store in force, in one line: the sink module, the JSONL file, or off.
 *
 * Printed at server boot. Which store transcripts go to is a deployment fact, and a
 * dropped or misspelled `KUGEL_CONVERSATION_SINK` does not fail: it records to the file
 * default instead. The boot line is where that becomes visible.
 */
export function describeConversationStore(): string {
  if (registeredSink) return `sink ${registeredSinkSource}`;
  const path = defaultStorePath();
  if (path !== null) return `JSONL ${path === ":memory:" ? path : resolve(path)}`;
  const configured = process.env.KUGEL_CONVERSATIONS_DB;
  if (configured === "off" || configured === "0") return `off (KUGEL_CONVERSATIONS_DB=${configured})`;
  return isManagedRunner() ? `off (managed runner, ${MANAGEMENT_ADDRESS_ENV})` : "off (test runner)";
}

/** The sink to record into, after the configured module has had its chance to load. */
export async function resolveConversationSink(): Promise<ConversationSink | null> {
  await loadConfiguredConversationSink();
  return getConversationSink();
}

async function importConfiguredSink(): Promise<void> {
  const configured = process.env[CONVERSATION_SINK_MODULE_ENV]?.trim();
  if (!configured) return;

  const isPath = isAbsolute(configured) || configured.startsWith(".");
  const specifier = isPath ? pathToFileURL(resolve(resolveProjectRoot(), configured)).href : configured;

  let module: unknown;
  try {
    module = await import(specifier);
  } catch (cause) {
    throw new Error(
      `${CONVERSATION_SINK_MODULE_ENV}=${configured} could not be imported (resolved to ${specifier}).\n` +
        "Fix: point it at a module inside this project that default-exports a ConversationSink,\n" +
        "or unset it to use the built-in file store.",
      { cause },
    );
  }

  const candidate = (module as { default?: unknown }).default;
  if (!isConversationSink(candidate)) {
    throw new Error(
      `${CONVERSATION_SINK_MODULE_ENV}=${configured} does not default-export a ConversationSink.\n` +
        "Fix: `export default` an object with async startConversation(agentId, metadata)\n" +
        "and recordMessage(conversationId, seq, message) methods.",
    );
  }
  registeredSink = candidate;
  registeredSinkSource = `${isPath ? resolve(resolveProjectRoot(), configured) : configured} (${CONVERSATION_SINK_MODULE_ENV})`;
}

function isConversationSink(value: unknown): value is ConversationSink {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ConversationSink>;
  return typeof candidate.startConversation === "function" && typeof candidate.recordMessage === "function";
}

/**
 * Process-wide health of conversation recording, counted since the process started.
 *
 * The same facts are in the server log line by line; this is the one place that
 * answers "are transcripts reaching the store" without reading it.
 */
export type ConversationSinkStatus = {
  /** The store in force, as `describeConversationStore` names it. */
  store: string;
  /** Sink calls that rejected. Each one was also logged at error level. */
  failedWrites: number;
  /** Messages handed to the sink that it has not accepted yet, across live sessions. */
  pendingMessages: number;
  /** Messages still refused when their session ended. Their transcripts are incomplete. */
  lostMessages: number;
};

const sinkTotals = { failedWrites: 0, pendingMessages: 0, lostMessages: 0 };

export function getConversationSinkStatus(): ConversationSinkStatus {
  return { store: describeConversationStore(), ...sinkTotals };
}

/**
 * Mirror every transcript message of `session` into `sink`. A shrinking transcript
 * (session.reset()) starts a new conversation.
 *
 * A FREE FUNCTION RATHER THAN A STORE METHOD. Everything here is host bookkeeping —
 * has the transcript shrunk, how many messages have I written, has a reply been
 * rewritten since — and none of it is storage. Keeping it out of the sink is what
 * lets the contract be two methods that any host can implement.
 *
 * `readMetadata` is evaluated when a conversation actually STARTS, which is at the
 * first message and not at attach: a host sets its session info over `set_info` after
 * the session exists, so metadata read at attach time would always be empty.
 *
 * Every message is handed to a pending set the moment the session shows it, and leaves
 * that set only when the sink has accepted it. Writes drain through one promise chain,
 * so they reach the sink in transcript order even though the session notifies
 * synchronously. What a rejection does is documented on `ConversationSink`.
 */
export interface ConversationRecorder {
  /**
   * Stop mirroring this session and finish its recording: one last attempt at every
   * write still pending, then whatever the sink still refuses is reported lost. Never
   * rejects, and a second call returns the first call's promise.
   */
  detach(): Promise<void>;
  /**
   * Resolves once every write queued so far, pending retries included, has been
   * attempted. Never rejects; a failed attempt is logged and counted instead.
   *
   * Exists because the session notifies synchronously and the sink is async: without
   * it the only way to assert what was recorded is to sleep and hope, which is how a
   * suite starts passing for the wrong reason.
   */
  flush(): Promise<void>;
  /** The sink's id of the conversation the session is on, once `startConversation`
   * resolved for it; null before. */
  conversationId(): string | null;
  /**
   * Record into the sink's existing conversation `id` instead of starting a new one. For a
   * session that continues a stored conversation: `curb dev` reopens it after reloading the
   * agent, and a copy per reload would fill the history with the same conversation. Only
   * before the session has recorded anything. The restored transcript is written again at
   * its own seqs, which `recordMessage` replaces in place.
   */
  continueConversation(id: string): void;
  /**
   * Record the conversation's state too (`ConversationSink.recordState`), as `read` returns
   * it: read on every change of the transcript and once more when the recording ends, and
   * handed to the sink when it changed. A host that can continue the conversation registers
   * it; without it only the transcript is recorded.
   */
  keepState(read: () => ConversationState): void;
}

/** One conversation's writes that the sink has not accepted yet. */
type ConversationWrites = {
  /** The sink's id, once `startConversation` has resolved. */
  id: string | null;
  /** Unwritten messages by seq. A rewrite of a seq still pending replaces the entry. */
  pending: Map<number, AgentChatMessage>;
  /** A system prompt `recordSystemPrompt` has not accepted yet. A newer one replaces it. */
  systemPrompt?: string;
  /** A state (as JSON) `recordState` has not accepted yet. A newer one replaces it. */
  state?: string;
};

/** Whether a conversation still owes the sink a write. */
function owesWrites(conversation: ConversationWrites): boolean {
  return conversation.pending.size > 0 || conversation.systemPrompt !== undefined || conversation.state !== undefined;
}

/** The recorder attached to each session, so a host can finish it at session end. */
const recorders = new WeakMap<AgentSession, ConversationRecorder>();

/**
 * Finish the conversation recording of `session`, if it has one: see
 * `ConversationRecorder.detach`. Hosts call this when the session ends. Never rejects.
 */
export function detachConversationRecorder(session: AgentSession): Promise<void> {
  return recorders.get(session)?.detach() ?? Promise.resolve();
}

/** The sink's id of the conversation `session` is recorded under: see
 * `ConversationRecorder.conversationId`. Null when it has no recorder. */
export function recordedConversationId(session: AgentSession): string | null {
  return recorders.get(session)?.conversationId() ?? null;
}

/**
 * Make `session` continue the stored conversation `id` (see
 * `ConversationRecorder.continueConversation`). A session without a recorder records
 * nothing, so there is nothing to continue.
 */
export function continueRecordedConversation(session: AgentSession, id: string): void {
  recorders.get(session)?.continueConversation(id);
}

/** Record `session`'s state with its transcript (see `ConversationRecorder.keepState`). A
 * session without a recorder records nothing. */
export function keepConversationState(session: AgentSession, read: () => ConversationState): void {
  recorders.get(session)?.keepState(read);
}

export function attachConversationSink(
  sink: ConversationSink,
  session: AgentSession,
  agentId: string,
  readMetadata: () => Readonly<Record<string, unknown>> = () => ({}),
): ConversationRecorder {
  // Oldest first. The last entry is the conversation the session is on; an earlier one
  // stays only while a reset left it owing the sink writes.
  let conversations: ConversationWrites[] = [];
  let current: ConversationWrites | null = null;
  /** The message handed to `pending` at each seq of the current transcript. */
  let handedOver: AgentChatMessage[] = [];
  /** The system prompt last handed over for the current conversation. */
  let promptHandedOver: string | undefined;
  /** Reads the conversation's state (`keepState`); null records the transcript only. */
  let readState: (() => ConversationState) | null = null;
  /** The state last handed over for the current conversation, as JSON. */
  let stateHandedOver: string | undefined;
  let queue: Promise<void> = Promise.resolve();
  /** Rejections since the sink last accepted everything, and the latest cause. */
  let failedAttempts = 0;
  let lastError = "";
  /** This recorder's share of `sinkTotals.pendingMessages`. */
  let countedPending = 0;
  let detached: Promise<void> | null = null;

  /** The state as JSON, or null when it could not be read: logged, and the transcript is still
   * recorded. This runs off the session's own notify, so a throw would fail the turn. */
  const readStateJson = (read: () => ConversationState): string | null => {
    try {
      return JSON.stringify(read());
    } catch (error) {
      logError(
        "ws",
        `conversation state not recorded (agent ${agentId}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  const pendingCount = () =>
    conversations.reduce((total, conversation) => total + conversation.pending.size, 0);
  const syncPendingTotal = () => {
    const pending = pendingCount();
    sinkTotals.pendingMessages += pending - countedPending;
    countedPending = pending;
  };
  const label = (conversation: ConversationWrites | null) =>
    conversation?.id ? `conversation ${conversation.id}` : "a conversation the sink has not started";
  const messages = (count: number) => `${count} message${count === 1 ? "" : "s"}`;

  const handOver = (seq: number, message: AgentChatMessage) => {
    if (!current) {
      current = { id: null, pending: new Map() };
      conversations.push(current);
    }
    current.pending.set(seq, message);
  };

  const writePending = async (): Promise<void> => {
    if (!conversations.some(owesWrites)) return;
    let writing: ConversationWrites | null = null;
    try {
      for (const conversation of conversations) {
        if (!owesWrites(conversation)) continue;
        writing = conversation;
        conversation.id ??= await sink.startConversation(agentId, readMetadata());
        for (const seq of [...conversation.pending.keys()].sort((a, b) => a - b)) {
          const message = conversation.pending.get(seq)!;
          await sink.recordMessage(conversation.id, seq, message);
          // A rewrite of this seq can land while the write is in flight; it stays pending.
          if (conversation.pending.get(seq) === message) conversation.pending.delete(seq);
        }
        const prompt = conversation.systemPrompt;
        if (prompt !== undefined) {
          await sink.recordSystemPrompt?.(conversation.id, prompt);
          // Same for a newer prompt that landed while this one was being written.
          if (conversation.systemPrompt === prompt) conversation.systemPrompt = undefined;
        }
        const state = conversation.state;
        if (state !== undefined) {
          await sink.recordState?.(conversation.id, JSON.parse(state) as ConversationState);
          if (conversation.state === state) conversation.state = undefined;
        }
      }
      if (failedAttempts > 0) {
        logInfo("ws", `conversation sink recovered after ${failedAttempts} failed attempts (agent ${agentId})`);
        failedAttempts = 0;
      }
    } catch (error) {
      // KEEP-JUSTIFIED: the transcript is a record, the call is the product. This chain
      // runs off the session's synchronous notify and nothing awaits it, so rethrowing
      // would be an unhandled rejection that takes the process, and the live call, down.
      // The failure is not swallowed: it is logged at error level, counted in
      // `failedWrites`, and every unwritten message stays pending for the next attempt.
      failedAttempts += 1;
      sinkTotals.failedWrites += 1;
      lastError = error instanceof Error ? error.message : String(error);
      logError(
        "ws",
        `conversation sink write failed for ${label(writing)} (agent ${agentId}, attempt ${failedAttempts}): ` +
          `${lastError}. ${messages(pendingCount())} pending; retrying on the next transcript change ` +
          "and at session end. The session continues.",
      );
    } finally {
      conversations = conversations.filter(
        (conversation) => conversation === current || owesWrites(conversation),
      );
      syncPendingTotal();
    }
  };

  const drain = (): Promise<void> => {
    queue = queue.then(writePending);
    return queue;
  };

  const record = () => {
    // `session.messages` is replaced, never mutated in place, so this is a snapshot.
    const snapshot = session.messages;
    if (snapshot.length < handedOver.length) {
      // A new conversation. The previous one keeps whatever it still owes the sink.
      current = null;
      handedOver = [];
      promptHandedOver = undefined;
      stateHandedOver = undefined;
    }

    // A MESSAGE ALREADY RECORDED CAN BE REWRITTEN: a barge-in cuts a reply to what was
    // heard, a refused or held tool call is marked on its record after its step was
    // shown, audio is attached once a reply has played. The session replaces such a
    // message rather than mutating it, so a different object at a seq is a rewrite, and
    // `recordMessage` replaces. Appending only kept the first version: an interrupted
    // reply as if spoken in full, a held call without its mark, which reopening the
    // conversation then replayed into a run nobody said yes to.
    for (const [seq, message] of snapshot.entries()) {
      if (handedOver[seq] === message) continue;
      handedOver[seq] = message;
      handOver(seq, message);
    }

    // The prompt the conversation runs with is the one its latest model call carried:
    // read from the session's own trace, so it is the prompt as sent rather than as
    // the code reads now, and handed over only when it changed.
    const prompt = session.llmTrace.at(-1)?.input.system;
    if (sink.recordSystemPrompt && current && prompt !== undefined && prompt !== promptHandedOver) {
      promptHandedOver = prompt;
      current.systemPrompt = prompt;
    }

    // The state the conversation is in now (its open skills, store data, page info): what
    // continuing it needs, kept current with the transcript and handed over when it changed.
    if (sink.recordState && readState && current) {
      const state = readStateJson(readState);
      if (state !== null && state !== stateHandedOver) {
        stateHandedOver = state;
        current.state = state;
      }
    }
    syncPendingTotal();
    void drain(); // never rejects: writePending owns its failures
  };

  record();
  const unsubscribe = session.subscribe(record);
  const recorder: ConversationRecorder = {
    detach: () => {
      detached ??= (async () => {
        // The state can change without the transcript (page info that changed nothing the
        // model reads): taken once more, so the conversation continues from where it ended.
        record();
        unsubscribe();
        await drain();
        for (const conversation of conversations) {
          if (!owesWrites(conversation)) continue;
          const lost = conversation.pending.size;
          sinkTotals.lostMessages += lost;
          const what = [
            lost > 0 ? messages(lost) : "",
            conversation.systemPrompt !== undefined ? "the system prompt" : "",
            conversation.state !== undefined ? "the state" : "",
          ].filter(Boolean);
          logError(
            "ws",
            `conversation sink lost ${what.join(" and ")} of ${label(conversation)} (agent ${agentId}) ` +
              `at session end; last error: ${lastError}. That transcript is incomplete in the store.`,
          );
        }
        conversations = [];
        current = null;
        syncPendingTotal();
        if (recorders.get(session) === recorder) recorders.delete(session);
      })();
      return detached;
    },
    flush: drain,
    conversationId: () => current?.id ?? null,
    continueConversation: (id) => {
      if (handedOver.length > 0 || current !== null) {
        throw new Error(
          `curb: a recording continues stored conversation ${id} only before it has recorded anything ` +
            `(agent ${agentId}).`,
        );
      }
      current = { id, pending: new Map() };
      conversations.push(current);
    },
    keepState: (read) => {
      readState = read;
      record();
    },
  };
  recorders.set(session, recorder);
  return recorder;
}

/**
 * The default file store, but only while IT is the sink.
 *
 * The preview's history panel reads through this. A host that registered its own sink
 * owns its own reader, so returning the file store there would both list stale local
 * conversations and create the very `.data/conversations.jsonl` file the host moved away from.
 */
export function getConversationHistoryStore(): ConversationStore | null {
  if (registeredSink) return null;
  return getDefaultConversationStore();
}
