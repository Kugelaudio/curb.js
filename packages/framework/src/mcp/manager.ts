import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { isRemoteConfig, type McpAnyServerConfig, type McpAuth, type McpServerConfig } from "./config.js";
// Type-only: the implementation stays a dynamic import (it needs node:fs).
import type { FileOAuthProvider } from "./oauth-store.js";
import {
  mcpToolToDefinition,
  normalizeMcpResult,
  type McpCallToolResult,
  type McpToolInfo,
} from "./to-tool-definition.js";

export type McpServerState =
  | { status: "ready"; tools: McpToolInfo[] }
  | { status: "error"; message: string }
  | { status: "connecting" }
  /** OAuth flow started — the user must approve at `authUrl`. */
  | { status: "auth_required"; authUrl: string | null }
  /** Configured but not connected (enabled: false, or manually disconnected). */
  | { status: "disconnected" }
  /** Not configured / not preloaded in this environment — render nothing. */
  | { status: "absent" };

/** Wire-friendly view of one server for the dashboard UI. */
export type McpServerSummary = {
  id: string;
  /** The remote endpoint. Absent only for test-only in-memory servers. */
  url?: string;
  status: Exclude<McpServerState["status"], "absent">;
  toolCount?: number;
  message?: string;
  authUrl?: string | null;
  /** True for servers added at runtime (dashboard) — these can be removed. */
  removable: boolean;
};

const CLIENT_INFO = { name: "kugel-framework", version: "0.0.0" } as const;

/** Server ids double as tool namespaces and auth filenames. */
const SERVER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Where OAuth redirects land. Set once by the host that owns the HTTP server
 * (see `server/main.ts`); read by every manager when it builds a provider. */
let oauthCallbackUrl: string | null = null;

export function setMcpOAuthCallbackUrl(url: string): void {
  oauthCallbackUrl = url;
}

/**
 * How long a sign-in counts as in progress once the user opened it (`openSignIn`): a
 * `curb dev` reload waits for it at most this long, so the provider's callback still finds
 * the server process that holds the flow. A sign-in left unfinished longer is abandoned.
 */
export const MCP_SIGN_IN_HOLD_MS = 5 * 60_000;

/**
 * The host's own sign-in page (`server/main.ts`): the dashboard's Sign in opens it with
 * `?server=<id>`, it calls `openSignIn` and redirects to the provider. Unset, the dashboard
 * gets the provider's authorization URL itself, and no sign-in is known to be in progress.
 */
let oauthSignInUrl: string | null = null;

export function setMcpOAuthSignInUrl(url: string | null): void {
  oauthSignInUrl = url;
}

async function createTransport(
  config: McpAnyServerConfig,
  onAuthorizationUrl: (url: URL) => void,
): Promise<{
  transport: Transport;
  /** Connect the server side too, for in-memory pairs. */
  serverConnect?: () => Promise<void>;
  /** Present only for OAuth servers; used to validate the callback state. */
  oauthProvider?: FileOAuthProvider;
}> {
  if (!isRemoteConfig(config)) {
    // Test-only in-memory pair (see McpInMemoryServerConfig).
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = config.createServer();
    return {
      transport: clientTransport,
      serverConnect: () => server.connect(serverTransport),
    };
  }

  const headers: Record<string, string> = { ...config.headers };
  if (config.auth?.kind === "bearer") {
    headers.Authorization = `Bearer ${config.auth.token}`;
  }
  // OAuth is the default for remote servers: hosted MCPs almost always
  // require it, and `none`/`bearer` must be opted into explicitly.
  if ((config.auth ?? { kind: "oauth" }).kind === "oauth") {
    if (!oauthCallbackUrl) {
      throw new Error(
        `MCP server "${config.id}" uses OAuth but no callback URL is configured. ` +
          "Run it from the WS server host (which registers /oauth/callback).",
      );
    }
    // Node-only (fs). Dynamically imported so it never lands in a browser bundle.
    const { FileOAuthProvider } = await import("./oauth-store.js");
    const { join } = await import("node:path");
    const dir = process.env.MCP_AUTH_DIR ?? join(process.cwd(), ".mcp-auth");
    const authProvider = new FileOAuthProvider(config.id, dir, oauthCallbackUrl, onAuthorizationUrl);
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
        requestInit: { headers },
      }),
      oauthProvider: authProvider,
    };
  }
  return {
    transport: new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
    }),
  };
}

