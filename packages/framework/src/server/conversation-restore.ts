import { restoreAgentStores, snapshotAgentStores, type SavedAgentStore } from "../agent-state.js";
import type { AgentSession } from "../agent-session.js";
import { experimentAssignmentsOf, experimentInfo } from "../experiments.js";
import { formatToolMessage } from "../llm/tool-messages.js";
import { heldAtEnd, type PendingConfirmation } from "../llm/confirmation.js";
import type { AgentChatMessage, AgentToolMessage } from "../llm/types.js";
import type { AgentSiteRuntime } from "../runtime.js";
import { CLIENT_INFO_PREFIX, clientInfo } from "./protocol.js";

/**
 * Continuing a conversation on a fresh runtime without running any of its tools again.
 *
 * A conversation is its transcript plus the state its turns left behind: the skills it has
 * open, its `createAgentStore` data, the page info and experiment variants it ran with, and an action still waiting
 * for the caller's yes. Every route that continues one saves that state after each turn and
 * puts it back with `restoreConversation`: `curb say` (its session file), the preview after
 * `curb dev` reloaded the agent, and the preview opening a past conversation (both from the
 * conversation store). Replaying the tool calls instead repeated their side effects, a
 * booking or an email, on every reload.
 */

/** What a conversation keeps besides its transcript. Plain JSON. */
export type ConversationState = {
  /** Loaded skill paths, least recently used first, active last. */
  loadedSkills: string[];
  /** `createAgentStore` data, by store key. */
  stores: Record<string, SavedAgentStore>;
  /** Store fields (`key.field`) holding something JSON cannot carry (a Date, a Map): not
   * saved, so they start from their initial values when the conversation continues. */
  unsavedStoreFields?: string[];
  /** Page info, by key without `client.`. */
  client?: Record<string, string>;
  /** The conversation's experiment variants (`experiment.*` session info), by experiment name: a
   * conversation keeps the variants it ran with. */
  experiments?: Record<string, string>;
  /** The action held for the caller's yes (`<Tool confirm>`): their next words answer it. */
  pendingConfirmation?: PendingConfirmation | null;
};

/** A conversation to continue. `state` is null for one recorded without it (before
 * conversations kept their state, or by a host that keeps none): it continues with its
 * transcript and the skills it read. */
export type SavedConversation = { messages: AgentChatMessage[]; state: ConversationState | null };

/** The result a tool call gets when its conversation was cut off while it ran. */
export const CUT_TOOL_CALL_MESSAGE =
  "Cut off before it returned: the agent restarted while this tool ran, so whether it took effect is unknown. " +
  "Check before running it again.";

/** The conversation `session` holds on `runtime`, as `restoreConversation` puts it back. */
export function conversationState(runtime: AgentSiteRuntime, session: AgentSession): ConversationState {
  const { stores, skipped } = snapshotAgentStores(runtime);
  const info = runtime.info.snapshot();
  const client = pageInfoOf(info);
  const experiments = experimentAssignmentsOf(info);
  return {
    loadedSkills: runtime.snapshot().context.loadedSkills.map((skill) => skill.path),
    stores,
    ...(skipped.length > 0 ? { unsavedStoreFields: skipped } : {}),
    ...(Object.keys(client).length > 0 ? { client } : {}),
    ...(Object.keys(experiments).length > 0 ? { experiments } : {}),
    pendingConfirmation: session.pendingConfirmation,
  };
}

/**
 * Put a saved conversation onto a fresh runtime and session: page info and store data first
 * (they decide what renders), then the loaded skills in their order, then the transcript. No
 * tool runs. Returns what could not be restored, one note each, for the person continuing it.
 *
 * `skillPaths`: every skill route the agent defines now. `info`: session info the
 * conversation is opened with (the page it is opened on), applied over the saved page info
 * before anything renders, so it is state the conversation had all along, not a change.
 */
/** The home skill's path before conversations started at the agent level (stored data only). */
const FORMER_HOME_SKILL = "/";

