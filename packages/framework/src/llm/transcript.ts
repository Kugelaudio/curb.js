import { splitAtSpokenWords } from "./spoken-split.js";
import type {
  AgentAssistantMessage,
  AgentChatMessage,
  AgentMessageAudio,
  AgentToolCallRecord,
  AgentUserMessage,
} from "./types.js";

/** A state change the model learns of in order, as a message of its own. */
export function contextEvent(content: string): AgentUserMessage {
  return { role: "user", kind: "context_event", content, at: Date.now() };
}

/**
 * The transcript with call `audio` attached to the newest message of `role` that has none
 * and can carry it (the caller's own words, or a reply with words), or null when the
 * newest such message has its clips already.
 */
export function withAudio(
  messages: readonly AgentChatMessage[],
  role: "user" | "assistant",
  audio: AgentMessageAudio,
): AgentChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== role) continue;
    const candidate = message as AgentUserMessage | AgentAssistantMessage;
    if (candidate.role === "user" && candidate.kind) continue;
    if (candidate.role === "assistant" && !candidate.content) continue;
    if (candidate.audio) return null;
    const next = [...messages];
    next[i] = { ...candidate, audio };
    return next;
  }
  return null;
}

/**
 * `message` cut to the words the caller heard, `spokenText` (a voice host's playback-aligned
 * prefix): `content` becomes exactly those words, and `interruption` keeps the split. Null
 * when the caller heard all of it (they spoke over its last word) or it already says exactly
 * that.
 *
 * The model learns of the cut from {@link interruptionNote}, a context event of its own, never
 * from words added to its reply: a note inside the model's own turn reads as something it
 * said, and it writes such notes itself, aloud ("[assistant turned their head away]").
 */
export function interruptedReply(message: AgentAssistantMessage, spokenText: string): AgentAssistantMessage | null {
  const fullText = message.interruption?.fullText ?? message.content;
  const { spoken, unspoken } = splitAtSpokenWords(fullText, spokenText);
  if (!unspoken) return null;
  if (message.content === spoken && message.interruption?.spokenText === spoken) return null;
  return { ...message, content: spoken, interruption: { spokenText: spoken, unspokenText: unspoken, fullText } };
}

/** What the model is told, after an interrupted reply, about what the caller did not hear. */
export function interruptionNote(interruption: NonNullable<AgentAssistantMessage["interruption"]>): string {
  return interruption.spokenText
    ? `The caller talked over your previous reply: they heard it only up to where it ends above, and never heard the rest you had written: "${interruption.unspokenText}"`
    : `The caller talked over your previous reply before any of it played: they heard none of it. You had written: "${interruption.fullText}"`;
}

/**
 * Keep only the newest `max` messages for the LLM. The window never starts
 * mid tool exchange: it advances to the next plain user message so every
 * assistant tool_use keeps its paired tool_result (Anthropic rejects orphaned
 * pairs). Falls back to the raw window if no user message exists in it —
 * impossible in practice since every turn begins with one.
 */
export function capTranscript(messages: AgentChatMessage[], max: number): AgentChatMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start].role !== "user") start += 1;
  if (start >= messages.length) return messages.slice(-max);
  return messages.slice(start);
}

/** The transcript with the tool call record of the same id in the assistant
 * message at `index` replaced by `record`. */
export function withToolCallRecord(
  messages: AgentChatMessage[],
  index: number,
  record: AgentToolCallRecord,
): AgentChatMessage[] {
  const message = messages[index];
  if (message?.role !== "assistant" || !message.toolCalls) {
    throw new Error(`No assistant tool step at transcript index ${index} for tool call "${record.id}".`);
  }
  const next = [...messages];
  next[index] = {
    ...message,
    toolCalls: message.toolCalls.map((call) => (call.id === record.id ? record : call)),
  };
  return next;
}
