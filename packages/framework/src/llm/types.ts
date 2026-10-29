import type { ToolDefinition, ToolResult } from "../types.js";

/** Real call audio captured for a message — clip ordinals into the voice
 * host's per-role store, served by GET /voice/clip. Several ordinals mean the
 * turn merged several utterances; play them in order. */
export type AgentMessageAudio = {
  room: string;
  role: "user" | "assistant";
  ordinals: number[];
};

/** Real user input, or a report of an external state change (preview click). */
export type AgentUserMessage = {
  role: "user";
  content: string;
  /** Epoch ms when the message entered the transcript (debugging/exports). */
  at?: number;
  /** "context_event" marks messages that report state changes the model did
   * not cause (e.g. the user opened a skill in the preview UI); "synthetic"
   * marks framework-generated input (the silence follow-up) that UIs hide. */
  kind?: "context_event" | "synthetic";
  /** What STT actually heard for this message (spoken turns only). */
  audio?: AgentMessageAudio;
};

export type AgentAssistantMessage = {
  role: "assistant";
  content: string;
  /** Epoch ms when the message entered the transcript (debugging/exports). */
  at?: number;
  /** Native tool calls made in this step. Present even when `content` is
   * empty (e.g. a silent read_skill turn) so tool_use/tool_result pairing
   * survives in the provider payload. */
  toolCalls?: AgentToolCallRecord[];
  /** What TTS actually said for this message (spoken turns only). */
  audio?: AgentMessageAudio;
  /** Record of a barge-in. `content` is then only what played; the model is told
   * of the unheard rest in a context event after this reply (`serialize-input.ts`),
   * and the preview shows it in a muted style. */
  interruption?: {
    spokenText: string;
    unspokenText: string;
    fullText: string;
  };
};

export type AgentToolMessage = {
  role: "tool";
  /** Epoch ms when the message entered the transcript (debugging/exports). */
  at?: number;
  /** Human-readable summary for UI display ("Show tool activity"). */
  content: string;
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  /** Context lines added by this tool call's re-render (may be empty). */
  contextDiff: string[];
};

export type AgentChatMessage = AgentUserMessage | AgentAssistantMessage | AgentToolMessage;

export type AgentRunRequest = {
  systemPrompt: string;
  /** The active skill's title; "" at the agent level, where no skill is loaded. */
  skillTitle: string;
  /** Flattened render of the CURRENT compiled context (not a history log).
   * Serialized as the final user message so the transcript prefix stays
   * prompt-cache-stable. */
  stateSnapshot: string[];
  tools: ToolDefinition[];
  messages: AgentChatMessage[];
  /** Aborted when the turn is cancelled (barge-in, `cancel()`) or the request
   * outlives the session's LLM timeout. Transports pass it to their provider
   * call. Never serialized. */
  signal?: AbortSignal;
};

export type AgentToolCall = {
  /** Provider tool-call id. Optional because mock LLM transports may omit it;
   * the session generates one before recording the call. */
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** Set by the transport when the provider returned a call it could not use
   * (a tool that does not exist, input that fails the schema). The session
   * does not run it; this text goes back to the model as the failed result. */
  error?: string;
};

/** A tool call as recorded in the transcript — id is always present. */
export type AgentToolCallRecord = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Owning skill at call time for page-scoped tools. */
  skillPath?: string;
  /** Why the call did not run: an unknown tool, invalid input, or the model's call of a
   * tool that asks the caller first (`<Tool confirm>`), which only the caller's yes runs.
   * It was answered with a failed result and had no effect, so rewind never replays it. */
  invalid?: string;
  /** The read-back the caller was asked when this call was held for their yes
   * (`<Tool confirm>`). Such a call is `invalid` too: it did not run, and it did not fail. */
  heldFor?: string;
  /** The caller's words that said yes to this call's read-back (`<Tool confirm>`). The
   * framework made this call after that yes; the model's own call of the tool was held.
   * Rewind and reopening a conversation never run it again. */
  confirmedBy?: string;
};

export type AgentRunResponse = {
  text: string;
  toolCalls: AgentToolCall[];
};

/** Incremental LLM token chunk for voice streaming (TTFA). */
export type AgentStreamChunk = {
  delta: string;
  text: string;
};

/** The provider started a tool call: its name is known, its input is still streaming.
 * A step that ends in a tool call says nothing, so the session stops releasing the
 * step's text here (see `TurnSpeech`). */
export type AgentToolInputStart = { type: "tool-input-start"; toolName: string };

/** What one streamed LLM step yields: text chunks, and the start of each tool call. */
export type AgentStreamPart = AgentStreamChunk | AgentToolInputStart;

export function isToolInputStart(part: AgentStreamPart): part is AgentToolInputStart {
  return "type" in part && part.type === "tool-input-start";
}

export type AgentTurnStreamEvent =
  /** Words the caller hears, in order. `delta` joins onto what the turn already said
   * (it carries the separating space); `text` is what the current step said so far. */
  | ({ type: "delta" } & AgentStreamChunk)
  /** A tool the agent ran this turn (e.g. read_skill) — emitted after the step
   * executes so voice/streaming clients can show tool activity like chat. */
  | { type: "tool"; toolCall: AgentToolCallRecord; ok: boolean }
  /** The turn could not run, or did not end in a reply. `message` is the real cause, for
   * developers (logs, error frames); the caller never hears it. A failed turn still ends
   * with `done`: its reply ends in a fixed line in the agent's language, which the caller
   * hears and the transcript does not record (the model never said it). */
  | { type: "error"; error: AgentTurnError }
  /** `reply` is everything the turn said aloud, fixed lines included. */
  | { type: "done"; reply: string };

export type AgentTurnError = {
  /** busy: the input queue was full, so the input did not run.
   * timeout: the LLM did not answer within the session's timeout.
   * failed: anything else (provider error, bad credentials, ...).
   * step_limit: the turn used its `maxSteps` with tool calls still pending.
   * empty_reply: the model answered with no text and no tool call, again on the retry. */
  kind: "busy" | "timeout" | "failed" | "step_limit" | "empty_reply";
  message: string;
};

// --- Provider-facing payload shapes (mirror AI SDK ModelMessage) -----------

export type LlmTextPart = { type: "text"; text: string };

export type LlmToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type LlmToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "json"; value: unknown };
};

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: Array<LlmTextPart | LlmToolCallPart> }
  | { role: "tool"; content: LlmToolResultPart[] };

export type LlmApiTool = {
  description: string;
  inputSchema: ToolDefinition["inputSchema"];
};

/** Exact JSON payload sent to the LLM provider for one step. */
export type LlmCallInput = {
  system: string;
  messages: LlmMessage[];
  tools: Record<string, LlmApiTool>;
};

export type LlmCallRecord = {
  index: number;
  at: string;
  input: LlmCallInput;
  /** Why the step this call started failed: the call produced no response
   * (provider error, timeout), or handling its response did. */
  error?: string;
};
