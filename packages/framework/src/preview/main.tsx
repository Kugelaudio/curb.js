import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { PlugIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { REPLY_IDLE } from "../llm/spoken-split.js";
import type { AgentAssistantMessage } from "../llm/types.js";
import { preloadPublicMarkdown } from "../public-context.js";
import type { ToolDefinition } from "../types.js";
import { AgentGraphDialog } from "./agent-graph.js";
import { agentOutline } from "./agent-outline.js";
import { AgentSphere, agentName } from "./agent-sphere.js";
import { skillPage, skillPageStatus, useNewSinceLastMessage } from "./agent-view.js";
import { ContextColumn } from "./context-column.js";
import { useContextColumn } from "./context-column-state.js";
import {
  alwaysAvailableTools,
  builtInAbilities,
  initiallyExpanded,
  instructionsSummary,
  isMcpTool,
  mcpGroups,
  skillLabel,
  skillTools,
  skillTree,
  type ContextTreeInput,
  type TreeTool,
} from "./context-tree.js";
import { ContextTreeView } from "./context-tree-view.js";
import { Composer, type ComposerCall, type ComposerNotice } from "./conversation-composer.js";
import { embeddedBrowserName, microphoneDenied, microphoneWarning } from "./voice/microphone-access.js";
import { ConversationHeader } from "./conversation-header.js";
import { ConversationPlayer, type ConversationReplayState } from "./conversation-player.js";
import { ConversationThread } from "./conversation-thread.js";
import { lastCallOf } from "./conversation-turns.js";
import { AgentUnavailable, MissingKeysBanner, reloadNotice } from "./dev-reload.js";
import { DiagnosticsDialog } from "./diagnostics-dialog.js";
import { resolveIcon } from "./icon.js";
import { InstructionsDialog } from "./instructions-dialog.js";
import { callForReply, dateLineOf } from "./model-input.js";
import { ModelInputDialog } from "./model-input-dialog.js";
import { pageInfoFromQuery, refusedPageInfoNotice } from "./page-info.js";
import { pageBase, pathForRoute, routeForView, routeFromPath, viewForRoute, type PreviewView } from "./preview-route.js";
import { lockReasons } from "./skill-lock.js";
import { SkillSheet } from "./skill-sheet.js";
import { TopBar } from "./top-bar.js";
import {
  buildCodingAgentTranscript,
  chatMessagesToTranscript,
  contextToSurface,
  copyToClipboard,
  exportedSystemPrompt,
} from "./transcript-export.js";
import { TryToolDialog, type TryTarget } from "./try-tool-dialog.js";
import { VoiceClient } from "./voice/voice-client.js";
import { DemoWsClient, missingKeysOf } from "./ws-client.js";
import "streamdown/styles.css";
import "./globals.css";
import "./preview.css";

const NO_REPLAY: ConversationReplayState = { active: false, timeMs: 0, windows: [] };

function App() {
  // The page's own info from its URL (`?client.event=…`), read once: what a page an agent is
  // embedded in would send. Refused entries are shown, never sent.
  const pageInfo = useMemo(() => pageInfoFromQuery(window.location.search), []);
  // The runtime and AgentSession live on the server. This client connects over the WS and
  // renders from server-pushed state; it owns no agent runtime.
  const client = useMemo(() => new DemoWsClient(undefined, pageInfo.info), [pageInfo]);
  useEffect(() => {
    client.connect();
    return () => client.dispose();
  }, [client]);
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getState(), [client]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  // The call's transport (a LiveKit room or the dev server's own socket: mic, agent audio,
  // live status). The server owns the call; this client follows the ticket its voice_session
  // frames carry.
  const voiceClient = useMemo(() => new VoiceClient(), []);
  useEffect(() => () => voiceClient.dispose(), [voiceClient]);
  const voiceSubscribe = useCallback((listener: () => void) => voiceClient.subscribe(listener), [voiceClient]);
  const voiceSnapshot = useCallback(() => voiceClient.getState(), [voiceClient]);
  const callState = useSyncExternalStore(voiceSubscribe, voiceSnapshot);
  useEffect(() => {
    // The client publishes an explicit call error if enumeration fails.
    void voiceClient.refreshMicrophones().catch(() => undefined);
  }, [voiceClient]);
  // Said before Start call: an app's built-in browser or a blocked page has no microphone.
  const [micWarning, setMicWarning] = useState<string | null>(null);
  useEffect(() => {
    void microphoneDenied().then((denied) =>
      setMicWarning(
        microphoneWarning({ embedded: embeddedBrowserName(navigator.userAgent), denied, pageUrl: window.location.origin }),
      ),
    );
  }, []);
  useEffect(() => {
    const ticket = state.voice;
    if (ticket.live && ticket.transport && ticket.url && ticket.token && ticket.room && state.activeConversation) {
      void voiceClient.start({
        transport: ticket.transport,
        url: ticket.url,
        token: ticket.token,
        room: ticket.room,
        conversationId: state.activeConversation,
      });
    } else {
      voiceClient.stop();
    }
  }, [voiceClient, state.voice]);

  const [view, setView] = useState<PreviewView>({ overlay: null });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [input, setInput] = useState("");
  // Skills the viewer ran a tool on: test runs go to the preview's copy, so from then on
  // such a skill's sheet shows the copy (see skillPage in agent-view.tsx).
  const [testedSkillPaths, setTestedSkillPaths] = useState<ReadonlySet<string>>(new Set());
  // A dialog keeps what it shows until the next opening replaces it: closing flips only its
  // open flag, so its content stays while it animates closed.
  const [tryTarget, setTryTarget] = useState<TryTarget | null>(null);
  const [tryOpen, setTryOpen] = useState(false);
  const [modelInputFor, setModelInputFor] = useState<AgentAssistantMessage | null>(null);
  const [modelInputOpen, setModelInputOpen] = useState(false);
  const [replay, setReplay] = useState<ConversationReplayState>(NO_REPLAY);
  const [dismissedError, setDismissedError] = useState<unknown>(null);
  // Hidden by default in a narrow window (the hosted editor's preview pane), remembered after.
  const contextColumn = useContextColumn();

  const context = state.context;
  const activeAgent = state.activeAgent;
  // The server describes the active agent (its skills, their source, its preview hints); the
  // page never imports the project's agent modules, which run on the server, under Node.
  const outline = useMemo(() => (activeAgent ? agentOutline(activeAgent) : null), [activeAgent]);

  useEffect(() => {
    setInput("");
    setTestedSkillPaths(new Set());
    setTryOpen(false);
  }, [activeAgent?.id]);
  // Every test run undone: the copy matches the code again.
  useEffect(() => {
    if (!state.inspectCanUndo) setTestedSkillPaths(new Set());
  }, [state.inspectCanUndo]);

  /** Show `next` and write its URL. A skill's sheet compiles that skill on the preview's copy. */
  const navigate = (next: PreviewView, history: "push" | "replace" = "push") => {
    setView(next);
    const url = `${pathForRoute(routeForView(next), pageBase())}${window.location.search}`;
    if (`${window.location.pathname}${window.location.search}` !== url) {
      if (history === "push") window.history.pushState(null, "", url);
      else window.history.replaceState(null, "", url);
    }
    if (next.overlay?.kind === "skill") client.inspectSkill(next.overlay.path);
  };
  const closeOverlay = () => navigate({ overlay: null });
  const openSkill = (path: string) => navigate({ overlay: { kind: "skill", path } });

  // The URL opens its view once the agent's skills are known; until then a skill URL cannot
  // be checked. The preview's copy of the agent is created here too, so a test run never
  // races its creation. Again on every new connection: after `curb dev` reloaded the agent,
  // the new server's copy compiles the saved code.
  const linkedConnection = useRef(0);
  useEffect(() => {
    // `connection` counts connections whose agent arrived, so `outline` is this connection's.
    if (linkedConnection.current === state.connection || !state.connected || !outline || !context) return;
    linkedConnection.current = state.connection;
    const route = routeFromPath(window.location.pathname, outline.skillPaths, pageBase());
    const next = viewForRoute(route);
    navigate(next, "replace");
    if (next.overlay?.kind !== "skill") client.inspectSkill(context.path);
    if (route.kind === "tools") {
      requestAnimationFrame(() => document.getElementById("context-tools")?.scrollIntoView({ block: "start" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.connected, state.connection, outline, context]);

  // A reload may come from a saved context/*.md: the page's copy of the markdown (branch
  // views of documents not rendered yet) is read again, as the agent's was, and shown.
  const [, setMarkdownRevision] = useState(0);
  useEffect(() => {
    if (state.connection <= 1) return;
    preloadPublicMarkdown().then(
      () => setMarkdownRevision((revision) => revision + 1),
      (error: unknown) => console.error("[preview] could not read the context markdown again:", error),
    );
  }, [state.connection]);

  // Back and forward move between views.
  useEffect(() => {
    if (!outline) return;
    const onPopState = () => {
      const next = viewForRoute(routeFromPath(window.location.pathname, outline.skillPaths, pageBase()));
      setView(next);
      if (next.overlay?.kind === "skill") client.inspectSkill(next.overlay.path);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [outline, client]);

  // What entered the agent's view since the caller's last message: marked New in the tree.
  const changes = useNewSinceLastMessage(state.messages, state.context, state.activeConversation);

  // A NEW REPLY EXISTS AND HAS NOT BEEN SPOKEN: the first moment its text exists and the last
  // one before it is heard, so the call's ink starts muted. Only on growth with words: a
  // restored or switched transcript was heard long ago, and a tool-only step says nothing.
  const assistantMessageCount = state.messages.filter(
    (message) => message.role === "assistant" && message.content.trim() !== "",
  ).length;
  const lastArmedCount = useRef(assistantMessageCount);
  useEffect(() => {
    const grew = assistantMessageCount > lastArmedCount.current;
    lastArmedCount.current = assistantMessageCount;
    if (!grew) return;
    // TEMPORARY: the commit moment, on the same timeline as the phases.
    void fetch(
      `/__voice-phase?p=${encodeURIComponent(`assistant message committed (#${assistantMessageCount})`)}`,
    ).catch(() => undefined);
    // No-ops when no call is live; typed conversations never mute.
    voiceClient.expectReply();
  }, [assistantMessageCount, voiceClient]);

  // A save is waiting to reload the agent, or reloading it: a typed message now would run
  // the code from before the save. Inside a live call it goes to the call, which keeps the
  // code it started with until it ends (the notice says so).
  const holdsMessages = state.reload !== null && !(state.reload.state === "waiting" && state.reload.until === "call_ends");
  // The agent shows but cannot answer: a key it needs is not set (`curb dev` says which).
  const missingKeys = missingKeysOf(state);
  const blocked = missingKeys.length > 0;
  const send = useCallback(
    (text: string) => {
      if (!text.trim() || holdsMessages || blocked) return;
      setInput("");
      // Typing into a live call is a barge-in: the reply it triggers has not been spoken yet.
      voiceClient.expectReply();
      client.sendUserText(text);
    },
    [client, voiceClient, holdsMessages, blocked],
  );

  if (state.unavailable) return <AgentUnavailable {...state.unavailable} />;

  if (!context || !activeAgent || !outline) {
    return (
      <main className="grid h-screen place-items-center">
        <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground" role="status">
          <AgentSphere size={44} />
          {state.connected ? "Loading your agent…" : "Connecting to the agent server…"}
        </div>
      </main>
    );
  }

  const treeInput: ContextTreeInput = {
    live: context,
    skillPaths: outline.skillPaths,
    metadata: outline.skillMetadata,
    blueprints: outline.blueprints,
    agentBlueprint: outline.agentBlueprint,
    interactivePaths: outline.interactivePaths,
    gatedPaths: outline.gatedPaths,
    newSkillPaths: new Set(changes?.skills.map((skill) => skill.path)),
    newToolNames: new Set(changes?.tools),
  };
  const skills = skillTree(treeInput);
  const labelOf = (path: string) => skillLabel(treeInput, path);
  const toolIcon = (name: string) => {
    const tool = context.tools.find((candidate) => candidate.name === name);
    return resolveIcon(tool?.icon) ?? (tool && isMcpTool(tool) ? PlugIcon : undefined);
  };
  const callLive = state.voice.live && callState.connected;

  const tryTool = (target: TryTarget) => {
    setTryTarget(target);
    setTryOpen(true);
  };
  const tryTreeTool = (tool: TreeTool) =>
    tryTool({ name: tool.name, skillPath: tool.skillPath, definition: tool.definition });
  const tryDefinition = (tool: ToolDefinition) =>
    tryTool({ name: tool.name, skillPath: tool.scope === "page" ? tool.skillPath : undefined, definition: tool });

  // The skill sheet: the conversation's own page for the skill the agent is on, the
  // preview's copy for any other (and for that one once a tool was tried on it).
  const sheetPath = view.overlay?.kind === "skill" ? view.overlay.path : null;
  const sheetLive = sheetPath === context.path && !testedSkillPaths.has(context.path);
  const sheetPage =
    sheetPath && (sheetLive || state.inspectedContext?.path === sheetPath)
      ? skillPage(context, state.inspectedContext, sheetPath, testedSkillPaths)
      : null;
  const sheetNode = sheetPath ? findSkill(skills, sheetPath) : null;

  const notices: ComposerNotice[] = [];
  const reloading = reloadNotice(state.reload);
  if (reloading) notices.push({ key: "reload", tone: "neutral", text: reloading });
  // What a restored conversation could not bring back (state, skills that no longer exist).
  if (state.notice) notices.push({ key: "notice", tone: "neutral", text: state.notice });
  const refused = refusedPageInfoNotice(pageInfo.refused);
  if (refused) notices.push({ key: "page-info", tone: "error", text: refused });
  if (callState.error) notices.push({ key: "call", tone: "error", text: callState.error });
  else if (micWarning && !callLive) notices.push({ key: "microphone", tone: "neutral", text: micWarning });
  // A test run's failure belongs to the Try dialog while it is open.
  if (state.lastError && state.lastError !== dismissedError && !(tryOpen && state.lastError.scope === "tool")) {
    const error = state.lastError;
    notices.push({ key: "server", tone: "error", text: error.message, onDismiss: () => setDismissedError(error) });
  }

  const call: ComposerCall = {
    live: callLive,
    connecting: state.voice.connecting || callState.connecting,
    speaking: callState.speaking,
    thinking: callState.processing || state.running,
    micMuted: callState.micMuted,
    microphones: callState.microphones,
    selectedMicrophoneId: callState.selectedMicrophoneId,
    switchingMicrophone: callState.switchingMicrophone,
    onStart: () => client.voiceStart(),
    onStop: () => client.voiceStop(),
    // Failures land in callState.error, which the notices show.
    onToggleMute: () => void voiceClient.setMicMuted(!callState.micMuted).catch(() => undefined),
    onMicrophoneChange: (deviceId) => void voiceClient.selectMicrophone(deviceId).catch(() => undefined),
    // Asks for the microphone once, so the menu names the inputs instead of numbering them.
    onMicrophoneMenuOpen: () => void voiceClient.refreshMicrophones({ requestPermission: true }).catch(() => undefined),
  };
  const recordings = voiceClient.getRecordings(state.activeConversation);
  const summary = instructionsSummary(context.systemPrompt ?? "");

  return (
    <TooltipProvider>
      <div className="grid h-screen grid-rows-[60px_minmax(0,1fr)] overflow-hidden">
        <TopBar
          agents={state.agents}
          activeAgentId={activeAgent.id}
          onSelectAgent={(id) => {
            client.selectAgent(id);
            navigate({ overlay: null }, "replace");
          }}
          diagnostics={context.diagnostics}
          onOpenDiagnostics={() => navigate({ overlay: { kind: "diagnostics" } })}
          contextOpen={contextColumn.open}
          onToggleContext={contextColumn.toggle}
        />
        <div
          className={
            contextColumn.open
              ? "grid min-h-0 grid-cols-[minmax(0,1fr)_clamp(440px,36.667vw,616px)]"
              : "grid min-h-0 grid-cols-[minmax(0,1fr)]"
          }
        >
          <section className="relative flex min-h-0 flex-col" aria-label="Conversation">
            <ConversationHeader
              conversations={state.conversations}
              activeId={state.activeConversation}
              running={state.running}
              hasMessages={state.messages.length > 0}
              onSelect={(id) => client.selectConversation(id)}
              onNew={() => client.reset()}
              onCopyForCodingAgent={() =>
                copyToClipboard(
                  buildCodingAgentTranscript(
                    activeAgent.id,
                    chatMessagesToTranscript(state.messages),
                    // The agent's live surface (the skills it can open and the tools it has
                    // now) so the export shows what it could do, not only what it did. The
                    // prompt is the one this conversation sent (or, restored, the one
                    // recorded for it), else the code's, labelled.
                    contextToSurface(
                      context,
                      exportedSystemPrompt(state.llmTrace, context.systemPrompt, state.recordedSystemPrompt),
                    ),
                  ),
                )
              }
            />
            {blocked ? <MissingKeysBanner diagnostics={missingKeys} /> : null}
            <div className={recordings.length > 0 ? "px-6" : undefined}>
              <ConversationPlayer
                recordings={recordings}
                revision={callState.recordingRevision}
                onReplayChange={setReplay}
              />
            </div>
            <ConversationThread
              messages={state.messages}
              streamingText={state.streamingText}
              running={state.running}
              callLive={callLive}
              playback={callLive ? callState.replyPlayback : REPLY_IDLE}
              callerSpeech={callState.callerSpeech}
              replay={replay}
              agentName={agentName(activeAgent.id)}
              suggestedPrompts={blocked ? [] : outline.suggestedPrompts}
              onPrompt={send}
              skillLabel={labelOf}
              toolIcon={toolIcon}
              onOpenSkill={openSkill}
              onShowModelInput={(message) => {
                setModelInputFor(message);
                setModelInputOpen(true);
              }}
              onRetry={state.running ? undefined : (index) => client.rewind(index)}
              onGoBack={
                state.running
                  ? undefined
                  : (index, text) => {
                      client.rewind(index, false);
                      setInput(text);
                    }
              }
            />
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={send}
              placeholder={outline.chatPlaceholder}
              running={state.running}
              notices={notices}
              call={call}
              blocked={blocked}
            />
          </section>
          {contextColumn.open ? (
            <ContextColumn
              connected={state.connected}
              onOpenGraph={skills.length > 0 ? () => navigate({ overlay: { kind: "graph" } }) : undefined}
            >
              <ContextTreeView
                instructions={{ ...summary, isNew: changes?.instructions ?? false, empty: !context.systemPrompt?.trim() }}
                tools={alwaysAvailableTools(treeInput)}
                mcp={mcpGroups(state.mcpServers, context)}
                skills={skills}
                initiallyOpen={initiallyExpanded(skills)}
                liveSkillPath={context.path}
                builtIn={builtInAbilities(context)}
                onOpenInstructions={() => navigate({ overlay: { kind: "instructions" } })}
                onOpenSkill={openSkill}
                onTry={tryTreeTool}
                onMcpConnect={(id) => client.mcpConnect(id)}
                onMcpDisconnect={(id) => client.mcpDisconnect(id)}
                onMcpRemove={(id) => client.mcpRemove(id)}
              />
            </ContextColumn>
          ) : null}
        </div>
      </div>

      <SkillSheet
        skill={
          sheetPath
            ? {
                path: sheetPath,
                label: labelOf(sheetPath),
                description: sheetNode?.description,
                icon: sheetNode?.icon,
                interactive: outline.interactivePaths.has(sheetPath),
                isNew: treeInput.newSkillPaths.has(sheetPath),
              }
            : null
        }
        page={sheetPage?.context ?? null}
        status={skillPageStatus({
          showsLive: sheetPage?.showsLive ?? false,
          current: sheetPath === context.path,
          inUse: context.loadedSkills.some((skill) => skill.path === sheetPath),
        })}
        tried={state.inspectCanUndo}
        canUndo={state.inspectCanUndo}
        onUndo={() => client.inspectUndo()}
        lockReasons={sheetPath && outline.gatedPaths.has(sheetPath) ? lockReasons(sheetPath, outline.blueprints) : []}
        skillLabel={labelOf}
        blueprint={sheetPath ? (outline.blueprints.get(sheetPath) ?? null) : null}
        sourceToolNames={sheetPath ? skillTools(treeInput, sheetPath).map((tool) => tool.name) : []}
        newToolNames={treeInput.newToolNames}
        untryable={sheetPage?.untryable ?? new Set()}
        blockApi={{
          toolErrors: sheetPage?.context.toolErrors ?? {},
          onToolSubmit: async (name, toolInput) => {
            if (sheetPath) setTestedSkillPaths((paths) => new Set(paths).add(sheetPath));
            client.callTool(name, toolInput);
          },
        }}
        onTry={tryDefinition}
        onOpenSkill={openSkill}
        onClose={closeOverlay}
      />
      <AgentGraphDialog
        open={view.overlay?.kind === "graph"}
        onOpenChange={(open) => (open ? undefined : closeOverlay())}
        context={context}
        blueprints={outline.blueprints}
        agentBlueprint={outline.agentBlueprint}
        skillMetadata={outline.skillMetadata}
        interactivePaths={outline.interactivePaths}
        gatedPaths={outline.gatedPaths}
        agentLabel={agentName(activeAgent.id)}
        onOpenSkill={openSkill}
        onOpenAgent={() => navigate({ overlay: { kind: "instructions" } })}
      />
      <InstructionsDialog
        open={view.overlay?.kind === "instructions"}
        onOpenChange={(open) => (open ? undefined : closeOverlay())}
        systemPrompt={context.systemPrompt ?? ""}
        agentId={activeAgent.id}
        dateLine={dateLineOf(state.llmTrace.at(-1))}
        isNew={changes?.instructions ?? false}
      />
      <DiagnosticsDialog
        open={view.overlay?.kind === "diagnostics"}
        onOpenChange={(open) => (open ? undefined : closeOverlay())}
        diagnostics={context.diagnostics}
      />
      <TryToolDialog
        open={tryOpen}
        target={tryTarget}
        onClose={() => setTryOpen(false)}
        lastCall={tryTarget ? (lastCallOf(state.messages, tryTarget.name)?.input ?? null) : null}
        copy={state.inspectedContext}
        toolRun={state.toolRun}
        lastError={state.lastError}
        onPrepare={(skillPath) => client.inspectSkill(skillPath)}
        onRun={(target, toolInput) => {
          const tested = target.skillPath ?? sheetPath;
          if (tested) setTestedSkillPaths((paths) => new Set(paths).add(tested));
          client.callTool(target.name, toolInput);
        }}
      />
      <ModelInputDialog
        open={modelInputOpen}
        onOpenChange={setModelInputOpen}
        call={modelInputFor ? callForReply(state.llmTrace, modelInputFor.at) : null}
        trace={state.llmTrace}
      />
    </TooltipProvider>
  );
}

function findSkill<T extends { path: string; children: T[] }>(nodes: readonly T[], path: string): T | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findSkill(node.children, path);
    if (child) return child;
  }
  return null;
}

// Fill the browser-side markdown cache before the first render, so a skill's sheet can open
// any `<Text src>` document, including ones whose branch is not rendered yet.
await preloadPublicMarkdown();

createRoot(document.getElementById("root")!).render(<App />);
