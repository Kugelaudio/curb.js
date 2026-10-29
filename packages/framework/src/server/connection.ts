import { randomUUID } from "node:crypto";
import { EXPERIMENT_INFO_PREFIX, type ExperimentDeclaration } from "../experiments.js";
import { drawnVariant, forcedVariant } from "../experiments.node.js";
import type { AgentChatMessage } from "../llm/types.js";
import type { AgentSession } from "../agent-session.js";
import { getMcpManager, type McpManager } from "../mcp/manager.js";
import type { AgentSiteRuntime } from "../runtime.js";
import type { CallView } from "../session-context.js";
import type { ToolResult } from "../types.js";
import { pageInfoOf, restoreConversation, type ConversationState } from "./conversation-restore.js";
import { contextFrame, errorFrame, llmTraceFrame, messagesFrame, runningFrame } from "./frames.js";
import {
  CLIENT_INFO_PREFIX,
  ProtocolError,
  type ClientMessage,
  type ConversationSummary,
  type PreviewAgent,
  type ServerMessage,
  type ToolRun,
  type VoiceTransport,
} from "./protocol.js";
import { rebuildSessionAt } from "./session-rewind.js";

/**
 * How many recorded conversations the sidebar offers.
 *
 * Bounded because a project accumulates a conversation row per page load, and a
 * demo that has been open all week has hundreds — a sidebar listing all of them is
 * not history, it is noise. The store already excludes conversations with no
 * messages, so these are real ones.
 */
const HISTORY_LIMIT = 20;

/** Everything one agent session needs on a connection. `create` builds the
 * bundle for another agent when the user switches (fresh runtime + session). */
export type AgentSessionBundle = {
  runtime: AgentSiteRuntime;
  session: AgentSession;
};

export type AgentHost = {
  /** All available agent ids (folder names), for the preview's selector. */
  ids: string[];
  /** The agent the initial runtime/session were built for. */
  initialId: string;
  /** Build a fresh bundle for the given agent id. */
  create: (id: string) => Promise<AgentSessionBundle>;
  /** Build a standalone runtime for the given agent id — used as the
   * connection's INSPECTOR (sidebar browsing + tool forms), so the preview
   * never mutates the live agent session. The inspector passes
   * maxLoadedSkills: MAX_SAFE_INTEGER so browsing never evicts a page and
   * component state (logins, procedure progress) survives navigation. */
  createRuntime: (id: string, options?: { maxLoadedSkills?: number }) => Promise<AgentSiteRuntime>;
  /** The agent as the preview shows it, sent with the `agents` frame: the page never
   * imports the project's agent modules. */
  preview: (id: string) => PreviewAgent;
};

/** A live voice attachment on this connection's conversation. */
export type VoiceCallHandle = {
  transport: VoiceTransport;
  url: string;
  token: string;
  room: string;
  /** Interrupt current speech, then feed a typed message through the call so
   * its reply is spoken. Resolves after the prior reply is reconciled. */
  sendText: (text: string) => Promise<void>;
  /** Point the call at a rebuilt session bundle (rewind). */
  setBundle: (bundle: AgentSessionBundle) => void;
  /** Cut any in-flight spoken reply. */
  interrupt: () => void;
  close: () => Promise<void>;
};

/** Host-provided voice transport: joins a LiveKit room as the agent
 * participant running on the CONNECTION's session, and returns the browser's
 * ticket plus live-call controls. Absent on hosts without voice. */
export type VoiceHostAdapter = {
  start: (args: {
    bundle: AgentSessionBundle;
    agentId: string;
    /** Called once when the call ends server-side (hangup, room closed). */
    onClosed: () => void;
  }) => Promise<VoiceCallHandle>;
};

export type ConnectionDeps = {
  runtime: AgentSiteRuntime;
  session: AgentSession;
  /** Multi-agent support: when present, the connection announces the available
   * agents and handles `select_agent` by swapping in a fresh session. */
  agentHost?: AgentHost;
  /** Voice support: when present, the connection handles voice_start/voice_stop
   * by attaching a live call to its own session. */
  voiceHost?: VoiceHostAdapter;
  /** MCP manager driving the dashboard. Defaults to the process-wide one;
   * injectable for tests. */
  mcp?: McpManager;
  /** Past conversations to offer alongside this connection's own. Absent means
   * the connection shows only what it started, which is what every host without
   * a store does. */
  history?: ConversationHistory;
};

/**
 * Read-only view of previously recorded conversations.
 *
 * A NARROW INTERFACE RATHER THAN THE STORE ITSELF. `ConversationStore` is
 * a file on disk and Node-only; this connection is unit-tested with fakes and has
 * no business knowing what durability looks like. It also keeps the direction of
 * the dependency right: the connection asks for transcripts, and something else
 * decides whether those come from a local file, a host's own store, or nothing at all.
 */
