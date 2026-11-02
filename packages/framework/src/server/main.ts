import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { Room } from "@livekit/rtc-node";
import { AgentAuthoringError, type AuthoringDiagnostic } from "../authoring.js";
import { getMcpManager, setMcpOAuthCallbackUrl, setMcpOAuthSignInUrl } from "../mcp/manager.js";
import { createAgentRuntime, ensureHostPrerequisites, getHostedAgent, listAgentIds } from "./bootstrap.js";
import {
  ConnectionController,
  type AgentSessionBundle,
  type ConversationHistory,
  type VoiceHostAdapter,
} from "./connection.js";
import type { AgentSession } from "../agent-session.js";
import { conversationState } from "./conversation-restore.js";
import {
  continueRecordedConversation,
  describeConversationStore,
  detachConversationRecorder,
  getConversationHistoryStore,
  getConversationSink,
  keepConversationState,
  loadConfiguredConversationSink,
  recordedConversationId,
} from "./conversation-store.js";
import { AGENT_HTTP_PATHS } from "./agent-http-paths.js";
import { ServerActivity, type ServerActivityCounts } from "./activity.js";
import { printBootBanner, type BootBanner } from "./banner.js";
import { listenPlan, listenWithPortWalk, type ListenPlan } from "./listen.js";
import { previewAgent } from "./frames.js";
import {
  parseClientMessage,
  serializeServerMessage,
  ProtocolError,
  type ClientMessage,
  type PreviewAgent,
  type ServerMessage,
} from "./protocol.js";
import { s2sCredentialDiagnostic } from "../s2s-diagnostics.js";
import type { AgentSiteRuntime } from "../runtime.js";
import { describeMissingVoiceEnv } from "./voice/providers.js";
import type { ProviderSettings } from "../session-settings.js";
import { synthesizeWav } from "./voice/synthesize.js";
import { VoiceProviderError } from "./voice/providers.js";
import type { VoiceCallRoom } from "./voice/call-room.js";
import { startVoiceAgent } from "./voice/livekit-host/host.js";
import { livekitCallRoom } from "./voice/livekit-host/livekit-call-room.js";
import { attachClientMessages, type ClientMessageBridge } from "./voice/livekit-host/messages.js";
import { openLivekitRoom, type LivekitRoomTicket } from "./voice/livekit-host/rooms.js";
import { LocalVoiceCalls } from "./voice/local-host/local-call-room.js";
import type { VoiceSessionHandle } from "./voice/orchestration.js";
import type { VoiceTransport } from "./protocol.js";
import { llmCredentialDiagnostic } from "../llm/ai-sdk.js";
import { createPreviewAgentBundle, createVoiceAgentBundle } from "../voice-host.js";
import type { CallRegistrar } from "../hosted/call-link.js";
import { openCallManagement, serveCall } from "../hosted/serve-call.js";
import { logError, logInfo } from "./log.js";
import { CURB_MARK } from "../brand.js";

