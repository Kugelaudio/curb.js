import { agentAppElement } from "../routing.js";
import { AgentSession, type AgentLlmClient, type AgentLlmStreamStep } from "../agent-session.js";
import { discoverAgent, resolveDefaultAgentId, type DiscoveredAgent } from "../agent.node.js";
import { diagnoseAgentAuthoring } from "../authoring-diagnostics.js";
import { formatAuthoringDiagnostic } from "../authoring.js";
import type { McpServerConfig } from "../mcp/config.js";
import { configureMcp, preloadMcpTools } from "../mcp/manager.js";
import { loadUserMcpServers, saveUserMcpServers } from "../mcp/servers-store.js";
import { resolveAgentDir } from "../project.node.js";
import { bundledAgentRegistry, discoverAgentFromRegistry } from "../agent-registry.node.js";
import { openingLineOf } from "../config.js";
import { AgentSiteRuntime } from "../runtime.js";
import { attachConversationSink, resolveConversationSink } from "./conversation-store.js";

/**
 * One hosted agent session: a headless React runtime plus the agent turn loop
 * bound to it. The WS server creates one of these per connection (and a new
 * one when the user switches agents); the voice bridge one per voice session.
 */
export type HostedSession = {
  runtime: AgentSiteRuntime;
  session: AgentSession;
  agentId: string;
  definition: DiscoveredAgent["definition"];
};

/** The author-facing agent folder of the consuming project — resolved from
 * AGENT_PROJECT_DIR (set by the CLI) or the working directory. */
// Resolved lazily. A hosted artifact has no src/agent/ and resolveAgentDir throws, so
// evaluating this at import time would kill the process before the bundled registry
// could be consulted.
let agentDirCache: string | undefined;
function agentDir(): string {
  agentDirCache ??= resolveAgentDir();
  return agentDirCache;
}

/**
 * Process-wide prerequisites, shared across every connection:
 * - the agent registry, discovered from the filesystem once, and
 * - the MCP manager (`configureMcp` installs a single default manager that the
 *   `<Mcp>` component reads synchronously during render; it is configured with
 *   the UNION of every agent's `mcpServers` so switching agents needs no MCP
 *   reconfiguration; per-connection cleanup must NOT close this manager).
 */
let prerequisites: Promise<DiscoveredAgent[]> | null = null;

/** Merge every agent's MCP config. Same id twice is fine when the URLs agree
 * (enabled wins over disabled); conflicting URLs are a configuration error. */
function mergeMcpServers(agents: DiscoveredAgent[]): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const agent of agents) {
    for (const server of agent.definition.mcpServers ?? []) {
      const existing = merged.get(server.id);
      if (!existing) {
        merged.set(server.id, server);
        continue;
      }
      if (existing.url !== server.url) {
        throw new Error(
          `MCP server "${server.id}" is declared with conflicting URLs ` +
            `("${existing.url}" vs "${server.url}") across agents. Rename one of them.`,
        );
      }
      const enabled = existing.enabled !== false || server.enabled !== false;
      merged.set(server.id, { ...existing, enabled });
    }
  }
  return [...merged.values()];
}

/**
 * `quiet`: discovery prints no diagnostics (`curb dev` reloading the agent, which reports a
 * reload in one line). Read by the call that discovers, the first one.
 */
export function ensureHostPrerequisites(options: { quiet?: boolean } = {}): Promise<DiscoveredAgent[]> {
  if (!prerequisites) {
    prerequisites = (async () => {
      // Prefer the bundled registry. A hosted artifact has neither src/agent/ nor a
      // TypeScript loader, so filesystem discovery cannot work there at all.
      const registry = bundledAgentRegistry();
      const discovered = registry
        ? [discoverAgentFromRegistry()]
        : [await discoverAgent(agentDir())];
      const manager = configureMcp(mergeMcpServers(discovered));
      // Servers added at runtime through the dashboard persist in
      // mcp.servers.json and come back (and reconnect) on restart.
      manager.configure(loadUserMcpServers(), { user: true });
      manager.onPersistUserServers = saveUserMcpServers;
      await preloadMcpTools();
      const agents = discovered.map((agent) => ({
        ...agent,
        diagnostics: diagnoseAgentAuthoring({
          id: agent.id,
          definition: agent.definition,
          routes: agent.routes,
          source: agent.source,
          homeSkill: agent.homeSkill,
        }),
      }));
      for (const agent of options.quiet ? [] : agents) {
        for (const diagnostic of agent.diagnostics) {
          const output = `[agent:${agent.id}] ${formatAuthoringDiagnostic(diagnostic)}`;
          if (diagnostic.severity === "error") console.error(output);
          else console.warn(output);
        }
      }
      return agents;
    })();
  }
  return prerequisites;
}