export type ConversationHistory = {
  /** Most recent first. Implementations exclude conversations with no messages. */
  list(limit: number): Array<{
    id: number;
    agentId: string;
    startedAt: number;
    messageCount: number;
  }>;
  /** The full transcript, as the framework's own messages. */
  messages(id: number): AgentChatMessage[];
  /** The system prompt the conversation ran with, as recorded; null when none was. */
  systemPrompt(id: number): string | null;
  /** What the conversation kept besides its transcript, as recorded; null when it kept
   * nothing (recorded before conversations kept their state), and on a store without it. */
  state?(id: number): ConversationState | null;
  /** The id `session` is recorded under, once its first message is written; null before. */
  recordedId?(session: AgentSession): number | null;
  /** Record `session` into the stored conversation `id`, which it continues, instead of a new one. */
  continueRecording?(session: AgentSession, id: number): void;
};

/**
 * One conversation this connection can switch to.
 *
 * EITHER LIVE OR STORED, never both at once, and that distinction is the whole
 * reason history survives a refresh. A live one owns a materialised runtime and
 * session. A stored one is a transcript and nothing else until it is opened, at
 * which point its recorded state is restored onto a real bundle, because building a
 * runtime per recorded conversation at connect would start dozens of agents to render
 * a sidebar.
 */
type RestorableConversation = {
  id: string;
  agentId: string | null;
  startedAt: number;
  /**
   * The conversation's call identity (`useSession().call`), typed or spoken: the same on
   * every runtime it gets, so a rewind does not turn it into another call.
   */
  call: CallView;
  bundle?: AgentSessionBundle;
  stored?: AgentChatMessage[];
  /** The store's id of a stored conversation, which its recorded state is read under. */
  storedId?: number;
  /** The system prompt a stored conversation ran with: a restored session has sent none yet. */
  recordedSystemPrompt?: string;
};

/** A preview conversation's call identity. Unique per conversation, not per connection. */
function newPreviewCall(): CallView {
  return { sessionId: `preview-${randomUUID()}` };
}

/**
 * The change a preview conversation's `experiment.*` info needs, given the info it holds now, or
 * `{}` when it has the right variants. `curb dev` assigns variants itself, by the hosting platform's
 * rule (`experiments.node.ts`) over the conversation's own session id, so each conversation draws
 * its variants as a call would:
 *
 * - a page's `client.<fromClient>` naming a variant picks it, also when the page's info arrives
 *   after the conversation started;
 * - otherwise a conversation keeps a variant it has, so one restored after a reload (or rewound)
 *   keeps the variants it ran with;
 * - otherwise the session id draws it.
 *
 * A variant of an experiment the agent no longer declares is removed.
 */
export function previewExperimentUpdate(
  experiments: readonly ExperimentDeclaration[],
  sessionId: string,
  info: Readonly<Record<string, unknown>>,
): Record<string, string | undefined> {
  const client = pageInfoOf(info);
  const wanted = new Map<string, string>();
  for (const experiment of experiments) {
    const key = `${EXPERIMENT_INFO_PREFIX}${experiment.name}`;
    const kept = info[key];
    const declared = typeof kept === "string" && experiment.variants.some((variant) => variant.name === kept) ? kept : undefined;
    wanted.set(key, forcedVariant(experiment, client) ?? declared ?? drawnVariant(sessionId, experiment));
  }
  const update: Record<string, string | undefined> = {};
  for (const [key, variant] of wanted) if (info[key] !== variant) update[key] = variant;
  for (const key of Object.keys(info)) {
    if (key.startsWith(EXPERIMENT_INFO_PREFIX) && !wanted.has(key)) update[key] = undefined;
  }
  return update;
}

/**
 * Socket-agnostic per-connection orchestrator. Owns one runtime+session, maps
 * their changes to server frames via a `send` callback, and drives turns from
 * client messages. Knows nothing about `ws`, so it is fully unit-testable with
 * a fake `send` plus a mock LLM/providers.
 */
export class ConnectionController {
  private readonly send: (message: ServerMessage) => void;
  private runtime: AgentSiteRuntime;
  private session: AgentSession;
  private readonly agentHost?: AgentHost;
  private activeAgentId: string | null;
  /** Read-only shadow of the active agent for the preview's inspector — ONE
   * long-lived runtime per agent, so component state (a gate's login, a
   * procedure's progress) persists while the user browses. What stays
   * isolated is the VIEW: every frame compiles only the inspected skill
   * (runtime.isolatedContext), so tools never stack across skills. Created
   * with an unlimited loaded-skill window — browsing must not evict pages
   * (eviction would silently reset their state). Never the live session. */
  private inspectRuntime: AgentSiteRuntime | null = null;
  /** The skill the inspector is currently showing. */
  private inspectSkillPath: string | null = null;
  /** Every state-changing inspector action since the agent was selected, in
   * order. Undo = fresh runtime + full replay minus the LAST TOOL entry —
   * generic time travel with no per-tool undo handlers. MCP tool calls are
   * NOT recorded: they can't mutate runtime state and replaying them would
   * re-fire external side effects. */
  private inspectActions: Array<
    { kind: "skill"; path: string } | { kind: "tool"; name: string; input: Record<string, unknown> }
  > = [];
  private readonly mcp: McpManager;
  private readonly history?: ConversationHistory;
  private readonly voiceHost?: VoiceHostAdapter;
  /** The live call attached to this conversation, if any. Voice is a second
   * I/O modality of the SAME session: turns it runs land in the same
   * transcript the chat frames mirror. */
  private voiceCall: VoiceCallHandle | null = null;
  /** Serializes voice_start against a racing second voice_start. */
  private voiceStarting = false;
  /** Subscriptions tied to the CURRENT runtime/session — replaced on agent
   * switch. Global subscriptions (MCP) live in `globalUnsubscribers`. */
  private sessionUnsubscribers: Array<() => void> = [];
  private readonly globalUnsubscribers: Array<() => void> = [];
  /** Complete live session bundles retained for instant, stateful history
   * switching during this preview connection. Newest entries are appended. */
  private readonly conversations: RestorableConversation[];
  private activeConversationId: string;
  private nextConversationNumber = 2;
  private disposed = false;
  /** The page's own info (`client.*`, from set_info). Starting another conversation does not
   * change the page, so every conversation this connection starts carries it. */
  private readonly pageInfo: Record<string, unknown> = {};
  /** What the conversation `resume` opened could not bring back: said once `start()` has
   * sent the frames that show it. */
  private resumeNotice: string | null = null;