function oauthResultPage(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family: system-ui; display: grid; place-items: center; height: 100vh; margin: 0">
<div style="text-align: center">${CURB_MARK}<h1 style="font-size: 1.2rem">${title}</h1><p>${detail}</p></div></body>`;
}

/** OAuth redirect target for MCP servers. The provider registered this exact
 * URL, the user approves in the browser, and the code lands here. */
async function handleOAuthCallback(url: URL, res: ServerResponse): Promise<void> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(oauthResultPage("Authorization failed", `The server reported: ${oauthError}`));
    return;
  }
  if (!code || !state) {
    res.writeHead(400, { "content-type": "text/html" });
    res.end(oauthResultPage("Authorization failed", "Missing code or state parameter."));
    return;
  }

  try {
    const serverId = await getMcpManager().finishOAuth(state, code);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      oauthResultPage(
        "Connected",
        `MCP server "${serverId}" is authorized. You can close this window.`,
      ),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError("ws", `oauth callback failed: ${detail}`);
    res.writeHead(500, { "content-type": "text/html" });
    res.end(oauthResultPage("Authorization failed", detail));
  }
}

/** The dashboard's Sign in for MCP server `?server=<id>`: the sign-in is in progress from now
 * (a `curb dev` reload waits for it), and the browser goes on to the provider's login. */
function handleOAuthSignIn(url: URL, res: ServerResponse): void {
  const target = getMcpManager().openSignIn(url.searchParams.get("server") ?? "");
  if (target === null) {
    res.writeHead(404, { "content-type": "text/html" });
    res.end(oauthResultPage("Nothing to sign in to", "No MCP server is waiting for this sign-in. Press Sign in in the preview again."));
    return;
  }
  res.writeHead(302, { location: target });
  res.end();
}

/** One-shot text → WAV for the preview's per-message Play/WAV buttons.
 * Body: JSON { text }. Speaks with the default agent's tts as it renders at session start. */
async function handleTtsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  settings: ProviderSettings | Error,
): Promise<void> {
  const MAX_BODY = 64 * 1024;
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("Request body too large.");
        return;
      }
      parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as { text?: unknown };
    if (typeof body.text !== "string") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end('Expected JSON body { "text": "…" }.');
      return;
    }
    // The agent did not render at boot, so there is no voice to speak with: say why.
    if (settings instanceof Error) throw new VoiceProviderError(settings.message);
    const wav = await synthesizeWav(body.text, settings.tts);
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
    res.end(wav);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error instanceof VoiceProviderError ? 503 : error instanceof SyntaxError ? 400 : 500;
    logError("tts", `synthesis failed: ${message}`);
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(message);
  }
}

/** Live voice conversations by room — serves the per-message debug clips. */
const voiceRooms = new Map<string, VoiceSessionHandle>();

/** GET /voice/clip?room=…&role=user|assistant&ordinal=N — the exact audio of
 * the N-th (0-based) user/assistant message: what STT heard / what TTS said. */
function handleVoiceClipRequest(url: URL, res: ServerResponse): void {
  const room = url.searchParams.get("room") ?? "";
  const role = url.searchParams.get("role");
  const ordinal = Number(url.searchParams.get("ordinal"));
  const handle = voiceRooms.get(room);
  if (!handle || (role !== "user" && role !== "assistant") || !Number.isInteger(ordinal)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Unknown room, role, or ordinal.");
    return;
  }
  const wav = handle.clips.wav(role, ordinal);
  if (!wav) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("No audio captured for this message (evicted, or not spoken).");
    return;
  }
  res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
  res.end(wav);
}

/** One browser call's transport: the call the voice session serves, and how the page joins. */
type BrowserCall = {
  transport: VoiceTransport;
  room: VoiceCallRoom;
  client: ClientMessageBridge;
  url: string;
  token: string;
  /** The call is over: forget it. */
  ended(): void;
};

/**
 * The preview page is not a client app: it has no `curb.message` / `curb.update` channel on a
 * local call. App messages for the client then go where a text-only conversation's go.
 */
const NO_CLIENT_APP: ClientMessageBridge = { bind: () => undefined, detach: () => undefined };

/** The agent's side of a LiveKit room `ticket` names, joined. */
/** Why no call can start on these settings: an `<Agent s2s>` needs its model, any other agent
 * its speech providers. */
function callEnvIssue(settings: Pick<AgentSiteRuntime["settings"], "current" | "s2s">): string | null {
  const s2s = settings.s2s();
  if (!s2s) return describeMissingVoiceEnv(settings.current());
  const issue = s2sCredentialDiagnostic(s2s, process.env);
  return issue && `${issue.message} ${issue.fix}`;
}

async function joinLivekitRoom(ticket: LivekitRoomTicket): Promise<BrowserCall> {
  const room = new Room();
  await room.connect(ticket.agent.url, ticket.agent.token, { autoSubscribe: true, dynacast: false });
  return {
    transport: "livekit",
    room: livekitCallRoom(room, ticket.room),
    // The browser can call the agent as soon as it is in the room; the session binds this.
    client: attachClientMessages(room, { roomName: ticket.room }),
    url: ticket.caller.url,
    token: ticket.caller.token,
    ended: () => undefined,
  };
}

/** A call over the page's own socket, waiting for the page to attach on the local voice path. */
function openLocalCall(calls: LocalVoiceCalls): BrowserCall {
  const call = calls.open();
  const query = new URLSearchParams({ call: call.id, token: call.token });
  return {
    transport: "local",
    room: call.room,
    client: NO_CLIENT_APP,
    url: `${AGENT_HTTP_PATHS.localVoice}?${query}`,
    token: call.token,
    ended: () => calls.close(call.id),
  };
}

/** Voice attach for one connection's conversation: run the voice session on a call as the
 * agent, running turns on the CONNECTION's own session (one transcript, one authored
 * prompt — spoken turns add the speech rules per turn). Returns the browser's ticket plus
 * the live-call controls.
 *
 * The session is the framework's voice host, the same one `curb start` and every hosted
 * runner use; a project's `src/orchestration/` is never loaded. The conversation already
 * carries its call identity (`useSession().call`, bound by the connection).
 *
 * The call is a LiveKit room when the environment names a LiveKit (`openRoom`,
 * `livekit-host/rooms.ts`: minted on `LIVEKIT_URL`, or handed over by a realtime session),
 * and the page's own socket otherwise (`voice/local-host/`), which is `curb dev`'s default.
 *
 * With a management port (`CURB_MANAGEMENT_ADDR` + `CURB_MANAGEMENT_TOKEN`), every call is
 * registered on it under its room name, so a host under development can reach it.
 *
 * Every call counts in `activity` from the moment it is asked for until it ends: a
 * `curb dev` reload waits for it. */
const createVoiceHostAdapter = (options: {
  registrar: CallRegistrar | null;
  openRoom: () => Promise<LivekitRoomTicket | null>;
  localCalls: LocalVoiceCalls;
  activity: ServerActivity;
}): VoiceHostAdapter => ({
  start: async ({ bundle, agentId, onClosed }) => {
    // `curb dev` shows an agent whose LLM has no key; a call on it could only apologise.
    const llmIssue = llmCredentialDiagnostic(bundle.runtime.settings.current().llm);
    if (llmIssue) throw new Error(`${llmIssue.message} ${llmIssue.fix}`);
    const voiceEnvIssue = callEnvIssue(bundle.runtime.settings);
    if (voiceEnvIssue) throw new Error(voiceEnvIssue);
    // Counted before the room exists: a reload must not cut a call that is still opening.
    const callKey = randomUUID();
    options.activity.callStarted(callKey);
    try {
      const ticket = await options.openRoom();
      const hosted = await getHostedAgent(agentId);
      const browserCall = ticket ? await joinLivekitRoom(ticket) : openLocalCall(options.localCalls);
      const { room, client } = browserCall;
      const roomName = room.name;
      let handle: VoiceSessionHandle;
      try {
        handle = await serveCall({ sessionId: roomName, bundle, registrar: options.registrar }, (call) =>
          startVoiceAgent({
            room,
            roomName,
            bundle,
            firstTurn: hosted.definition.firstTurn,
            pipeline: hosted.definition.pipeline,
            client,
            ...(call.reporter === undefined ? {} : { reporter: call.reporter }),
            // Keep clips reachable for a while after hangup — the transcript stays
            // on screen and its play buttons must keep working.
            onClosed: () => {
              call.onClosed();
              browserCall.ended();
              options.activity.callEnded(callKey);
              setTimeout(() => voiceRooms.delete(roomName), 10 * 60 * 1000).unref();
              onClosed();
            },
          }),
        );
      } catch (error) {
        client.detach();
        browserCall.ended();
        try {
          await room.disconnect();
        } catch (disconnectError) {
          throw new AggregateError(
            [error, disconnectError],
            `Voice session ${roomName} failed to start and its call failed to disconnect.`,
          );
        }
        throw error;
      }
      voiceRooms.set(roomName, handle);
      return {
        transport: browserCall.transport,
        url: browserCall.url,
        token: browserCall.token,
        room: roomName,
        sendText: handle.sendText,
        setBundle: handle.setBundle,
        interrupt: handle.interrupt,
        close: handle.close,
      };
    } catch (error) {
      options.activity.callEnded(callKey);
      throw error;
    }
  },
});

/** Everything one connection needs for one agent: runtime + session bound to
 * that agent's model. Every session carries the framework's spoken-reply
 * rules as a per-turn suffix — applied only when a turn is spoken; the
 * authored `<SystemPrompt>` itself is never touched. */
async function buildAgentBundle(agentId?: string): Promise<AgentSessionBundle & { id: string }> {
  const { runtime, session, agentId: id } = await createVoiceAgentBundle(agentId);
  return { id, runtime, session };
}

/**
 * `curb dev`'s bundle: built even when the agent's LLM has no key in this process, so the
 * page shows what the agent is (its context renders from source and needs no model), with
 * the missing key as a banner. `curb server` refuses such a session instead.
 */
async function buildPreviewAgentBundle(
  agentId: string,
): Promise<AgentSessionBundle & { id: string; missingLlmKey: AuthoringDiagnostic | null }> {
  const { runtime, session, agentId: id, missingLlmKey } = await createPreviewAgentBundle(agentId);
  return { id, runtime, session, missingLlmKey };
}

/**
 * Set by `curb dev`'s child process (`cli/dev-child.ts`): the server runs behind the
 * supervisor that owns the preview's port, which restarts it when the project's files
 * change.
 */
export type DevServerLink = {
  /** The preview's base URL, where the MCP OAuth callback lands (the supervisor forwards it). */
  publicUrl: string;
  /** Live calls, running replies and MCP sign-ins in progress, whenever one changes: a
   * reload waits for them. */
  onActivity: (counts: ServerActivityCounts) => void;
  /** Print no boot lines (diagnostics, conversation store): a reload is one line, which the
   * supervisor prints. */
  quiet: boolean;
};

/** How the agent server came up, for a supervisor that reports it itself. */
export type AgentServerReport = {
  banner: BootBanner;
  /** Error and warning counts of the default agent's authoring diagnostics. */
  errors: number;
  warnings: number;
  /** Why the default agent does not render, or null when it does. */
  renderError: string | null;
  /** The conversation store in force (`describeConversationStore`): `curb dev` names it again
   * when a reload changed it. */
  conversationStore: string;
};

export type AgentServer = {
  /** Bind and, outside `curb dev`, print the boot banner. */
  listen(): Promise<void>;
  /** The bound base URL — meaningful after listen() resolves (the default
   * port walks when taken). */
  url(): string;
  /** The bound port, after listen() resolved. */
  port(): number;
  report(): AgentServerReport;
  /** Send `message` to every connected page. */
  broadcast(message: ServerMessage): void;
  /**
   * `curb dev` reloads the agent: tell every page (with the stored conversation it is on, to
   * come back to), close their sockets, finish every conversation recording, stop serving.
   */
  reload(files: string[]): Promise<void>;
};

/**
 * Build the agent host: ONE server on ONE port multiplexing everything the
 * framework serves: chat WS (any path), voice WS (/voice) and the agent's HTTP routes
 * (`AGENT_HTTP_PATHS`). Under `curb dev` it runs behind the supervisor (`cli/dev.ts`),
 * which serves the preview on the public port and forwards the agent's paths here.
 */
export async function createAgentServer(options: { dev?: DevServerLink } = {}): Promise<AgentServer> {
  const { dev } = options;
  const plan: ListenPlan = dev ? { host: "127.0.0.1", port: 0, explicit: true } : listenPlan();
  /** The port actually bound: the planned one until listen() resolves. */
  let boundPort = plan.port;
  const publicUrl = () => dev?.publicUrl ?? `http://${plan.host}:${boundPort}`;
  const setOAuthUrls = () => {
    setMcpOAuthCallbackUrl(`${publicUrl()}${AGENT_HTTP_PATHS.oauthCallback}`);
    setMcpOAuthSignInUrl(`${publicUrl()}${AGENT_HTTP_PATHS.oauthSignIn}`);
  };
  // Must be set before MCP preload so OAuth servers know their redirect URL.
  // Re-set in listen() once the actual port is known (it may differ from
  // the planned one when the default port was taken); OAuth flows read it lazily.
  setOAuthUrls();

  // Discover agents + connect MCP once up-front so the first connection
  // doesn't pay the cost and misconfiguration surfaces at boot rather than
  // mid-conversation.
  const discovered = await ensureHostPrerequisites({ quiet: dev?.quiet ?? false });
  // What the preview page shows of each agent, as data. The page never imports the agent's
  // modules: they run here, under Node, where a skill may import node:crypto.
  const previews = new Map(discovered.map((agent) => [agent.id, previewAgent(agent)]));
  const previewOf = (id: string): PreviewAgent => {
    const preview = previews.get(id);
    if (!preview) throw new Error(`Unknown agent "${id}". Available: ${[...previews.keys()].join(", ")}.`);
    return preview;
  };
  // Same reason as the line above: a conversation sink named by configuration is
  // imported here so a bad path fails at boot, not on the first recorded message.
  await loadConfiguredConversationSink();
  // The file store opens here for the same reason: a path it refuses, such as the SQLite file
  // of an older curb, would otherwise boot and then fail every conversation.
  getConversationSink();
  // One line naming where transcripts go. A dropped or misspelled KUGEL_CONVERSATION_SINK
  // does not fail, it records to the file default, and this line is where that shows.
  if (!dev?.quiet) logInfo("curb", `conversation store: ${describeConversationStore()}`);
  const agentIds = await listAgentIds();
  const defaultAgent = await getHostedAgent();
  // The default agent's providers as a fresh session renders them, for the boot banner's
  // voice check and the preview's Play buttons. An agent that does not render keeps the
  // server up (the preview shows the diagnostics); both places then report the error.
  let defaultCallIssue: string | null = null;
  const defaultSettings: ProviderSettings | Error = await createAgentRuntime().then(
    ({ runtime }) => {
      defaultCallIssue = callEnvIssue(runtime.settings);
      return runtime.settings.current();
    },
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  // The host protocol's management port, when configured: calls are registered on it as
  // they start. Opened before the first connection can start a call.
  const management = await openCallManagement({ log: (message) => logError("host", message) });
  const activity = new ServerActivity(dev?.onActivity);
  // An MCP sign-in the user opened holds a reload until the provider called back: the
  // callback must reach the process that holds the flow it belongs to.
  const mcp = getMcpManager();
  mcp.onChange(() => activity.signInsInProgress(mcp.signInsInProgress().length));
  // Browser calls without a LiveKit run on the page's socket, attached on the local voice path.
  const localCalls = new LocalVoiceCalls();
  const voiceHostAdapter = createVoiceHostAdapter({
    registrar: management?.registrar ?? null,
    // The environment as it is now: `curb dev` loads the project's .env into this process.
    openRoom: () => openLivekitRoom(process.env),
    localCalls,
    activity,
  });
  /** Conversation recordings being finished after their page left; reload() waits for them. */
  const finishing = new Set<Promise<void>>();
  /** Each page's connection, once its conversation is set up. */
  const controllers = new Map<WebSocket, ConnectionController>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${plan.host}:${boundPort}`}`);
    if (url.pathname === AGENT_HTTP_PATHS.oauthCallback) {
      void handleOAuthCallback(url, res);
      return;
    }
    if (url.pathname === AGENT_HTTP_PATHS.oauthSignIn) {
      handleOAuthSignIn(url, res);
      return;
    }
    if (url.pathname === AGENT_HTTP_PATHS.tts && req.method === "POST") {
      void handleTtsRequest(req, res, defaultSettings);
      return;
    }
    if (url.pathname === AGENT_HTTP_PATHS.voiceClip) {
      handleVoiceClipRequest(url, res);
      return;
    }
    // TEMPORARY: browser-side reply-playback transitions, so the preview's
    // render state can be read on the same timeline as the voice pipeline.
    // Diagnosing "the first words render inked" from the server log alone is
    // guesswork — the phase lives in the browser and nothing else reports it.
    if (url.pathname === AGENT_HTTP_PATHS.voicePhase) {
      logInfo("voice", `preview phase ${url.searchParams.get("p") ?? "?"}`);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  // noServer mode: every upgrade is a page's WebSocket. Under `curb dev` Vite's HMR socket
  // never reaches this server: the supervisor hands that path to Vite on the preview's port.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname === AGENT_HTTP_PATHS.localVoice) {
      localCalls.upgrade(wss, request, socket, head);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const context: ConnectionContext = {
    dev: dev !== undefined,
    agentIds,
    defaultAgentId: defaultAgent.id,
    renderError: defaultSettings instanceof Error ? defaultSettings : null,
    voiceHostAdapter,
    preview: previewOf,
    activity,
    finishing,
    controllers,
  };
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    void handleConnection(socket, request, context);
  });

  wss.on("error", (error) => {
    logError("ws", `server error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

  const banner = (): BootBanner => ({
    agentIds,
    defaultAgentId: defaultAgent.id,
    voiceIssue:
      defaultSettings instanceof Error
        ? `the agent does not render: ${defaultSettings.message}`
        : defaultCallIssue,
    management: management?.address ?? null,
    hasMcp: (defaultAgent.definition.mcpServers?.length ?? 0) > 0,
  });

  return {
    url() {
      return `http://${plan.host}:${boundPort}`;
    },
    port() {
      return boundPort;
    },
    report() {
      const errors = defaultAgent.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
      return {
        banner: banner(),
        errors,
        warnings: defaultAgent.diagnostics.length - errors,
        renderError: defaultSettings instanceof Error ? defaultSettings.message : null,
        conversationStore: describeConversationStore(),
      };
    },
    async listen() {
      boundPort = await listenWithPortWalk(httpServer, plan);
      // OAuth flows read the callback URL lazily, so correcting it after the walk is
      // safe — no flow can start before listen().
      setOAuthUrls();
      if (!dev) printBootBanner({ url: `http://${plan.host}:${boundPort}`, preview: false, banner: banner() });
    },
    broadcast(message) {
      const frame = serializeServerMessage(message);
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(frame);
      }
    },
    async reload(files) {
      for (const client of wss.clients) {
        if (client.readyState !== client.OPEN) continue;
        const resume = controllers.get(client)?.recordedConversationId() ?? null;
        client.send(
          serializeServerMessage({ type: "dev_reload", state: "reloading", files, ...(resume === null ? {} : { resume }) }),
        );
      }
      await Promise.all(
        [...wss.clients].map(
          (client) =>
            new Promise<void>((resolve) => {
              if (client.readyState === client.CLOSED) {
                resolve();
                return;
              }
              client.once("close", () => resolve());
              // 1012: service restart. A page that does not answer the close is cut.
              client.close(1012, "The agent is reloading.");
              setTimeout(() => client.terminate(), 1_000).unref();
            }),
        ),
      );
      await Promise.all([...finishing]);
      await management?.close();
      httpServer.close();
      httpServer.closeAllConnections();
    },
  };
}