/**
 * Owns one MCP `Client` per configured server, connects them, caches the merged
 * tool list, and routes `callTool` back to the right server. Discovery is async;
 * the rest of the framework reads the cached results synchronously.
 *
 * Servers can be added, connected, and authorized at runtime (the preview
 * dashboard drives this over the WS protocol). `onChange` listeners fire on
 * every state transition so hosts can broadcast status and refresh contexts.
 */
export class McpManager {
  private readonly configs = new Map<string, McpAnyServerConfig>();
  private readonly clients = new Map<string, Client>();
  private readonly states = new Map<string, McpServerState>();
  /** Flows parked mid-OAuth, waiting for the callback code. The provider is
   * kept to validate the callback `state` (CSRF protection). */
  private readonly pendingAuth = new Map<
    string,
    { transport: StreamableHTTPClientTransport; provider: FileOAuthProvider }
  >();
  /** Ids added at runtime (removable, persisted via `onPersistUserServers`). */
  private readonly userServerIds = new Set<string>();
  private readonly changeListeners = new Set<() => void>();
  /** Sign-ins the user opened (`openSignIn`) and the provider has not called back for yet:
   * when each was opened (epoch ms), by server id. */
  private readonly signIns = new Map<string, number>();

  /** Host hook: persist runtime-added servers (see `servers-store.ts`). */
  onPersistUserServers: ((configs: McpServerConfig[]) => void) | null = null;

  constructor(servers: McpAnyServerConfig[] = []) {
    this.configure(servers);
  }

  configure(servers: McpAnyServerConfig[], options: { user?: boolean } = {}) {
    for (const server of servers) {
      this.configs.set(server.id, server);
      if (options.user) this.userServerIds.add(server.id);
      if (!this.states.has(server.id)) {
        this.states.set(server.id, { status: "disconnected" });
      }
    }
    this.notify();
  }