  constructor(send: (message: ServerMessage) => void, deps: ConnectionDeps) {
    this.send = send;
    this.runtime = deps.runtime;
    this.session = deps.session;
    this.agentHost = deps.agentHost;
    this.voiceHost = deps.voiceHost;
    this.activeAgentId = deps.agentHost?.initialId ?? null;
    this.mcp = deps.mcp ?? getMcpManager();
    this.history = deps.history;
    this.activeConversationId = "conversation-1";

    // Oldest first, so the frame's reverse puts the newest at the top with this
    // connection's own conversation above them all.
    const stored: RestorableConversation[] = (deps.history?.list(HISTORY_LIMIT) ?? [])
      .map((row) => {
        const recordedSystemPrompt = deps.history!.systemPrompt(row.id);
        return {
          id: `stored-${row.id}`,
          agentId: row.agentId,
          startedAt: Date.parse(String(row.startedAt)) || row.startedAt,
          call: newPreviewCall(),
          stored: deps.history!.messages(row.id),
          storedId: row.id,
          ...(recordedSystemPrompt === null ? {} : { recordedSystemPrompt }),
        };
      })
      .reverse();

    // Typed preview chat is a conversation like a call's: the agent reads its identity on
    // `useSession().call` before any voice is attached, the same way it will in production.
    const call = newPreviewCall();
    deps.runtime.bindCall(call);
    this.assignExperiments(deps, this.activeAgentId, call);
    this.conversations = [
      ...stored,
      {
        id: this.activeConversationId,
        agentId: this.activeAgentId,
        startedAt: Date.now(),
        call,
        bundle: { runtime: deps.runtime, session: deps.session },
      },
    ];
  }

  /** A fresh bundle for `agentId`, already carrying the conversation's call identity, so
   * nothing it renders or replays runs without one. */
  private async createBundle(agentId: string, call: CallView): Promise<AgentSessionBundle> {
    if (!this.agentHost) throw new Error("This host does not provide an agent registry.");
    const bundle = await this.agentHost.create(agentId);
    bundle.runtime.bindCall(call);
    return bundle;
  }

  /** The bundle of a NEW conversation: it starts with the page's info, as the first one did, and
   * draws its own experiment variants. */
  private async createConversationBundle(agentId: string, call: CallView): Promise<AgentSessionBundle> {
    const bundle = await this.createBundle(agentId, call);
    if (Object.keys(this.pageInfo).length > 0) bundle.session.updateInfo({ ...this.pageInfo });
    this.assignExperiments(bundle, agentId, call);
    return bundle;
  }

  /** Give the conversation on `bundle` its experiment variants. Through the session, as page
   * info is; `restored` applies them to the runtime only, as the restored conversation's own
   * state rather than a change the model is told about. */
  private assignExperiments(
    bundle: AgentSessionBundle,
    agentId: string | null,
    call: CallView,
    options: { restored?: boolean } = {},
  ): void {
    const update = this.experimentUpdate(agentId, call, bundle.runtime.info.snapshot());
    if (Object.keys(update).length === 0) return;
    if (options.restored) bundle.runtime.updateInfo(update);
    else bundle.session.updateInfo(update);
  }

  /** {@link previewExperimentUpdate} for the agent's declared experiments; `{}` on a host
   * without an agent registry, which knows no declarations. */
  private experimentUpdate(
    agentId: string | null,
    call: CallView,
    info: Readonly<Record<string, unknown>>,
  ): Record<string, string | undefined> {
    if (!this.agentHost || agentId === null) return {};
    return previewExperimentUpdate(this.agentHost.preview(agentId).experiments ?? [], call.sessionId, info);
  }

  /** Subscribe to runtime/session changes and push the initial snapshot. */
  start(): void {
    this.bindSession();
    // MCP servers connect/disconnect process-wide (dashboard actions from any
    // connection). Broadcast the status and recompile this session's context so
    // newly available tools appear without a restart.
    this.globalUnsubscribers.push(
      this.mcp.onChange(() => {
        this.send({ type: "mcp_servers", servers: this.mcp.summaries() });
        const contextDiff = this.runtime.refreshExternal();
        if (contextDiff.length > 0) {
          this.session.recordContextEvent(["New tools are available:", ...contextDiff.map((line) => `+ ${line}`)]);
        }
      }),
    );

    this.sendAgentsFrame();
    this.sendSessionSnapshot();
    this.sendConversationsFrame();
    this.send({ type: "mcp_servers", servers: this.mcp.summaries() });
    if (this.resumeNotice !== null) this.send({ type: "notice", message: this.resumeNotice });
    this.resumeNotice = null;
  }

