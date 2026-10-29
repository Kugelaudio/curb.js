/**
 * Wire protocol shared by the WS server and the browser client.
 *
 * This module is intentionally dependency-free (type imports only) so it can
 * be imported by the browser bundle without pulling in any Node-only code.
 * All runtime helpers here are pure.
 */
import type { AuthoringDiagnostic } from "../authoring.js";
import type { AgentPreviewHints } from "../config.js";
import type { ExperimentDeclaration } from "../experiments.js";
import type { AgentChatMessage, LlmCallRecord } from "../llm/types.js";
import type { McpServerSummary } from "../mcp/manager.js";
import type { SkillMeta } from "../routing.js";
import type { AgentContextEntry, CompiledContext, ContextEvent } from "../types.js";

/** Scope tag on every server-side error frame. Never silent — always surfaced. */
export type ErrorScope = "llm" | "tool" | "protocol" | "mcp" | "voice";

/**
 * An agent as the preview shows it, as data: the page builds its sidebar, graph and
 * branch maps from this and never imports the project's agent modules. Those run on the
 * server only, under Node, where a skill may import `node:crypto` or read `process.env`.
 */
export type PreviewAgent = {
  id: string;
  /** The agent module (`src/agent/agent.tsx`) as text. */
  source: string;
  /** `defineAgent({ preview })`: the empty chat's prompt chips and placeholder. */
  preview: AgentPreviewHints;
  /** Every skill, sorted by path, with its `meta` and its source text. */
  skills: Array<{ path: string; meta?: SkillMeta; source: string }>;
  /** `defineAgent({ experiments })` as the bundle manifest carries them; absent when none. The
   * server draws each conversation's variants from it. */
  experiments?: ExperimentDeclaration[];
};

/** One in-memory conversation owned by this preview connection. Switching
 * restores its complete runtime + transcript, not only a read-only log. */
export type ConversationSummary = {
  id: string;
  agentId: string | null;
  startedAt: number;
  title: string;
  messageCount: number;
};

/** One test run of a tool from the preview (`call_tool`): what the tool returned, or why
 * the run failed, and how long the tool took. */
export type ToolRun = {
  name: string;
  /** The tool's result as it returned it (`{ ok, message?, data? }`); absent when the run failed. */
  result?: unknown;
  /** Why the run failed: the tool's own failure message, or what the framework reports for a
   * tool that threw. */
  error?: string;
  durationMs: number;
};

/** Messages the browser client sends to the server (JSON text frames). */
export type ClientMessage =
  | { type: "user_text"; text: string }
  /** Push navigation INTO the agent session (records a context event the LLM
   * sees). External hosts use this; the preview's sidebar uses inspect_skill
   * instead so browsing never affects the agent. */
  | { type: "read_skill"; skill: string }
  /** Compile a skill on the connection's INSPECTOR runtime (shadow of the
   * active agent) — read-only browsing, the agent session is untouched.
   * `""` is the agent level: `agent.tsx` with no skill loaded. */
  | { type: "inspect_skill"; skill: string }
  /** Run a tool on the inspector runtime (sidebar/global-tools forms). Never
   * reaches the agent session or its transcript. */
  | { type: "call_tool"; name: string; input: Record<string, unknown> }
  /** Revert the inspector's last state change (skill load or tool run) by
   * replaying its action log onto a fresh shadow runtime. */
  | { type: "inspect_undo" }
  /** Push external session info (caller id, user id, …) into the runtime,
   * readable by components via `useAgentInfo`. Page info (`client.*`) is held to
   * {@link clientInfoProblem} and stays on every conversation the connection
   * starts afterwards: the page did not change. */
  | { type: "set_info"; values: Record<string, unknown> }
  /** MCP dashboard actions: connect/disconnect a configured server, add a new
   * remote server to the project, remove a runtime-added one. */
  | { type: "mcp_connect"; id: string }
  | { type: "mcp_disconnect"; id: string }
  | { type: "mcp_add"; id: string; url: string }
  | { type: "mcp_remove"; id: string }
  /** Switch this connection to another agent (fresh runtime + session). */
  | { type: "select_agent"; id: string }
  /** Rewind to the user message at `index` in the transcript: everything
   * from that message on is dropped and the runtime is rebuilt by replaying
   * the earlier turns' tool calls. With `rerun` (default) the message is
   * then re-run — it stays in the conversation and gets a fresh answer
   * (retry). Without it the message is dropped too, so the user can rewrite
   * it from the reverted state (rollback). */
  | { type: "rewind"; index: number; rerun?: boolean }
  /** Start a new conversation with a fresh runtime + session. */
  | { type: "reset" }
  /** Restore a previous conversation's complete runtime + session. */
  | { type: "select_conversation"; id: string }
  /** Attach voice to THIS connection's conversation: the server joins a
   * LiveKit room as the agent participant (same session, same transcript)
   * and answers with a voice_session frame carrying the browser's ticket. */
  | { type: "voice_start" }
  /** Detach voice (hang up); the conversation continues by text. */
  | { type: "voice_stop" };

