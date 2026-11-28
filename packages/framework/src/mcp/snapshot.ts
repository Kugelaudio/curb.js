import type { McpToolInfo } from "./to-tool-definition.js";

/**
 * `mcp.tools.json`: the tools each MCP server of the project lists, written by `curb mcp snapshot`
 * and committed. A hermetic test run offers MCP tools from it and never connects to a server, so
 * it runs with no network, no sign-in and no token.
 */

/** The file's name, at the project root. */
export const MCP_TOOLS_FILE = "mcp.tools.json";

export type McpToolsSnapshot = {
  format: "curb.mcp-tools";
  version: 1;
  /** Each server's tools, by server id: name, description and input schema as it lists them. */
  servers: Record<string, { tools: McpToolInfo[] }>;
};

/** A snapshot that lists no server: what a project with no `mcp.tools.json` offers. */
export const NO_MCP_TOOLS: McpToolsSnapshot = Object.freeze({ format: "curb.mcp-tools", version: 1, servers: Object.freeze({}) });

/** A snapshot of `servers`, its servers and tools sorted by name so the file diffs cleanly. */
export function mcpToolsSnapshot(servers: Readonly<Record<string, readonly McpToolInfo[]>>): McpToolsSnapshot {
  const sorted = Object.keys(servers).sort();
  return {
    format: "curb.mcp-tools",
    version: 1,
    servers: Object.fromEntries(
      sorted.map((id) => [
        id,
        {
          tools: [...servers[id]!]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((tool) => ({
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            })),
        },
      ]),
    ),
  };
}

/** `snapshot` as the file holds it. */
export function formatMcpToolsSnapshot(snapshot: McpToolsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** The snapshot in `text` (the file `file`), or an error naming what is wrong and how to fix it. */
export function parseMcpToolsSnapshot(text: string, file: string = MCP_TOOLS_FILE): McpToolsSnapshot {
  const refresh = "Fix: run `npx curb mcp snapshot` with the servers reachable to write it again.";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`[MCP_TOOLS_INVALID] ${file} is not JSON: ${error instanceof Error ? error.message : String(error)}.\n${refresh}`);
  }
  const record = value as Partial<McpToolsSnapshot> | null;
  if (!record || typeof record !== "object" || record.format !== "curb.mcp-tools" || record.version !== 1 || !isRecord(record.servers)) {
    throw new Error(`[MCP_TOOLS_INVALID] ${file} is not an MCP tools snapshot (format "curb.mcp-tools", version 1, servers).\n${refresh}`);
  }
  for (const [id, server] of Object.entries(record.servers)) {
    const tools = isRecord(server) ? (server as { tools?: unknown }).tools : undefined;
    if (!Array.isArray(tools) || tools.some((tool) => !isRecord(tool) || typeof tool.name !== "string" || !tool.name)) {
      throw new Error(`[MCP_TOOLS_INVALID] ${file}: servers.${id}.tools must be a list of tools, each with a name.\n${refresh}`);
    }
  }
  return record as McpToolsSnapshot;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