/** What every connection of one server shares. */
type ConnectionContext = {
  /** Behind `curb dev`'s supervisor, which reloads the agent on save. */
  dev: boolean;
  agentIds: string[];
  defaultAgentId: string;
  /** Why the default agent did not render at boot: every conversation would fail the same way. */
  renderError: Error | null;
  voiceHostAdapter: VoiceHostAdapter;
  preview: (id: string) => PreviewAgent;
  activity: ServerActivity;
  finishing: Set<Promise<void>>;
  controllers: Map<WebSocket, ConnectionController>;
};

/** `?resume=<id>` on the page's WebSocket URL: the stored conversation it was on. */
function resumeIdFrom(request: IncomingMessage): number | null {
  const raw = new URL(request.url ?? "/", "http://localhost").searchParams.get("resume");
  const id = Number(raw);
  return raw !== null && Number.isInteger(id) && id > 0 ? id : null;
}

/** The default agent's authoring errors: where a conversation that could not start failed.
 * Never rejects; the agent was discovered at boot. */
async function agentErrors(agentId: string): Promise<AuthoringDiagnostic[]> {
  const agent = await getHostedAgent(agentId).catch(() => null);
  return agent?.diagnostics.filter((diagnostic) => diagnostic.severity === "error") ?? [];
}