  /**
   * Register a server declared inline via `<Mcp id url />` and connect it.
   * Idempotent — safe to call on every render: a server already known (inline
   * re-render, or pre-registered via `defineAgent`/dashboard) is left alone.
   * Credentials resolve implicitly (see {@link resolveImplicitAuth}): an
   * explicit `auth` wins, else a bearer token from `MCP_<ID>_TOKEN`, else
   * OAuth. Connecting only happens under Node — the browser preview has no MCP
   * transport, so there it just registers (the inspector lists the server).
   */
  ensureServer(config: McpServerConfig): void {
    if (this.configs.has(config.id)) return;
    const resolved: McpServerConfig = {
      ...config,
      auth: resolveImplicitAuth(config.id, config.auth),
    };
    this.configure([resolved]);
    if (config.enabled === false) return;
    // `window` present → browser preview: register only, never connect.
    if (typeof window !== "undefined") return;
    void this.connect(resolved);
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.changeListeners) listener();
  }

  private setState(id: string, state: McpServerState): void {
    this.states.set(id, state);
    this.notify();
  }

  serverIds(): string[] {
    return [...this.configs.keys()];
  }

  /** Dashboard view of every configured server. */
  summaries(): McpServerSummary[] {
    return [...this.configs.values()].map((config) => {
      const state = this.states.get(config.id) ?? { status: "disconnected" as const };
      const summary: McpServerSummary = {
        id: config.id,
        url: isRemoteConfig(config) ? config.url : undefined,
        status: state.status === "absent" ? "disconnected" : state.status,
        removable: this.userServerIds.has(config.id),
      };
      if (state.status === "ready") summary.toolCount = state.tools.length;
      if (state.status === "error") summary.message = state.message;
      if (state.status === "auth_required") {
        summary.authUrl =
          state.authUrl !== null && oauthSignInUrl !== null
            ? `${oauthSignInUrl}?server=${encodeURIComponent(config.id)}`
            : state.authUrl;
      }
      return summary;
    });
  }

  /**
   * The user opened the sign-in of `serverId` (the host's sign-in page, see
   * `setMcpOAuthSignInUrl`): it counts as in progress until the provider's callback was
   * handled, for at most {@link MCP_SIGN_IN_HOLD_MS}. Returns the provider's authorization
   * URL to send them on to, or null when no sign-in waits for that server.
   */
  openSignIn(serverId: string, now = Date.now()): string | null {
    const state = this.states.get(serverId);
    if (state?.status !== "auth_required" || state.authUrl === null || !this.pendingAuth.has(serverId)) return null;
    this.signIns.set(serverId, now);
    // When it is abandoned, listeners count again without it.
    setTimeout(() => this.notify(), MCP_SIGN_IN_HOLD_MS).unref?.();
    this.notify();
    return state.authUrl;
  }

  /** Servers whose sign-in is in progress: opened by the user less than
   * {@link MCP_SIGN_IN_HOLD_MS} ago, and not called back for yet. */
  signInsInProgress(now = Date.now()): string[] {
    return [...this.signIns].filter(([, openedAt]) => now - openedAt < MCP_SIGN_IN_HOLD_MS).map(([id]) => id);
  }

  /** The sign-in of `serverId` is over, however it ended. */
  private endSignIn(serverId: string): void {
    if (this.signIns.delete(serverId)) this.notify();
  }

  /** Connect every enabled server and cache its tool list. Per-server failures
   * are recorded as an error state (surfaced to the agent), not swallowed. */
  async connectAll(): Promise<void> {
    await Promise.all(
      [...this.configs.values()]
        .filter((config) => config.enabled !== false)
        .map((config) => this.connect(config)),
    );
  }

  /** Manually connect one server (dashboard action). Connecting an OAuth
   * server without stored tokens parks it in `auth_required` with the
   * authorization URL for the user to approve. */
  async connectServer(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      this.setState(id, { status: "error", message: `MCP server "${id}" is not configured.` });
      return;
    }
    await this.connect(config);
  }

  async disconnectServer(id: string): Promise<void> {
    const client = this.clients.get(id);
    this.clients.delete(id);
    this.pendingAuth.delete(id);
    this.signIns.delete(id);
    if (client) await client.close().catch(() => undefined);
    this.setState(id, { status: "disconnected" });
  }

  /**
   * Register a new remote server at runtime (dashboard "add" action) and
   * persist it via the host hook so it survives restarts. Does not connect —
   * the caller follows up with `connectServer`.
   */
  addServer(config: McpServerConfig): void {
    if (!SERVER_ID_PATTERN.test(config.id)) {
      throw new Error(
        `Invalid MCP server id "${config.id}" — use letters, digits, dashes, underscores.`,
      );
    }
    if (this.configs.has(config.id)) {
      throw new Error(`MCP server "${config.id}" already exists.`);
    }
    new URL(config.url); // validates; throws on garbage
    this.configure([config], { user: true });
    this.persistUserServers();
  }

  /** Remove a runtime-added server. Code-configured servers stay. */
  async removeServer(id: string): Promise<void> {
    if (!this.userServerIds.has(id)) {
      throw new Error(`MCP server "${id}" is configured in code and cannot be removed here.`);
    }
    await this.disconnectServer(id);
    this.configs.delete(id);
    this.states.delete(id);
    this.userServerIds.delete(id);
    this.persistUserServers();
    this.notify();
  }

  private persistUserServers(): void {
    if (!this.onPersistUserServers) return;
    const userConfigs = [...this.userServerIds]
      .map((id) => this.configs.get(id))
      .filter((config): config is McpServerConfig => config !== undefined && isRemoteConfig(config));
    this.onPersistUserServers(userConfigs);
  }

  /**
   * Complete an OAuth flow: the `/oauth/callback` endpoint passes the `state`
   * (which embeds the server id) and the authorization code here. Exchanges
   * the code on the parked transport, then reconnects for real.
   */
  async finishOAuth(state: string, code: string): Promise<string> {
    const serverId = decodeURIComponent(state.split(".")[0] ?? "");
    const pending = this.pendingAuth.get(serverId);
    if (!pending) {
      throw new Error(`No pending OAuth flow for MCP server "${serverId}".`);
    }
    if (!pending.provider.consumeState(state)) {
      throw new Error(`OAuth state mismatch for MCP server "${serverId}" — rejected.`);
    }
    this.pendingAuth.delete(serverId);
    try {
      await pending.transport.finishAuth(code);
      await this.connectServer(serverId);
    } finally {
      // The provider called back for this flow: the sign-in is over, whether the exchange worked or not.
      this.endSignIn(serverId);
    }
    return serverId;
  }

  private async connect(config: McpAnyServerConfig): Promise<void> {
    this.setState(config.id, { status: "connecting" });

    let transport: Transport;
    let serverConnect: (() => Promise<void>) | undefined;
    let oauthProvider: FileOAuthProvider | undefined;
    // The provider reports the authorization URL DURING connect (before the
    // UnauthorizedError below), so capture it here and publish both together.
    let authUrl: string | null = null;
    try {
      ({ transport, serverConnect, oauthProvider } = await createTransport(config, (url) => {
        authUrl = url.toString();
      }));
    } catch (error) {
      this.setState(config.id, {
        status: "error",
        message: `Failed to set up MCP server "${config.id}": ${String(error)}`,
      });
      return;
    }

    try {
      const client = new Client(CLIENT_INFO);
      if (serverConnect) await serverConnect();
      await client.connect(transport);

      const { tools } = await client.listTools();
      this.clients.set(config.id, client);
      this.pendingAuth.delete(config.id);
      this.signIns.delete(config.id);
      this.setState(config.id, { status: "ready", tools: tools as McpToolInfo[] });
    } catch (error) {
      if (
        error instanceof UnauthorizedError &&
        transport instanceof StreamableHTTPClientTransport &&
        oauthProvider
      ) {
        // The transport drove the OAuth flow up to the redirect. Park it so
        // finishOAuth can exchange the callback code on the same flow state.
        this.pendingAuth.set(config.id, { transport, provider: oauthProvider });
        this.setState(config.id, { status: "auth_required", authUrl });
        return;
      }
      this.setState(config.id, {
        status: "error",
        message: `Failed to connect MCP server "${config.id}": ${String(error)}`,
      });
    }
  }

  /** Synchronous read of a server's cached state (for use during render). A
   * connected server is `ready`; a configured server that failed to connect is
   * `error` (surfaced, never silent); anything else is `absent`. */
  resolve(serverId: string): McpServerState {
    return this.states.get(serverId) ?? { status: "absent" };
  }

  /** All ready tools across all servers, as framework `ToolDefinition`s. */
  allDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const [serverId, state] of this.states) {
      if (state.status !== "ready") continue;
      for (const tool of state.tools) {
        definitions.push(mcpToolToDefinition(serverId, tool));
      }
    }
    return definitions;
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const client = this.clients.get(serverId);
    if (!client) {
      return { ok: false, message: `MCP server "${serverId}" is not connected.` };
    }

    try {
      const result = (await client.callTool({ name: toolName, arguments: args })) as McpCallToolResult;
      return normalizeMcpResult(result);
    } catch (error) {
      return { ok: false, message: `MCP call "${serverId}__${toolName}" failed: ${String(error)}` };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
    this.states.clear();
    this.pendingAuth.clear();
    this.signIns.clear();
  }
}

