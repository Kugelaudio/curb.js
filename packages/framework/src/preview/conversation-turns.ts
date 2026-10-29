import type {
  AgentAssistantMessage,
  AgentMessageAudio,
  AgentChatMessage,
  AgentToolCallRecord,
  AgentToolMessage,
  AgentUserMessage,
} from "../llm/types.js";

/**
 * The transcript as the conversation column shows it: what the caller said, and per agent
 * turn, everything the agent did in order (each tool call with its outcome, and its words).
 * Built only from what every transcript has, so it reads the same for any agent.
 */

/** Where one tool call stands. A call held for the caller's yes is asked, not run and
 * not failed; one with no result yet is still running (or never reported back). */
export type ToolCallStatus = "ok" | "failed" | "held" | "pending";

export type ToolCallView = {
  call: AgentToolCallRecord;
  /** The call's result message, paired by tool-call id. */
  result?: AgentToolMessage;
  status: ToolCallStatus;
};

export type AgentTurnItem =
  | { kind: "text"; index: number; message: AgentAssistantMessage }
  | { kind: "tool"; index: number; tool: ToolCallView };

export type ConversationTurn =
  | { kind: "caller"; index: number; message: AgentUserMessage }
  | { kind: "agent"; index: number; items: AgentTurnItem[] };

export function toolCallStatus(call: AgentToolCallRecord, result: AgentToolMessage | undefined): ToolCallStatus {
  if (call.heldFor) return "held";
  if (!result) return "pending";
  return result.result.ok === false ? "failed" : "ok";
}

/** Tool results by the id of the call they answer. */
export function toolResultsById(messages: readonly AgentChatMessage[]): Map<string, AgentToolMessage> {
  const results = new Map<string, AgentToolMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) results.set(message.toolCallId, message);
  }
  return results;
}

/**
 * Group the transcript into turns. Consecutive agent steps form one turn: a step that
 * only called tools, then the step that answered. Input the caller did not write (a
 * context event, the framework's silence follow-up) is not shown, but it still ends the
 * agent's turn, so two answers never merge into one.
 */
export function conversationTurns(messages: readonly AgentChatMessage[]): ConversationTurn[] {
  const results = toolResultsById(messages);
  const turns: ConversationTurn[] = [];
  let agent: Extract<ConversationTurn, { kind: "agent" }> | null = null;

  messages.forEach((message, index) => {
    if (message.role === "user") {
      agent = null;
      if (!message.kind) turns.push({ kind: "caller", index, message });
      return;
    }
    if (message.role !== "assistant") return;
    const items: AgentTurnItem[] = [];
    // A step's words come before its tool calls: that is the order the model wrote them.
    if (message.content.trim()) items.push({ kind: "text", index, message });
    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.id);
      items.push({ kind: "tool", index, tool: { call, result, status: toolCallStatus(call, result) } });
    }
    if (items.length === 0) return;
    if (!agent) {
      agent = { kind: "agent", index, items: [] };
      turns.push(agent);
    }
    agent.items.push(...items);
  });
  return turns;
}

/**
 * What a turn's actions (play, copy, what the model read) act on: everything the agent wrote
 * in it, read as one reply; the audio of all of it when one call said all of it (else the
 * words are spoken anew); and its last message, whose model call "What the model read"
 * shows. Null for a turn without words.
 */
export function turnReply(items: readonly AgentTurnItem[]): {
  text: string;
  audio?: AgentMessageAudio;
  last: { index: number; message: AgentAssistantMessage };
} | null {
  const texts = items.flatMap((item) => (item.kind === "text" ? [item] : []));
  const last = texts.at(-1);
  if (!last) return null;
  const audios = texts.map((item) => item.message.audio);
  const first = audios[0];
  const oneCall = first && audios.every((audio) => audio?.room === first.room && audio.role === first.role);
  return {
    text: texts.map((item) => item.message.interruption?.spokenText ?? item.message.content).join("\n\n"),
    ...(oneCall ? { audio: { ...first, ordinals: audios.flatMap((audio) => audio!.ordinals) } } : {}),
    last: { index: last.index, message: last.message },
  };
}

/** The newest agent message with words: the one its actions (play, copy, what the model
 * read) sit under without hovering. */
export function newestReplyIndex(messages: readonly AgentChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) return index;
  }
  return -1;
}

/** The caller's message after `index`: where a rollback cuts the transcript, and the text
 * it puts back in the field so it can be written again. */
export function nextCallerMessage(
  messages: readonly AgentChatMessage[],
  index: number,
): { index: number; text: string } | null {
  for (let next = index + 1; next < messages.length; next += 1) {
    const message = messages[next];
    if (message.role === "user" && !message.kind) return { index: next, text: message.content };
  }
  return null;
}

/** The newest call of `name` the agent made in this conversation, for "Use these". */
export function lastCallOf(messages: readonly AgentChatMessage[], name: string): AgentToolCallRecord | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const call = [...(message.toolCalls ?? [])].reverse().find((candidate) => candidate.name === name);
    if (call) return call;
  }
  return null;
}