/** The session info the page sent among `frames` (`set_info`, merged in order). A frame that
 * does not parse is left out here; it is reported when it is handled. */
function infoSentIn(frames: ReadonlyArray<{ data: RawData; isBinary: boolean }>): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  for (const { data, isBinary } of frames) {
    if (isBinary) continue;
    let message: ClientMessage;
    try {
      message = parseClientMessage(data.toString());
    } catch {
      // KEEP-JUSTIFIED: the frame is dispatched after the conversation starts, which reports it.
      continue;
    }
    if (message.type === "set_info") Object.assign(info, message.values);
  }
  return info;
}

async function handleConnection(
  socket: WebSocket,
  request: IncomingMessage,
  context: ConnectionContext,
): Promise<void> {
  /** This connection, as the owner of a running reply in the activity counts. */
  const owner = {};
  const send = (message: ServerMessage) => {
    if (message.type === "running") context.activity.turnRunning(owner, message.value);
    if (socket.readyState === socket.OPEN) {
      socket.send(serializeServerMessage(message));
    }
  };

  // Every session this connection creates (new conversations, agent switches, rewinds).
  // When the connection ends, so do they, and each one's conversation recording is
  // finished: a last retry of any write the sink refused, then an error-level report of
  // whatever it still refuses.
  const sessions: AgentSession[] = [];
  const build = async (agentId: string) => {
    let bundle: AgentSessionBundle & { id: string };
    if (context.dev) {
      const preview = await buildPreviewAgentBundle(agentId);
      // Before the frames that show the agent: the page knows from the start that it cannot answer.
      send({ type: "missing_keys", agentId: preview.id, diagnostics: preview.missingLlmKey ? [preview.missingLlmKey] : [] });
      bundle = preview;
    } else {
      bundle = await buildAgentBundle(agentId);
    }
    sessions.push(bundle.session);
    // Recorded with the transcript, after every turn: a reload, or the conversation list,
    // continues the conversation from it without running its tools again.
    keepConversationState(bundle.session, () => conversationState(bundle.runtime, bundle.session));
    return bundle;
  };
  const endRecordings = () => {
    // Never rejects: detach logs and counts its own failures, and the socket is gone.
    const ending = Promise.all(sessions.splice(0).map((session) => detachConversationRecorder(session))).then(
      () => undefined,
    );
    context.finishing.add(ending);
    void ending.then(() => context.finishing.delete(ending));
  };

  let controller: ConnectionController | null = null;
  const dispatch = (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      // The protocol is JSON-only (voice runs over LiveKit rooms).
      send({ type: "error", scope: "protocol", message: "Binary frames are not supported." });
      return;
    }

    let message;
    try {
      message = parseClientMessage(data.toString());
    } catch (error) {
      if (error instanceof ProtocolError) {
        send({ type: "error", scope: "protocol", message: error.message });
        return;
      }
      throw error;
    }

    void controller!.handle(message).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logError("ws", `handler error: ${detail}`);
      send({ type: "error", scope: "llm", message: detail });
    });
  };
  // Frames the page sends while its conversation is being set up (a resumed one is
  // restored first) wait here rather than being dropped.
  const early: Array<{ data: RawData; isBinary: boolean }> = [];
  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (controller) dispatch(data, isBinary);
    else early.push({ data, isBinary });
  });

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    controller?.dispose();
    context.controllers.delete(socket);
    context.activity.turnRunning(owner, false);
    endRecordings();
  };
  socket.on("close", end);
  socket.on("error", (error) => {
    logError("ws", `socket error: ${error instanceof Error ? error.message : String(error)}`);
    end();
  });

  /** `curb server`: no conversation for this client, which is told why and disconnected, as a
   * client of a server expects. (`curb dev` keeps the page connected instead: it shows why
   * until a save reloads the agent.) */
  const refuse = (detail: string) => {
    logError("ws", `failed to start session: ${detail}`);
    send({ type: "error", scope: "llm", message: `Failed to start session: ${detail}` });
    socket.close();
  };

  if (context.renderError) {
    if (!context.dev) {
      refuse(context.renderError.message);
      return;
    }
    // A fresh conversation renders exactly what failed at boot: say so without failing again.
    send({
      type: "agent_unavailable",
      message: `The agent does not render: ${context.renderError.message}`,
      diagnostics: await agentErrors(context.defaultAgentId),
    });
    return;
  }

  let ready: ConnectionController;
  try {
    const initial = await build(context.defaultAgentId);
    ready = new ConnectionController(send, {
      runtime: initial.runtime,
      session: initial.session,
      agentHost: {
        ids: context.agentIds,
        initialId: initial.id,
        create: (id) => build(id),
        createRuntime: async (id, options) => (await createAgentRuntime(id, options)).runtime,
        preview: context.preview,
      },
      voiceHost: context.voiceHostAdapter,
      history: conversationHistory(),
    });
    const resume = resumeIdFrom(request);
    // The page sends its info first thing; it has arrived while the agent was built. The
    // conversation is restored with it, so it renders with it from the start.
    if (resume !== null) await ready.resume(resume, infoSentIn(early));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!context.dev) {
      refuse(message);
      endRecordings();
      return;
    }
    logError("ws", `failed to start session: ${message}`);
    // The socket stays open: the page shows why, where and how to fix it, instead of
    // reconnecting into the same failure. `curb dev` reloads when the files change.
    const raised = error instanceof AgentAuthoringError ? [error.diagnostic] : [];
    send({
      type: "agent_unavailable",
      message:
        raised.length > 0
          ? "The agent could not start a conversation."
          : `The agent could not start a conversation: ${message}`,
      diagnostics: [...raised, ...(await agentErrors(context.defaultAgentId))],
    });
    endRecordings();
    return;
  }
  if (ended) {
    // The page left while its conversation was set up.
    ready.dispose();
    endRecordings();
    return;
  }
  controller = ready;
  context.controllers.set(socket, ready);
  controller.start();
  for (const { data, isBinary } of early.splice(0)) dispatch(data, isBinary);
}