export function restoreConversation(
  bundle: { runtime: AgentSiteRuntime; session: AgentSession },
  saved: SavedConversation,
  options: { skillPaths: readonly string[]; info?: Readonly<Record<string, unknown>> },
): string[] {
  const { runtime, session } = bundle;
  const { messages, state } = saved;
  const notes: string[] = [];
  const info = { ...clientInfo(state?.client ?? {}), ...experimentInfo(state?.experiments), ...options.info };
  if (Object.keys(info).length > 0) runtime.updateInfo(info);
  if (state) {
    const unknownStores = restoreAgentStores(runtime, state.stores);
    if (unknownStores.length > 0) {
      notes.push(`No createAgentStore defines ${unknownStores.join(", ")} any more; that saved state was dropped.`);
    }
    if (state.unsavedStoreFields?.length) {
      notes.push(
        `Store fields kept only within the run that set them (not JSON data): ${state.unsavedStoreFields.join(", ")}. ` +
          "They start from their initial values.",
      );
    }
    runtime.refreshExternal();
  } else {
    notes.push(
      "This conversation was recorded without its state: its transcript and the skills it read are back, " +
        "and its store data starts over.",
    );
  }
  const known = new Set(options.skillPaths);
  // "/" was the home skill every conversation started in before the agent level; its content
  // is the agent's own now, so a conversation stored with it open loses nothing by its absence.
  const loaded = (state ? state.loadedSkills : skillsReadIn(messages)).filter((path) => path !== FORMER_HOME_SKILL);
  const missing = loaded.filter((path) => !known.has(path));
  if (missing.length > 0) notes.push(`Skill(s) ${missing.join(", ")} no longer exist and were not reloaded.`);
  for (const path of loaded) {
    if (known.has(path)) runtime.loadSkill(path);
  }
  const transcript = closeCutToolCalls(messages);
  // Without a saved state, a transcript that ends on a read-back still asks it (`heldAtEnd`).
  session.restoreTranscript(transcript, state ? (state.pendingConfirmation ?? null) : heldAtEnd(transcript));
  return notes;
}

/** Page info (`client.*` session info), by key without the prefix. */
export function pageInfoOf(info: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(info).flatMap(([key, value]) =>
      key.startsWith(CLIENT_INFO_PREFIX) && typeof value === "string" ? [[key.slice(CLIENT_INFO_PREFIX.length), value]] : [],
    ),
  );
}

/** The skills a transcript's `read_skill` calls opened, least recently read first: as much of
 * a stateless conversation's open skills as its transcript tells. */
function skillsReadIn(messages: readonly AgentChatMessage[]): string[] {
  const failed = new Set(
    messages.flatMap((message) => (message.role === "tool" && message.result.ok === false ? [message.toolCallId] : [])),
  );
  const read: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const skill = call.input.skill;
      if (call.name !== "read_skill" || call.invalid || failed.has(call.id) || typeof skill !== "string") continue;
      if (read.includes(skill)) read.splice(read.indexOf(skill), 1);
      read.push(skill);
    }
  }
  return read;
}

/**
 * A conversation cut off while a tool step ran (a reload that stopped waiting for the reply,
 * a crash) ends on tool calls without results, and every provider refuses the next request
 * of such a transcript. Each gets a failed result saying so.
 */
function closeCutToolCalls(messages: readonly AgentChatMessage[]): AgentChatMessage[] {
  const step = messages.findLastIndex((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
  const tail = messages.slice(step + 1);
  const stepMessage = messages[step];
  if (step < 0 || stepMessage?.role !== "assistant" || tail.some((message) => message.role !== "tool")) {
    return [...messages];
  }
  const answered = new Set(tail.map((message) => (message as AgentToolMessage).toolCallId));
  const cut = (stepMessage.toolCalls ?? []).filter((call) => !answered.has(call.id));
  const result = { ok: false, message: CUT_TOOL_CALL_MESSAGE };
  return [
    ...messages,
    ...cut.map(
      (call): AgentToolMessage => ({
        role: "tool",
        content: formatToolMessage(call.name, result),
        toolCallId: call.id,
        toolName: call.name,
        result,
        contextDiff: [],
      }),
    ),
  ];
}
