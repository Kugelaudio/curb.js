import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * How the adapter authenticates to a remote server.
 *
 * - `oauth` (the default) runs the MCP authorization flow (OAuth 2.1 with
 *   dynamic client registration + PKCE): the manager surfaces an authorization
 *   URL, the user approves in the browser via the preview's "MCP servers"
 *   menu, and tokens are persisted per server for reuse.
 * - `bearer` sends a static token, for servers that hand out API keys.
 * - `none` for servers without authentication.
 */
export type McpAuth = { kind: "none" } | { kind: "bearer"; token: string } | { kind: "oauth" };

/**
 * One remote MCP server. This is the ONLY user-facing server kind — the
 * framework deliberately supports remote (streamable HTTP) servers only.
 * Register servers in the agent definition (`mcpServers`), then connect/log in from the
 * preview's "MCP servers" menu.
 */
export type McpServerConfig = {
  /** Stable id; also the tool namespace (`<id>__<tool>`). */
  id: string;
  /** The server's MCP endpoint, e.g. "https://mcp.linear.app/mcp". */
  url: string;
  /** Defaults to `oauth` — the common case for hosted MCP servers. */
  auth?: McpAuth;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Defaults to true. Set false to register a server without connecting;
   * connect it later from the preview. */
  enabled?: boolean;
};

/**
 * Test-only: an in-process server over a linked pair of in-memory transports,
 * so unit tests exercise the full manager/tool pipeline without network or
 * OAuth. Not part of the public config surface.
 * @internal
 */
export type McpInMemoryServerConfig = {
  id: string;
  enabled?: boolean;
  createServer: () => McpServer;
};

/** What the manager accepts: remote servers (public) or in-memory (tests). */
export type McpAnyServerConfig = McpServerConfig | McpInMemoryServerConfig;

/** Discriminator: remote configs have a `url`, in-memory ones a factory. */
export function isRemoteConfig(config: McpAnyServerConfig): config is McpServerConfig {
  return "url" in config;
}
