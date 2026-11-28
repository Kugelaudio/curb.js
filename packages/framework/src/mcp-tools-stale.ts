/**
 * MCP_TOOLS_STALE: the committed `mcp.tools.json` no longer matches what an MCP server lists.
 *
 * `npx curb mcp snapshot` writes the tools of each MCP server of the project to `mcp.tools.json`
 * (their names, descriptions and input schemas), and a hermetic test run offers MCP tools from
 * that file without connecting to any server. When a server changes its tools, the tests go on
 * passing against tools the agent no longer gets. `curb check` compares the file with every
 * server it can reach; a server it cannot reach (offline, needs a sign-in) is not compared.
 */

import {
  AUTHORING_DIAGNOSTIC_CODES,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
} from "./authoring.js";
import type { McpToolInfo } from "./mcp/to-tool-definition.js";

/** The file's name, at the project root. */
export const MCP_TOOLS_FILE = "mcp.tools.json";

/** What `mcp.tools.json` holds: the tools each MCP server lists, by server id. */
export type McpToolsSnapshot = {
  format: "curb.mcp-tools";
  version: 1;
  servers: Record<string, { tools: McpToolInfo[] }>;
};

/** The snapshot in `text`, or why it is none. */
export function readMcpToolsSnapshot(text: string): { snapshot: McpToolsSnapshot } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { problem: `${MCP_TOOLS_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const record = value as Partial<McpToolsSnapshot> | null;
  if (!isRecord(record) || record.format !== "curb.mcp-tools" || record.version !== 1 || !isRecord(record.servers)) {
    return { problem: `${MCP_TOOLS_FILE} is not an MCP tools snapshot (format "curb.mcp-tools", version 1, servers)` };
  }
  for (const [id, server] of Object.entries(record.servers)) {
    const tools = isRecord(server) ? server.tools : undefined;
    if (!Array.isArray(tools) || tools.some((tool) => !isRecord(tool) || typeof tool.name !== "string" || !tool.name)) {
      return { problem: `${MCP_TOOLS_FILE}: servers.${id}.tools must be a list of tools, each with a name` };
    }
  }
  return { snapshot: record as McpToolsSnapshot };
}

/** The tool names the snapshot lists, by server id. */
export function snapshotToolNames(snapshot: McpToolsSnapshot): Record<string, string[]> {
  return Object.fromEntries(Object.entries(snapshot.servers).map(([id, server]) => [id, server.tools.map((tool) => tool.name)]));
}

/**
 * One warning per server whose tools, as it lists them now, differ from the snapshot's: a tool
 * added, removed, or with another description or input schema, and a server the file does not
 * hold at all. `listed` holds only the servers that answered.
 */
export function diagnoseMcpToolsStale(options: {
  agentId: string;
  snapshot: McpToolsSnapshot;
  listed: Readonly<Record<string, readonly McpToolInfo[]>>;
}): AuthoringDiagnostic[] {
  const { agentId, snapshot, listed } = options;
  const diagnostics: AuthoringDiagnostic[] = [];
  for (const id of Object.keys(listed).sort()) {
    const now = new Map(listed[id]!.map((tool) => [tool.name, tool] as const));
    const saved = snapshot.servers[id];
    let differences: string[];
    if (!saved) {
      differences = [`the file holds no tools of it, and it lists ${now.size}`];
    } else {
      const before = new Map(saved.tools.map((tool) => [tool.name, tool] as const));
      const added = [...now.keys()].filter((name) => !before.has(name)).sort();
      const removed = [...before.keys()].filter((name) => !now.has(name)).sort();
      const changed = [...now.keys()]
        .filter((name) => before.has(name) && toolText(before.get(name)!) !== toolText(now.get(name)!))
        .sort();
      differences = [
        ...(added.length > 0 ? [`it lists ${quoted(added)}, which the file does not`] : []),
        ...(removed.length > 0 ? [`the file holds ${quoted(removed)}, which it no longer lists`] : []),
        ...(changed.length > 0 ? [`${quoted(changed)} ${changed.length === 1 ? "has" : "have"} another description or input schema`] : []),
      ];
    }
    if (differences.length === 0) continue;
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.mcpToolsStale,
      severity: "warning",
      message: `${MCP_TOOLS_FILE} is out of date for MCP server "${id}": ${differences.join("; ")}. A hermetic test run offers the file's tools, not the server's.`,
      location: { agentId, source: MCP_TOOLS_FILE, component: `MCP server ${JSON.stringify(id)}` },
      fix: "Run `npx curb mcp snapshot` to write the file again, check that the tests still pass, and commit it.",
    });
  }
  return mergeAuthoringDiagnostics(diagnostics);
}

/** A tool as the model is told about it, with its schema's keys in a fixed order. */
function toolText(tool: McpToolInfo): string {
  return JSON.stringify(sorted({ description: tool.description ?? "", inputSchema: tool.inputSchema ?? null }));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(", ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