  /**
   * Open the stored conversation `recordedId` as this connection's conversation, before
   * `start()`. The preview reconnects this way after `curb dev` reloaded the agent: the page
   * stays on its conversation, which now runs on the saved code, and the recording goes on
   * in the same stored conversation rather than a copy of it. When it cannot be opened the
   * connection keeps the fresh conversation it opened with, and says why.
   *
   * `info`: what the page already sent with `set_info` while this ran. The conversation is
   * restored with it, so it renders with the page's info from the start and the page's
   * `set_info` changes nothing the model has to be told about.
   */
  async resume(recordedId: number, info: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const conversation = this.conversations.find((candidate) => candidate.id === `stored-${recordedId}`);
    if (!conversation) {
      this.send(errorFrame("protocol", `Conversation ${recordedId} is not among the recorded ones; this is a new conversation.`));
      return;
    }
    this.rememberPageInfo(info);
    const notes = await this.materialise(conversation, { continueRecording: recordedId, info });
    if (notes === null) return;
    // The fresh conversation this connection opened with was never used: it leaves the list.
    const fresh = this.conversations.findIndex((candidate) => candidate.id === this.activeConversationId);
    if (fresh >= 0) this.conversations.splice(fresh, 1);
    this.runtime = conversation.bundle!.runtime;
    this.session = conversation.bundle!.session;
    this.activeAgentId = conversation.agentId;
    this.activeConversationId = conversation.id;
    this.resumeNotice = notes.length > 0 ? notes.join(" ") : null;
  }