/** How a browser call carries its audio: a LiveKit room, or the page's own socket. */
export type VoiceTransport = "livekit" | "local";

/** Messages the server pushes to the browser client (JSON text frames). */
export type ServerMessage =
  | {
      type: "context";
      context: CompiledContext;
      /** Flattened render of the current context — what the LLM sees as its
       * trailing state snapshot. */
      stateSnapshot: string[];
      agentContext: AgentContextEntry[];
      events: ContextEvent[];
    }
  | { type: "messages"; messages: AgentChatMessage[] }
  /** Cumulative assistant text of the in-flight turn, updated per token batch.
   * The final text arrives via `messages` when the turn completes. */
  | { type: "assistant_delta"; text: string }
  | { type: "llm_trace"; calls: LlmCallRecord[] }
  /** Status of every configured MCP server, pushed on connect and on change. */
  | { type: "mcp_servers"; servers: McpServerSummary[] }
  /** Available agents (folder ids) and this connection's active one, described. */
  | { type: "agents"; agents: string[]; active: PreviewAgent }
  /** Restorable conversations for this browser connection, newest first.
   * `recordedSystemPrompt`: the prompt the active conversation ran with, when it
   * was restored from the store; its export shows it until a turn sends one. */
  | {
      type: "conversations";
      active: string;
      conversations: ConversationSummary[];
      recordedSystemPrompt?: string;
    }
  /** Inspector compile result for an inspect_skill/call_tool/inspect_undo
   * request. `canUndo` reflects whether the inspector has state changes left
   * to revert. `toolRun` is set on the frame that answers a `call_tool`. */
  | { type: "inspect_context"; skill: string; context: CompiledContext; canUndo: boolean; toolRun?: ToolRun }
  | { type: "running"; value: boolean }
  /** Voice attachment state of this connection's conversation. `live: true`
   * carries the LiveKit ticket the browser joins with; `live: false` means
   * no call (initial state, hangup, or the room ended server-side). */
  /** `transport`: how the page joins. `livekit`: `url` is the LiveKit server, `token` its
   * room token. `local`: `url` is this server's local voice socket path (with the call's
   * token), and the audio runs over it (`local-voice-wire.ts`). */
  | { type: "voice_session"; live: true; transport: VoiceTransport; url: string; token: string; room: string }
  | { type: "voice_session"; live: false }
  /** `curb dev` reloads the agent when its files change. `waiting`: the reload waits until
   * the live call ends, or the running reply; `reloading`: this connection closes now, and
   * the next one runs the saved code. `files`: what changed, from the project root.
   * `resume`: the stored id of the conversation this page is on; it reconnects with
   * `?resume=<id>` and stays on that conversation. */
  | { type: "dev_reload"; state: "waiting"; until: "call_ends" | "reply_ends"; files: string[] }
  | { type: "dev_reload"; state: "reloading"; files: string[]; resume?: number }
  /** The agent cannot run: its modules did not load, or it does not render, or a
   * conversation could not start. `diagnostics` say where and how to fix it; `curb dev`
   * reloads it when the files change. */
  | { type: "agent_unavailable"; message: string; diagnostics: AuthoringDiagnostic[] }
  /** `curb dev`: the keys agent `agentId` needs and this process does not have, each a
   * diagnostic naming the variable and where to set it; empty when it has them all. The page
   * still shows the agent (its context renders from source) with these as a banner, and runs
   * no turn on it until a save of .env reloads the agent. */
  | { type: "missing_keys"; agentId: string; diagnostics: AuthoringDiagnostic[] }
  /** Something to know about the active conversation that is not an error: what a restored
   * conversation could not bring back (a store or skill that no longer exists). Sent after the
   * `conversations` frame that made it active. */
  | { type: "notice"; message: string }
  | { type: "error"; scope: ErrorScope; message: string };

/**
 * Page info: what the web page an agent is embedded in says about itself, as `client.<key>`
 * session info (`?client.event=webinar-11-04` on the preview's URL, `curb say --client`, a
 * scenario's `client`). Untrusted input from a page, so every route holds it to the same limits.
 */
export const CLIENT_INFO_PREFIX = "client.";
const CLIENT_INFO_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CLIENT_INFO_MAX_LENGTH = 256;