/** Resolve one agent by id — or the default (AGENT_DEFAULT env, else first). */
export async function getHostedAgent(agentId?: string): Promise<DiscoveredAgent> {
  const agents = await ensureHostPrerequisites();
  const id = agentId ?? resolveDefaultAgentId(agents);
  const found = agents.find((agent) => agent.id === id);
  if (!found) {
    throw new Error(
      `Unknown agent "${id}". Available: ${agents.map((agent) => agent.id).join(", ")}.`,
    );
  }
  return found;
}

export async function listAgentIds(): Promise<string[]> {
  return (await ensureHostPrerequisites()).map((agent) => agent.id);
}

/**
 * Build a fresh runtime + session for one connection, for the given agent id
 * (default agent when omitted). The LLM transport is injected so tests can
 * pass a mock; production hosts pass the AI SDK transports.
 *
 * Markdown context is loaded from disk at module import time in Node (see
 * `public-context.ts`), so no HTTP preload step is needed server-side.
 */
/** Build a standalone runtime for an agent — used for the session (below) and
 * for the preview's read-only inspector (a shadow runtime per connection). It
 * starts at the agent level, with no skill loaded, on every route. */
export async function createAgentRuntime(
  agentId?: string,
  overrides?: { maxLoadedSkills?: number },
): Promise<{
  runtime: AgentSiteRuntime;
  agentId: string;
  definition: DiscoveredAgent["definition"];
}> {
  const { id, definition, routes, diagnostics } = await getHostedAgent(agentId);
  const runtime = new AgentSiteRuntime(
    ({ path, loadedPaths }) => agentAppElement(definition.app, { path, loadedPaths, routes }),
    {
      maxLoadedSkills: overrides?.maxLoadedSkills ?? definition.maxLoadedSkills,
      authoringDiagnostics: diagnostics,
    },
  );
  return { runtime, agentId: id, definition };
}

export async function createAgentSession(
  llm: AgentLlmClient,
  streamLlm?: AgentLlmStreamStep,
  agentId?: string,
  options?: { spokenStyleSuffix?: string },
): Promise<HostedSession> {
  const { runtime, agentId: id, definition } = await createAgentRuntime(agentId);
  const session = new AgentSession(runtime, llm, {
    maxSteps: definition.maxSteps,
    maxTranscriptMessages: definition.maxTranscriptMessages,
    timeZone: definition.timeZone,
    streamLlm,
    spokenStyleSuffix: options?.spokenStyleSuffix,
    // `firstTurn: { say }`: the session opens every conversation with the line, on every route
    // (a call, typed chat, curb say, curb test), so none can skip it or say it twice.
    opening: openingLineOf(definition.firstTurn),
  });
  // Mirror the transcript (incl. tool calls/results) into the durable sink — one
  // conversation covers typed and spoken turns alike. A JSONL file by default, whatever
  // KUGEL_CONVERSATION_SINK names when a host registers its own, nothing at all when
  // recording is off. See conversation-store.ts; `curb conversations` to read.
  //
  // The metadata callback is deliberately late-bound: it is read when the first message
  // starts the conversation, by which time the host's `set_info` values have landed.
  //
  // A sink that rejects never fails the session: the write is logged, counted and retried.
  // The host ends the recording with `detachConversationRecorder(session)` when the session
  // ends, which retries once more and reports anything still unwritten.
  const sink = await resolveConversationSink();
  if (sink) attachConversationSink(sink, session, id, () => runtime.info.snapshot());
  return { runtime, session, agentId: id, definition };
}
