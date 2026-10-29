import type { AuthoringDiagnostic } from "../authoring.js";
import type { AgentChatMessage, LlmCallRecord } from "../llm/types.js";
import type { McpServerSummary } from "../mcp/manager.js";
import type { AgentContextEntry, CompiledContext, ContextEvent } from "../types.js";
import type {
  ClientMessage,
  ConversationSummary,
  ErrorScope,
  PreviewAgent,
  ServerMessage,
  ToolRun,
  VoiceTransport,
} from "../server/protocol.js";

/** Voice attachment of the conversation, mirrored from the server's
 * voice_session frames (`connecting` is client-local while a start is in
 * flight). The call itself (a LiveKit room, or the local voice socket) is joined by the
 * voice client its `transport` names. */
export type VoiceSessionState = {
  live: boolean;
  connecting: boolean;
  transport: VoiceTransport | null;
  url: string | null;
  token: string | null;
  room: string | null;
};

export type DemoClientState = {
  connected: boolean;
  context: CompiledContext | null;
  stateSnapshot: string[];
  agentContext: AgentContextEntry[];
  events: ContextEvent[];
  messages: AgentChatMessage[];
  /** Assistant text of the in-flight turn (server streams it per token batch).
   * Null when no turn is streaming; the final text lands in `messages`. */
  streamingText: string | null;
  llmTrace: LlmCallRecord[];
  mcpServers: McpServerSummary[];
  /** Available agent ids (folder names) and this connection's active agent, as the server
   * describes it (skills, their source, preview hints); null until the first agents frame. */
  agents: string[];
  activeAgent: PreviewAgent | null;
  conversations: ConversationSummary[];
  activeConversation: string | null;
  /** The system prompt the active conversation ran with, when it was restored
   * from the store (its export shows it until a turn sends one); else null. */
  recordedSystemPrompt: string | null;
  /** Read-only inspector view (sidebar browsing) — compiled on the server's
   * shadow runtime; null until the user browses. Never the agent's own state. */
  inspectedContext: CompiledContext | null;
  /** Whether the inspector has state changes left to revert via inspectUndo. */
  inspectCanUndo: boolean;
  /** The newest test run of a tool (`callTool`): a new object per run, null before the first. */
  toolRun: ToolRun | null;
  running: boolean;
  /** The conversation's voice attachment (one call at a time). */
  voice: VoiceSessionState;
  lastError: { scope: ErrorScope; message: string } | null;
  /** `curb dev` reloading the agent after a save: waiting until the call (or the reply)
   * ends, or reloading now, while this page reconnects. Null otherwise. */
  reload: { state: "waiting"; until: "call_ends" | "reply_ends" } | { state: "reloading" } | null;
  /** Why the agent cannot run (it did not load, does not render, or a conversation could
   * not start), with where to fix it; null while it runs. */
  unavailable: { message: string; diagnostics: AuthoringDiagnostic[] } | null;
  /** `curb dev`: per agent id, the keys it needs that the server does not have. Such an agent
   * is shown and cannot answer; see {@link missingKeysOf}. */
  missingKeys: Readonly<Record<string, AuthoringDiagnostic[]>>;
  /** Something to know about the active conversation that is not an error (what a restored
   * conversation could not bring back); null when there is nothing. Cleared when another
   * conversation becomes active. */
  notice: string | null;
  /** Counts the connections whose agent the server described (their first `agents` frame):
   * each is a new server-side connection, whose inspector the page points at its skill. */
  connection: number;
};

const INITIAL_STATE: DemoClientState = {
  connected: false,
  context: null,
  stateSnapshot: [],
  agentContext: [],
  events: [],
  messages: [],
  streamingText: null,
  llmTrace: [],
  mcpServers: [],
  agents: [],
  activeAgent: null,
  conversations: [],
  activeConversation: null,
  recordedSystemPrompt: null,
  inspectedContext: null,
  inspectCanUndo: false,
  toolRun: null,
  running: false,
  voice: { live: false, connecting: false, transport: null, url: null, token: null, room: null },
  lastError: null,
  reload: null,
  unavailable: null,
  missingKeys: {},
  notice: null,
  connection: 0,
};

/** The keys the active agent needs and the server does not have: while there are any, the
 * page shows the agent and why it cannot answer, and sends it no message and starts no call. */
export function missingKeysOf(state: DemoClientState): AuthoringDiagnostic[] {
  return (state.activeAgent && state.missingKeys[state.activeAgent.id]) || [];
}

function defaultWsUrl(): string {
  const fromEnv = import.meta.env?.VITE_WS_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  // Same origin: preview and agent WS share one server/port, so the WS URL
  // is derived from wherever the preview was loaded (tunnels included).
  if (typeof location !== "undefined") {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }
  return "ws://127.0.0.1:4000";
}

/**
 * Thin browser client: connects to the WS server, exposes server-pushed state
 * via a `useSyncExternalStore`-compatible subscription. It holds NO agent
 * runtime/session — every rendered value comes from the server.
 */
