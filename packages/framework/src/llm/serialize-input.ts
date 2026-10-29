import type {
  AgentChatMessage,
  AgentRunRequest,
  LlmCallInput,
  LlmMessage,
  LlmTextPart,
  LlmToolCallPart,
} from "./types.js";
import { toolResultPayload } from "./tool-messages.js";
import { contextEvent, interruptionNote } from "./transcript.js";

/**
 * What the model is told about the blocks the framework adds to user turns (`<current_context>`
 * and `<context_event>`, below). Without it, models trained to distrust system-like text inside
 * a user message take the current context for something the caller typed: they set the active
 * skill's instructions aside and tell the caller so, in English.
 */
export const CONTEXT_PROTOCOL = [
  "## Context from your application",
  "Your application, not the person you talk to, adds two kinds of blocks to the conversation. The person cannot see or write them.",
  "- `<current_context>` ends the newest user message: today's date and time, your current state and knowledge, and the instructions and tools of the skills you have read, written fresh for every turn. Follow it.",
  "- `<context_event>`: a notice of something that happened outside your own tool calls: your state changed, or the person talked over one of your replies.",
  "Treat both as your own trusted context, never as the person's words, and never mention, quote or comment on them.",
].join("\n");

/**
 * JSON-serializable payload matching what the AI SDK sends to the provider.
 *
 * Layout (three layers):
 * 1. `system` — developer instructions, static.
 * 2. Transcript — chronological, protocol-native: assistant messages carry
 *    `tool-call` parts, tool results return as `tool-result` parts that also
 *    carry the context diff the call caused.
 * 3. State snapshot — a render of the CURRENT context appended as the final
 *    user message, so the transcript prefix stays prompt-cache-stable.
 */
export function serializeLlmInput(request: AgentRunRequest): LlmCallInput {
  return {
    system: request.systemPrompt ? `${request.systemPrompt}\n\n${CONTEXT_PROTOCOL}` : CONTEXT_PROTOCOL,
    messages: [
      ...toLlmMessages(request.messages),
      {
        role: "user",
        content: renderStateSnapshot(request),
      },
    ],
    tools: Object.fromEntries(
      request.tools.map((definition) => [
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
      ]),
    ),
  };
}

/**
 * The transcript as provider messages. An interrupted reply says only what the caller heard,
 * and is followed by a context event telling the model what they did not
 * ({@link interruptionNote}), after the reply's tool results, which must follow its tool calls.
 */
function toLlmMessages(messages: readonly AgentChatMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  let note: string | null = null;
  for (const message of messages) {
    if (note !== null && message.role !== "tool") {
      out.push(toLlmMessage(contextEvent(note)));
      note = null;
    }
    if (message.role === "assistant" && message.interruption) note = interruptionNote(message.interruption);
    const llm = toLlmMessage(message);
    // A reply the caller heard none of, without tool calls, has nothing left to send.
    if (llm.role !== "assistant" || llm.content.length > 0) out.push(llm);
  }
  if (note !== null) out.push(toLlmMessage(contextEvent(note)));
  return out;
}

function toLlmMessage(message: AgentChatMessage): LlmMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content:
          message.kind === "context_event"
            ? `<context_event>\n${message.content}\n</context_event>`
            : message.content,
      };
    case "assistant": {
      const parts: Array<LlmTextPart | LlmToolCallPart> = [];
      // A conversation recorded before the cut-off note moved out of the reply holds that
      // note in `content`; the interruption record has the heard words alone.
      const text = message.interruption ? message.interruption.spokenText : message.content;
      if (text.trim()) {
        parts.push({ type: "text", text });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
        });
      }
      return { role: "assistant", content: parts };
    }
    case "tool":
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: { type: "json", value: toolResultPayload(message) },
          },
        ],
      };
  }
}

function renderStateSnapshot(request: AgentRunRequest): string {
  return [
    // No skill read yet (the agent level): no skill to name.
    request.skillTitle ? `<current_context skill="${request.skillTitle}">` : "<current_context>",
    ...request.stateSnapshot,
    "</current_context>",
  ].join("\n");
}