let defaultManager: McpManager | null = null;

export function configureMcp(servers: McpAnyServerConfig[]): McpManager {
  defaultManager = new McpManager(servers);
  return defaultManager;
}

export function getMcpManager(): McpManager {
  if (!defaultManager) defaultManager = new McpManager();
  return defaultManager;
}

/** Connect + cache tools for the default manager. Call once at startup, before
 * the first render — mirrors `preloadPublicMarkdown`. */
export async function preloadMcpTools(): Promise<void> {
  await getMcpManager().connectAll();
}

/** Synchronous accessor used by `<Mcp>` during render. */
export function resolveMcpServer(serverId: string): McpServerState {
  return getMcpManager().resolve(serverId);
}

/** Env var that holds a server's bearer token, by convention: id `"linear"` →
 * `MCP_LINEAR_TOKEN`. Non-alphanumerics in the id become underscores. */
export function mcpTokenEnvVar(id: string): string {
  return `MCP_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

/**
 * Implicit credentials for an inline-declared server, so secrets never live in
 * agent code:
 * - an explicit `auth` prop always wins;
 * - else a static token from `MCP_<ID>_TOKEN` in the environment → `bearer`;
 * - else `oauth` (the user logs in once via the preview's MCP menu).
 */
export function resolveImplicitAuth(id: string, explicit?: McpAuth): McpAuth {
  if (explicit) return explicit;
  const token =
    typeof process !== "undefined" ? process.env?.[mcpTokenEnvVar(id)]?.trim() : undefined;
  if (token) return { kind: "bearer", token };
  return { kind: "oauth" };
}