  /** Keep the page's own info (`client.*`) for every conversation this connection opens. */
  private rememberPageInfo(values: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith(CLIENT_INFO_PREFIX)) this.pageInfo[key] = value;
    }
  }

  /** Subscribe to the current runtime/session (re-run after an agent switch). */
  private bindSession(): void {
    this.sessionUnsubscribers.push(
      this.runtime.subscribe(() => this.send(contextFrame(this.runtime))),
    );
    this.sessionUnsubscribers.push(
      this.session.subscribe(() => {
        this.send(messagesFrame(this.session));
        this.send(llmTraceFrame(this.session));
        this.send(runningFrame(this.session));
        this.sendConversationsFrame();
      }),
    );
    // Generation streams live into the UI for every turn — typed or spoken
    // (the voice pipeline drives the same session).
    this.sessionUnsubscribers.push(
      this.session.subscribeDeltas((text) => this.send({ type: "assistant_delta", text })),
    );
  }

  private sendSessionSnapshot(): void {
    this.send(contextFrame(this.runtime));
    this.send(messagesFrame(this.session));
    this.send(llmTraceFrame(this.session));
    this.send(runningFrame(this.session));
  }

  private sendAgentsFrame(): void {
    if (!this.agentHost || this.activeAgentId === null) return;
    this.send({
      type: "agents",
      agents: this.agentHost.ids,
      active: this.agentHost.preview(this.activeAgentId),
    });
  }

  /**
   * Turn a stored conversation into a live bundle, or explain why it could not be. Its
   * recorded state (open skills, store data, page info) and transcript are restored onto a
   * fresh runtime (`restoreConversation`), and none of its tool calls runs again: a booking
   * or an email happened once, when the conversation ran. Returns what could not be
   * restored, one note each, or null when nothing was.
   *
   * It needs the agent registry, to build a fresh runtime for the recorded agent, so a host
   * without one cannot restore, and says so instead of appearing to work and then answering
   * from an empty context.
   *
   * `continueRecording`: the stored id the restored session records into (see `resume`);
   * without it the session records a conversation of its own. `info`: the session info the
   * conversation is opened with (the page's), over the recorded page info.
   */
  private async materialise(
    conversation: RestorableConversation,
    options: { continueRecording?: number; info: Readonly<Record<string, unknown>> },
  ): Promise<string[] | null> {
    const agentId = conversation.agentId ?? this.activeAgentId;
    if (!this.agentHost || agentId === null) {
      this.send(
        errorFrame("protocol", "Opening a past conversation needs an agent registry, which this host does not provide."),
      );
      return null;
    }

    try {
      const bundle = await this.createBundle(agentId, conversation.call);
      // Before the transcript is restored onto it, so not one message goes to a new conversation.
      if (options.continueRecording !== undefined) {
        this.history?.continueRecording?.(bundle.session, options.continueRecording);
      }
      const state = conversation.storedId === undefined ? null : (this.history?.state?.(conversation.storedId) ?? null);
      const notes = restoreConversation(
        bundle,
        { messages: conversation.stored ?? [], state },
        { skillPaths: this.agentHost.preview(agentId).skills.map((skill) => skill.path), info: options.info },
      );
      this.assignExperiments(bundle, agentId, conversation.call, { restored: true });
      conversation.bundle = bundle;
      conversation.agentId = agentId;
      return notes;
    } catch (error) {
      this.send(errorFrame("llm", error instanceof Error ? error.message : String(error)));
      return null;
    }
  }

  private conversationSummary(conversation: RestorableConversation): ConversationSummary {
    // A stored conversation has no session to ask, and must not be given one just
    // to be listed — the transcript already carries everything a summary needs.
    const messages = conversation.bundle
      ? conversation.bundle.session.messages
      : (conversation.stored ?? []);
    const firstUserMessage = messages.find(
      (message) => message.role === "user" && message.kind === undefined,
    );
    const title = firstUserMessage?.content.trim() || "New conversation";
    return {
      id: conversation.id,
      agentId: conversation.agentId,
      startedAt: conversation.startedAt,
      title: title.length > 64 ? `${title.slice(0, 61).trimEnd()}...` : title,
      messageCount: messages.length,
    };
  }

  private sendConversationsFrame(): void {
    const recordedSystemPrompt = this.conversations.find(
      (conversation) => conversation.id === this.activeConversationId,
    )?.recordedSystemPrompt;
    this.send({
      type: "conversations",
      active: this.activeConversationId,
      conversations: [...this.conversations]
        .reverse()
        .map((conversation) => this.conversationSummary(conversation)),
      ...(recordedSystemPrompt === undefined ? {} : { recordedSystemPrompt }),
    });
  }

  /** The stored id of the conversation this connection is on, once it is recorded; null
   * before, and on a host without a conversation store. `curb dev` hands it to the page
   * when it reloads the agent, so the page comes back to this conversation (`resume`). */
  recordedConversationId(): number | null {
    return this.history?.recordedId?.(this.session) ?? null;
  }

  /** Replace the active bundle while keeping every inactive bundle alive for
   * later restoration. The inspector follows the active agent, not the
   * conversation, so it resets only when the agent changes. */
  private async activateConversation(conversation: RestorableConversation): Promise<void> {
    if (conversation.id === this.activeConversationId) {
      this.sendConversationsFrame();
      return;
    }
    if (this.session.isRunning) {
      this.send(errorFrame("protocol", "Cannot switch conversations while a turn is running."));
      return;
    }

    if (this.voiceCall || this.voiceStarting) await this.voiceStop();

    // MATERIALISE A STORED CONVERSATION ON FIRST OPEN: its recorded state goes back onto a
    // fresh runtime, so loaded skills and store data match where the conversation left off
    // and the next turn continues it rather than starting over.
    //
    // Left where it is on failure. A conversation that cannot be restored must not take
    // the live one down with it: the user is still in a working session.
    let notes: string[] = [];
    if (!conversation.bundle) {
      const restored = await this.materialise(conversation, { info: this.runtime.info.snapshot() });
      if (restored === null) return;
      notes = restored;
    }

    for (const unsubscribe of this.sessionUnsubscribers) unsubscribe();
    this.sessionUnsubscribers = [];

    const agentChanged = conversation.agentId !== this.activeAgentId;
    this.runtime = conversation.bundle!.runtime;
    this.session = conversation.bundle!.session;
    this.activeAgentId = conversation.agentId;
    this.activeConversationId = conversation.id;
    if (agentChanged) {
      this.inspectRuntime = null;
      this.inspectSkillPath = null;
      this.inspectActions = [];
    }

    this.bindSession();
    this.sendAgentsFrame();
    this.sendSessionSnapshot();
    this.sendConversationsFrame();
    if (notes.length > 0) this.send({ type: "notice", message: notes.join(" ") });
  }

  private async newConversation(): Promise<void> {
    if (!this.agentHost || this.activeAgentId === null) {
      // Single-session embedded hosts cannot construct a fresh runtime. Keep
      // their legacy reset behavior explicit while the preview host uses the
      // fully restorable path above.
      this.session.reset();
      return;
    }
    if (this.session.isRunning) {
      this.send(errorFrame("protocol", "Cannot start a new conversation while a turn is running."));
      return;
    }
    const call = newPreviewCall();
    let bundle: AgentSessionBundle;
    try {
      bundle = await this.createConversationBundle(this.activeAgentId, call);
    } catch (error) {
      this.send(errorFrame("llm", error instanceof Error ? error.message : String(error)));
      return;
    }
    const conversation: RestorableConversation = {
      id: `conversation-${this.nextConversationNumber++}`,
      agentId: this.activeAgentId,
      startedAt: Date.now(),
      call,
      bundle,
    };
    this.conversations.push(conversation);
    await this.activateConversation(conversation);
  }

  private async selectConversation(id: string): Promise<void> {
    const conversation = this.conversations.find((candidate) => candidate.id === id);
    if (!conversation) {
      this.send(errorFrame("protocol", `Unknown conversation "${id}".`));
      return;
    }
    await this.activateConversation(conversation);
  }

  /** Swap this connection to another agent: fresh runtime + session (the old
   * transcript stays with the old session), that agent's TTS voice, and a full
   * snapshot push so the client renders the new agent immediately. */
  private async selectAgent(id: string): Promise<void> {
    if (!this.agentHost) {
      this.send(errorFrame("protocol", "This server hosts a single agent — select_agent is unavailable."));
      return;
    }
    if (id === this.activeAgentId) {
      this.sendAgentsFrame();
      return;
    }
    if (!this.agentHost.ids.includes(id)) {
      this.send(
        errorFrame("protocol", `Unknown agent "${id}". Available: ${this.agentHost.ids.join(", ")}.`),
      );
      return;
    }

    let conversation = [...this.conversations]
      .reverse()
      .find((candidate) => candidate.agentId === id);
    if (!conversation) {
      const call = newPreviewCall();
      let bundle: AgentSessionBundle;
      try {
        bundle = await this.createConversationBundle(id, call);
      } catch (error) {
        // Keep the current session alive — a failed switch must not kill the connection.
        this.send(errorFrame("llm", error instanceof Error ? error.message : String(error)));
        return;
      }
      conversation = {
        id: `conversation-${this.nextConversationNumber++}`,
        agentId: id,
        startedAt: Date.now(),
        call,
        bundle,
      };
      this.conversations.push(conversation);
    }
    await this.activateConversation(conversation);
  }

  /** The persistent inspector runtime, created on first use. Session info is
   * seeded from the LIVE runtime so info-gated branches (e.g. a caller
   * banner) inspect the same way they render for the agent. */
  private async ensureInspectRuntime(): Promise<AgentSiteRuntime> {
    if (this.inspectRuntime) return this.inspectRuntime;
    this.inspectRuntime = await this.buildInspectRuntime();
    return this.inspectRuntime;
  }

  private async buildInspectRuntime(): Promise<AgentSiteRuntime> {
    if (!this.agentHost || this.activeAgentId === null) {
      throw new Error("Inspection is unavailable — this host does not provide an agent registry.");
    }
    const runtime = await this.agentHost.createRuntime(this.activeAgentId, {
      maxLoadedSkills: Number.MAX_SAFE_INTEGER,
    });
    const liveInfo = this.runtime.info.snapshot();
    if (Object.keys(liveInfo).length > 0) runtime.updateInfo({ ...liveInfo });
    return runtime;
  }

  private sendInspectFrame(runtime: AgentSiteRuntime, toolRun?: ToolRun): void {
    // Isolated VIEW: only the inspected skill's page (plus globals) — never
    // the whole loaded window, whose state nonetheless persists underneath.
    const path = this.inspectSkillPath ?? runtime.snapshot().context.path;
    const context = runtime.isolatedContext(path);
    this.send({
      type: "inspect_context",
      skill: path,
      context,
      // Navigating isn't a state change — only tool calls are undoable.
      canUndo: this.inspectActions.some((action) => action.kind === "tool"),
      ...(toolRun ? { toolRun } : {}),
    });
  }

  /** Handle one decoded client message. Errors are surfaced as `error` frames,
   * never swallowed. */
  async handle(message: ClientMessage): Promise<void> {
    if (this.disposed) return;
    switch (message.type) {
      case "user_text":
        // With a live call attached, typed input runs through the voice
        // pipeline so the reply is spoken; the transcript updates over this
        // socket either way (same session).
        if (this.voiceCall) {
          await this.voiceCall.sendText(message.text);
          return;
        }
        await this.runChatTurn(message.text);
        return;
      case "voice_start":
        await this.voiceStart();
        return;
      case "voice_stop":
        await this.voiceStop();
        return;
      case "read_skill": {
        const { contextDiff } = this.runtime.loadSkill(message.skill);
        this.session.recordContextEvent([
          `The user opened "${message.skill}" in the UI.`,
          ...(contextDiff.length > 0 ? ["Context changed:", ...contextDiff.map((line) => `+ ${line}`)] : []),
        ]);
        return;
      }
      case "inspect_skill":
        await this.inspectSkill(message.skill);
        return;
      case "call_tool":
        await this.callTool(message.name, message.input);
        return;
      case "inspect_undo":
        await this.inspectUndo();
        return;
      case "set_info": {
        this.rememberPageInfo(message.values);
        // The page's info can pick a variant (`fromClient`): one update, so one context event.
        const call = this.conversations.find((candidate) => candidate.id === this.activeConversationId)?.call;
        const next = { ...this.runtime.info.snapshot(), ...message.values };
        const variants = call ? this.experimentUpdate(this.activeAgentId, call, next) : {};
        this.session.updateInfo({ ...message.values, ...variants });
        return;
      }
      case "mcp_connect":
        await this.mcp.connectServer(message.id);
        return;
      case "mcp_disconnect":
        await this.mcp.disconnectServer(message.id);
        return;
      case "mcp_add":
        try {
          // Remote-only; auth defaults to OAuth, which hosted MCPs require.
          this.mcp.addServer({ id: message.id, url: message.url });
        } catch (error) {
          this.send(errorFrame("mcp", error instanceof Error ? error.message : String(error)));
          return;
        }
        await this.mcp.connectServer(message.id);
        return;
      case "mcp_remove":
        try {
          await this.mcp.removeServer(message.id);
        } catch (error) {
          this.send(errorFrame("mcp", error instanceof Error ? error.message : String(error)));
        }
        return;
      case "select_agent":
        await this.selectAgent(message.id);
        return;
      case "rewind":
        await this.rewindTo(message.index, message.rerun ?? true);
        return;
      case "reset":
        await this.newConversation();
        return;
      case "select_conversation":
        await this.selectConversation(message.id);
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    const call = this.voiceCall;
    this.voiceCall = null;
    // Fire-and-forget, so it MUST carry its own catch: an unhandled rejection
    // here takes the process down, and this runs while the connection is being
    // disposed — there is nobody left to tell.
    if (call) void call.close().catch((error) => this.reportCallCloseFailure(error));
    for (const unsubscribe of this.sessionUnsubscribers) unsubscribe();
    this.sessionUnsubscribers = [];
    for (const unsubscribe of this.globalUnsubscribers) unsubscribe();
    this.globalUnsubscribers.length = 0;
  }

  /** Attach voice to this conversation: same session, same transcript — the
   * browser gets a LiveKit ticket to join with. Idempotent while live. */
  private async voiceStart(): Promise<void> {
    if (!this.voiceHost || this.activeAgentId === null) {
      this.send(errorFrame("voice", "Voice is unavailable on this host."));
      return;
    }
    if (this.voiceCall) {
      const { transport, url, token, room } = this.voiceCall;
      this.send({ type: "voice_session", live: true, transport, url, token, room });
      return;
    }
    if (this.voiceStarting) return; // a start is already in flight
    this.voiceStarting = true;
    try {
      const call = await this.voiceHost.start({
        bundle: { runtime: this.runtime, session: this.session },
        agentId: this.activeAgentId,
        onClosed: () => {
          // Server-side end (hangup, room emptied): reflect it to the client.
          if (this.voiceCall) {
            this.voiceCall = null;
            this.send({ type: "voice_session", live: false });
          }
        },
      });
      if (this.disposed) {
        // Same reason as dispose(): nothing awaits this, so it owns its failure.
        void call.close().catch((error) => this.reportCallCloseFailure(error));
        return;
      }
      this.voiceCall = call;
      this.send({
        type: "voice_session",
        live: true,
        transport: call.transport,
        url: call.url,
        token: call.token,
        room: call.room,
      });
    } catch (error) {
      this.send(errorFrame("voice", error instanceof Error ? error.message : String(error)));
    } finally {
      this.voiceStarting = false;
    }
  }

  /** Detach voice (hang up); the conversation continues by text. */
  private async voiceStop(): Promise<void> {
    const call = this.voiceCall;
    this.voiceCall = null;
    this.send({ type: "voice_session", live: false });
    // Awaited, but a teardown failure must not fail the stop the user asked for:
    // the call is already gone from this connection either way.
    if (call) await call.close().catch((error) => this.reportCallCloseFailure(error));
  }

  /** A voice call that would not close cleanly. Never fatal: by the time this
   * runs the call is over and unreachable, so the only useful thing left is to
   * say what was left behind. */
  private reportCallCloseFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.send(errorFrame("voice", `The call did not close cleanly: ${detail}`));
  }

  /** One streamed chat turn. Deltas reach the client via the session's
   * delta subscription (bindSession) — shared with voice-driven turns. A
   * message sent while a turn runs waits in the session's queue; a refused or
   * failed turn becomes an error frame carrying the real cause (the caller hears a
   * fixed line in the agent's language; the transcript records no reply for it). */
  private async runChatTurn(text: string): Promise<void> {
    for await (const event of this.session.runTurnStream(text)) {
      if (event.type !== "error") continue;
      this.send(errorFrame(event.error.kind === "busy" ? "protocol" : "llm", event.error.message));
    }
  }

  /**
   * Rewind to the user message at `index`: everything from that message on
   * is dropped, and the environment is reverted by replaying the EARLIER
   * turns' tool calls onto a fresh runtime. With `rerun` the message is then
   * re-run — it stays in the conversation and gets a fresh answer (retry);
   * without it the message is dropped too so the user can rewrite it
   * (rollback). MCP tools are NOT re-executed during replay (their side
   * effects are external; the transcript keeps their original results);
   * anything skipped is surfaced as an error frame, never silent.
   */
  private async rewindTo(index: number, rerun: boolean): Promise<void> {
    if (!this.agentHost || this.activeAgentId === null) {
      this.send(errorFrame("protocol", "Rewind is unavailable — this host does not provide an agent registry."));
      return;
    }
    // A live call may be mid-reply — cut the speech so the rewound state
    // isn't narrated over. The curb turn unwinds via the stream's cancel.
    this.voiceCall?.interrupt();
    if (this.session.isRunning) {
      this.send(errorFrame("protocol", "Cannot rewind while a turn is running."));
      return;
    }
    const messages = this.session.messages;
    const target = messages[index];
    if (!target || target.role !== "user" || target.kind === "context_event") {
      this.send(errorFrame("protocol", `Rewind index ${index} is not a user message.`));
      return;
    }

    // Still the same conversation, so still the same call: its identity moves to the rebuilt
    // runtime before the earlier turns replay onto it.
    const call = this.conversations.find((candidate) => candidate.id === this.activeConversationId)?.call;
    if (!call) throw new Error(`curb: the active conversation ${this.activeConversationId} is not on this connection.`);
    let bundle: AgentSessionBundle;
    let skipped: string[];
    try {
      const rebuilt = await rebuildSessionAt({
        create: (id) => this.createBundle(id, call),
        agentId: this.activeAgentId,
        sourceMessages: messages,
        index,
        liveInfo: this.runtime.info.snapshot(),
      });
      bundle = rebuilt.bundle;
      skipped = rebuilt.skipped;
    } catch (error) {
      // Keep the current session alive — a failed rewind must not kill it.
      this.send(errorFrame("llm", error instanceof Error ? error.message : String(error)));
      return;
    }

    if (skipped.length > 0) {
      this.send(
        errorFrame(
          "tool",
          `Rewind could not replay: ${[...new Set(skipped)].join(", ")} — external (MCP), confirmed by the caller, or no longer available. The context may differ from the original run.`,
        ),
      );
    }

    for (const unsubscribe of this.sessionUnsubscribers) unsubscribe();
    this.sessionUnsubscribers = [];
    this.runtime = bundle.runtime;
    this.session = bundle.session;
    // A live call keeps running — on the rebuilt session.
    this.voiceCall?.setBundle(bundle);
    this.bindSession();
    this.sendSessionSnapshot();

    // Retry: re-run the rewound message — it stays in the conversation and
    // gets a fresh answer from the reverted environment (spoken, when a call
    // is live). Rollback skips this; the client refills the input so the
    // user can rewrite the message.
    if (rerun) {
      if (this.voiceCall) await this.voiceCall.sendText(target.content);
      else await this.runChatTurn(target.content);
    }
  }

  /** Show a skill: load it on the PERSISTENT inspector runtime (state in
   * already-loaded pages survives — a login stays a login) and send the
   * isolated view. The agent session is untouched. */
  private async inspectSkill(skill: string): Promise<void> {
    try {
      const runtime = await this.ensureInspectRuntime();
      // "" is the agent level: agent.tsx alone, always there, nothing to load or replay.
      if (skill !== "") {
        runtime.loadSkill(skill);
        this.inspectActions.push({ kind: "skill", path: skill });
      }
      this.inspectSkillPath = skill;
      this.sendInspectFrame(runtime);
    } catch (error) {
      this.send(errorFrame("protocol", error instanceof Error ? error.message : String(error)));
    }
  }

  /** Run a UI tool form on the INSPECTOR runtime. The result comes back as a
   * fresh inspect frame carrying the run (`toolRun`: what the tool returned or
   * why it failed, and how long it took); the agent session and its transcript
   * never see it. */
  private async callTool(name: string, input: Record<string, unknown>): Promise<void> {
    try {
      const runtime = await this.ensureInspectRuntime();
      const definition = runtime.snapshot().context.tools.find((tool) => tool.name === name);
      const started = performance.now();
      const { result } = await runtime.callTool(name, input);
      const toolRun = toolRunOf(name, result, performance.now() - started);
      // MCP tools can't mutate runtime state and must not be re-fired on an
      // undo replay — only authored/runtime tools enter the undo log.
      if (!definition?.id.startsWith("mcp:")) {
        this.inspectActions.push({ kind: "tool", name, input });
      }
      this.sendInspectFrame(runtime, toolRun);
    } catch (error) {
      this.send(errorFrame("tool", error instanceof Error ? error.message : String(error)));
    }
  }

  /** Revert the last TOOL call: rebuild a fresh inspector runtime and replay
   * the full action log (navigations included, so page state reconstructs in
   * order) minus that entry. Generic — works for any state a tool flipped
   * (logins, procedure progress, ...) without per-tool undo handlers. */
  private async inspectUndo(): Promise<void> {
    try {
      let lastTool = -1;
      for (let index = this.inspectActions.length - 1; index >= 0; index -= 1) {
        if (this.inspectActions[index].kind === "tool") {
          lastTool = index;
          break;
        }
      }
      if (lastTool === -1) {
        if (this.inspectRuntime) this.sendInspectFrame(this.inspectRuntime);
        return;
      }
      const replay = this.inspectActions.filter((_, index) => index !== lastTool);
      const runtime = await this.buildInspectRuntime();
      for (const action of replay) {
        if (action.kind === "skill") {
          runtime.loadSkill(action.path);
        } else {
          await runtime.callTool(action.name, action.input);
        }
      }
      this.inspectActions = replay;
      this.inspectRuntime = runtime;
      this.sendInspectFrame(runtime);
    } catch (error) {
      this.send(errorFrame("protocol", error instanceof Error ? error.message : String(error)));
    }
  }
}

/** A test run as its frame reports it: the result the tool returned, or why it failed. A tool
 * that throws reaches here as a failed result too: the runtime turns the throw into the
 * failure the model would read. */
function toolRunOf(name: string, result: ToolResult, durationMs: number): ToolRun {
  const ms = Math.round(durationMs);
  if (result.ok) return { name, result, durationMs: ms };
  return { name, error: result.message ?? `${name} failed without a message.`, durationMs: ms };
}

export { ProtocolError };