/** Why `key` (after `client.`) and `value` cannot be page info, or null when they can. */
export function clientInfoProblem(key: string, value: unknown): string | null {
  if (!CLIENT_INFO_KEY.test(key)) {
    return `"${key}" cannot name page info (client.<key>): use a letter, then up to 39 letters, digits or underscores.`;
  }
  if (typeof value !== "string") return `client.${key} must be a string, got ${value === null ? "null" : typeof value}.`;
  if (value.length > CLIENT_INFO_MAX_LENGTH) {
    return `client.${key} is ${value.length} characters long; page info values hold at most ${CLIENT_INFO_MAX_LENGTH}.`;
  }
  return null;
}

/** `{ event: "x" }` as session info: `{ "client.event": "x" }`. */
export function clientInfo(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`${CLIENT_INFO_PREFIX}${key}`, value]));
}

/** Thrown by {@link parseClientMessage} when a frame is malformed. The server
 * turns this into an explicit `error` frame rather than crashing or ignoring. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const CLIENT_TYPES: ReadonlySet<ClientMessage["type"]> = new Set([
  "user_text",
  "read_skill",
  "inspect_skill",
  "call_tool",
  "inspect_undo",
  "set_info",
  "mcp_connect",
  "mcp_disconnect",
  "mcp_add",
  "mcp_remove",
  "select_agent",
  "rewind",
  "reset",
  "select_conversation",
  "voice_start",
  "voice_stop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`Field "${field}" must be a string.`);
  }
  return value;
}

/**
 * Parse and validate a raw text frame into a typed {@link ClientMessage}.
 * Throws {@link ProtocolError} on any malformed input — there is no silent
 * acceptance of partial/unknown frames.
 */
export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProtocolError(`Frame is not valid JSON: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new ProtocolError("Frame must be a JSON object.");
  }

  const type = parsed.type;
  if (typeof type !== "string" || !CLIENT_TYPES.has(type as ClientMessage["type"])) {
    throw new ProtocolError(`Unknown client message type "${String(type)}".`);
  }

  switch (type as ClientMessage["type"]) {
    case "user_text":
      return { type: "user_text", text: requireString(parsed.text, "text") };
    case "read_skill":
      return { type: "read_skill", skill: requireString(parsed.skill, "skill") };
    case "inspect_skill":
      return { type: "inspect_skill", skill: requireString(parsed.skill, "skill") };
    case "call_tool": {
      const name = requireString(parsed.name, "name");
      if (!isRecord(parsed.input)) {
        throw new ProtocolError('Field "input" must be an object.');
      }
      return { type: "call_tool", name, input: parsed.input };
    }
    case "set_info": {
      if (!isRecord(parsed.values)) {
        throw new ProtocolError('Field "values" must be an object.');
      }
      const problems = Object.entries(parsed.values).flatMap(([key, value]) => {
        if (!key.startsWith(CLIENT_INFO_PREFIX)) return [];
        return clientInfoProblem(key.slice(CLIENT_INFO_PREFIX.length), value) ?? [];
      });
      if (problems.length > 0) throw new ProtocolError(`Page info refused: ${problems.join(" ")}`);
      return { type: "set_info", values: parsed.values };
    }
    case "mcp_connect":
      return { type: "mcp_connect", id: requireString(parsed.id, "id") };
    case "mcp_disconnect":
      return { type: "mcp_disconnect", id: requireString(parsed.id, "id") };
    case "mcp_add":
      return {
        type: "mcp_add",
        id: requireString(parsed.id, "id"),
        url: requireString(parsed.url, "url"),
      };
    case "mcp_remove":
      return { type: "mcp_remove", id: requireString(parsed.id, "id") };
    case "select_agent":
      return { type: "select_agent", id: requireString(parsed.id, "id") };
    case "rewind": {
      if (typeof parsed.index !== "number" || !Number.isInteger(parsed.index) || parsed.index < 0) {
        throw new ProtocolError('Field "index" must be a non-negative integer.');
      }
      if (parsed.rerun !== undefined && typeof parsed.rerun !== "boolean") {
        throw new ProtocolError('Field "rerun" must be a boolean.');
      }
      return { type: "rewind", index: parsed.index, rerun: parsed.rerun ?? true };
    }
    case "inspect_undo":
      return { type: "inspect_undo" };
    case "reset":
      return { type: "reset" };
    case "select_conversation":
      return { type: "select_conversation", id: requireString(parsed.id, "id") };
    case "voice_start":
      return { type: "voice_start" };
    case "voice_stop":
      return { type: "voice_stop" };
  }
}

/** Serialize a server message to a text frame. */
export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
