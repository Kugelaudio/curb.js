import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "./config.js";

/**
 * Node-only persistence for MCP servers added at runtime via the dashboard.
 * They live in `mcp.servers.json` next to the server's cwd — a plain JSON file
 * users can commit to share the setup with the team (tokens are NOT in here;
 * those live per-user in `.mcp-auth/`, which is gitignored).
 */

function storeFile(): string {
  return process.env.MCP_SERVERS_FILE ?? join(process.cwd(), "mcp.servers.json");
}

export function loadUserMcpServers(): McpServerConfig[] {
  let raw: string;
  try {
    raw = readFileSync(storeFile(), "utf8");
  } catch {
    // KEEP-JUSTIFIED: no file simply means no user-added servers yet.
    return [];
  }
  const parsed = JSON.parse(raw) as { servers?: McpServerConfig[] };
  if (!Array.isArray(parsed.servers)) {
    throw new Error(`Malformed ${storeFile()}: expected { "servers": [...] }.`);
  }
  return parsed.servers;
}

export function saveUserMcpServers(servers: McpServerConfig[]): void {
  writeFileSync(storeFile(), `${JSON.stringify({ servers }, null, 2)}\n`);
}