/**
 * The recorded conversations this preview offers, or none.
 *
 * Adapts the store to the connection's narrow read interface rather than handing
 * over the store itself, and returns undefined when there is no store — which is
 * the case with KUGEL_CONVERSATIONS_DB=off, under the test runner, and when a host
 * registered a conversation sink of its own (that host owns its own reader; the
 * local file it moved away from must not be created just to list stale rows). The
 * preview then shows only the conversation it starts, exactly as before.
 *
 * Read ONCE per connection, at construction. A refresh is a new connection and so
 * a fresh read; nothing here has to watch the file.
 */
function conversationHistory(): ConversationHistory | undefined {
  const store = getConversationHistoryStore();
  if (!store) return undefined;
  return {
    list: (limit) =>
      store.listConversations(limit).map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        startedAt: Date.parse(row.started_at) || Date.now(),
        messageCount: row.message_count,
      })),
    messages: (id) => store.restoreMessages(id),
    // A restored conversation's export shows the prompt it ran with, not the code's.
    systemPrompt: (id) => store.restoreSystemPrompt(id),
    state: (id) => store.restoreState(id),
    // The store is the sink here, so a recording's id is one of its rows.
    recordedId: (session) => {
      const id = recordedConversationId(session);
      return id === null ? null : Number(id);
    },
    continueRecording: (session, id) => continueRecordedConversation(session, String(id)),
  };
}