export class DemoWsClient {
  private readonly url: string;
  /** The page's own info (`client.*`): sent on every connection, so a restarted server
   * gets it too, and the server puts it on every conversation this page starts. */
  private readonly pageInfo: Readonly<Record<string, string>>;
  private socket: WebSocket | null = null;
  private state: DemoClientState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private reconnectDelay = 500;
  private closed = false;
  /** `curb dev` is reloading the agent: the stored conversation the next socket asks to stay
   * on, as the reload named it. Kept while the agent cannot run, until one serves again. */
  private resumeConversation: number | null = null;
  /** The current socket's server has described its agent (sent `agents`). */
  private agentDescribed = false;

  constructor(url: string = defaultWsUrl(), pageInfo: Readonly<Record<string, string>> = {}) {
    this.url = url;
    this.pageInfo = pageInfo;
  }

  getState(): DemoClientState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  dispose(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  // --- outgoing actions -----------------------------------------------------

  sendUserText(text: string): void {
    if (!text.trim() || missingKeysOf(this.state).length > 0) return;
    this.send({ type: "user_text", text });
  }

  /** Push navigation INTO the agent session (records a context event the LLM
   * sees). The preview sidebar does NOT use this — it inspects instead. */
  loadSkill(skill: string): void {
    this.send({ type: "read_skill", skill });
  }

  /** Browse a skill read-only on the server's inspector runtime. */
  inspectSkill(skill: string): void {
    this.send({ type: "inspect_skill", skill });
  }

  /** Run a UI tool form on the inspector runtime (never the agent session). */
  callTool(name: string, input: Record<string, unknown>): void {
    this.send({ type: "call_tool", name, input });
  }

  /** Revert the inspector's last state change (skill load or tool run). */
  inspectUndo(): void {
    this.send({ type: "inspect_undo" });
  }

  mcpConnect(id: string): void {
    this.send({ type: "mcp_connect", id });
  }

  mcpDisconnect(id: string): void {
    this.send({ type: "mcp_disconnect", id });
  }

  mcpRemove(id: string): void {
    this.send({ type: "mcp_remove", id });
  }

  /** Switch this connection to another agent. The server answers with fresh
   * `agents` + context/messages frames; local voice state resets here. */
  selectAgent(id: string): void {
    if (id === this.state.activeAgent?.id) return;
    this.send({ type: "select_agent", id });
    this.patch({ lastError: null });
  }

  /** Rewind to the user message at `index`. With `rerun` (default) the
   * message stays and is answered again (retry); without it the message is
   * dropped too so it can be rewritten (rollback). The server reverts the
   * environment by replay and pushes a full snapshot either way. */
  rewind(index: number, rerun = true): void {
    this.send({ type: "rewind", index, rerun });
    this.patch({ lastError: null });
  }

  /** Start a new conversation. The server clears its transcript and pushes
   * fresh (empty) messages/trace frames. */
  reset(): void {
    this.send({ type: "reset" });
    this.patch({ lastError: null });
  }

  /** Restore a prior conversation's runtime, transcript, and trace. */
  selectConversation(id: string): void {
    if (id === this.state.activeConversation) return;
    this.send({ type: "select_conversation", id });
    this.patch({ lastError: null });
  }

  /** Attach voice to this conversation: the server joins a LiveKit room on
   * the SAME session and answers with a voice_session ticket frame. */
  voiceStart(): void {
    if (this.state.voice.live || this.state.voice.connecting || missingKeysOf(this.state).length > 0) return;
    this.patch({ voice: { ...this.state.voice, connecting: true }, lastError: null });
    this.send({ type: "voice_start" });
  }

  /** Hang up; the conversation continues by text. */
  voiceStop(): void {
    this.send({ type: "voice_stop" });
  }

  // --- socket plumbing ------------------------------------------------------

  /** The server URL, with `?resume=<id>` when a reload should land on the same conversation. */
  private socketUrl(): string {
    if (this.resumeConversation === null) return this.url;
    const url = new URL(this.url);
    url.searchParams.set("resume", String(this.resumeConversation));
    return url.toString();
  }

  private openSocket(): void {
    const socket = new WebSocket(this.socketUrl());
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = 500;
      this.agentDescribed = false;
      this.patch({
        connected: true,
        // A new connection is served by the agent on disk now: a reload is over, and the
        // inspector view came from the previous connection's copy of the agent.
        reload: null,
        inspectedContext: null,
        inspectCanUndo: false,
        notice: null,
        // The new connection's server says again which keys it lacks, before its agent.
        missingKeys: {},
        // No call outlives its connection, and a Start call pressed while the socket was
        // down never reached a server that would answer it.
        voice: INITIAL_STATE.voice,
      });
      // Before anything the user can do: the first conversation opens with it.
      if (Object.keys(this.pageInfo).length > 0) this.send({ type: "set_info", values: { ...this.pageInfo } });
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return; // server only sends JSON text frames
      const message = parseServerFrame(event.data);
      if (!message) {
        this.patch({
          lastError: { scope: "protocol", message: "Received a malformed frame from the server." },
        });
        return;
      }
      this.handleServerMessage(message);
    };

    socket.onclose = () => {
      this.patch({ connected: false });
      if (!this.closed) {
        setTimeout(() => this.openSocket(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
      }
    };

    socket.onerror = () => {
      // The close handler drives reconnect; surface a hint for the UI.
      this.patch({ lastError: { scope: "protocol", message: "WebSocket connection error." } });
    };
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "context":
        this.patch({
          context: message.context,
          stateSnapshot: message.stateSnapshot,
          agentContext: message.agentContext,
          events: message.events,
        });
        return;
      case "messages":
        // The transcript supersedes any in-flight stream text.
        this.patch({ messages: message.messages, streamingText: null });
        return;
      case "assistant_delta":
        this.patch({ streamingText: message.text });
        return;
      case "llm_trace":
        this.patch({ llmTrace: message.calls });
        return;
      case "mcp_servers":
        this.patch({ mcpServers: message.servers });
        return;
      case "inspect_context":
        this.patch({
          inspectedContext: message.context,
          inspectCanUndo: message.canUndo,
          ...(message.toolRun ? { toolRun: message.toolRun } : {}),
        });
        return;
      case "agents": {
        // The agent runs: whatever a reload was for has landed.
        this.resumeConversation = null;
        const firstOnSocket = !this.agentDescribed;
        this.agentDescribed = true;
        this.patch({
          agents: message.agents,
          activeAgent: message.active,
          unavailable: null,
          connection: this.state.connection + (firstOnSocket ? 1 : 0),
          // The inspector shadows the active agent — stale views from another
          // agent must not survive a switch.
          ...(message.active.id !== this.state.activeAgent?.id
            ? { inspectedContext: null, inspectCanUndo: false }
            : {}),
        });
        return;
      }
      case "conversations":
        this.patch({
          conversations: message.conversations,
          activeConversation: message.active,
          recordedSystemPrompt: message.recordedSystemPrompt ?? null,
          ...(message.active !== this.state.activeConversation ? { notice: null } : {}),
        });
        return;
      case "notice":
        this.patch({ notice: message.message });
        return;
      case "dev_reload":
        if (message.state === "reloading") {
          // `curb dev` holds the next socket until the reloaded agent serves: reconnect at
          // once rather than after a backoff (which still grows if it is gone).
          this.reconnectDelay = 50;
          // The page the agent could not run on is told without one; it keeps the one it had.
          if (message.resume !== undefined) this.resumeConversation = message.resume;
        }
        this.patch({
          reload: message.state === "waiting" ? { state: "waiting", until: message.until } : { state: "reloading" },
        });
        return;
      case "agent_unavailable":
        this.patch({
          unavailable: { message: message.message, diagnostics: message.diagnostics },
          reload: null,
        });
        return;
      case "missing_keys":
        this.patch({ missingKeys: { ...this.state.missingKeys, [message.agentId]: message.diagnostics } });
        return;
      case "running":
        this.patch({ running: message.value, ...(message.value ? {} : { streamingText: null }) });
        return;
      case "voice_session":
        this.patch({
          voice: message.live
            ? {
                live: true,
                connecting: false,
                transport: message.transport,
                url: message.url,
                token: message.token,
                room: message.room,
              }
            : { live: false, connecting: false, transport: null, url: null, token: null, room: null },
        });
        return;
      case "error":
        this.patch({
          lastError: { scope: message.scope, message: message.message },
          // A failed voice_start never yields a voice_session frame — clear
          // the in-flight marker so the Start call button recovers.
          ...(message.scope === "voice" ? { voice: { ...this.state.voice, connecting: false } } : {}),
        });
        return;
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      this.patch({ lastError: { scope: "protocol", message: "Not connected to the server yet." } });
    }
  }

  private patch(partial: Partial<DemoClientState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

const SERVER_TYPES: ReadonlySet<ServerMessage["type"]> = new Set([
  "context",
  "messages",
  "assistant_delta",
  "llm_trace",
  "mcp_servers",
  "agents",
  "conversations",
  "inspect_context",
  "running",
  "voice_session",
  "dev_reload",
  "agent_unavailable",
  "missing_keys",
  "notice",
  "error",
]);

/** Validate an incoming text frame. Returns null (and logs) on malformed JSON
 * or an unknown message type — the caller surfaces it, never silently drops. */
function parseServerFrame(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("[ws-client] frame is not valid JSON:", error);
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !SERVER_TYPES.has((parsed as { type?: unknown }).type as ServerMessage["type"])
  ) {
    console.warn("[ws-client] unknown server frame:", parsed);
    return null;
  }
  return parsed as ServerMessage;
}
