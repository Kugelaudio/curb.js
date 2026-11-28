import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../project.node.js";
import { offerMcpToolsFrom, offeredMcpSnapshot } from "./manager.js";
import { MCP_TOOLS_FILE, parseMcpToolsSnapshot } from "./snapshot.js";

/** The file the snapshot on offer was read from. */
let offeredFrom: string | null = null;

/**
 * Offer MCP tools from the project's `mcp.tools.json` from now on (see `offerMcpToolsFrom`), so
 * no call of this process connects to an MCP server. A project with no MCP server needs no file;
 * one with servers and no file gets an error state per server that names the fix. Returns false
 * when servers were already connected for real in this process, whose tools then stay offered.
 * The file is read once per project root.
 */
export function offerSnapshotMcpTools(projectRoot = resolveProjectRoot()): boolean {
  const file = join(projectRoot, MCP_TOOLS_FILE);
  if (offeredMcpSnapshot() && offeredFrom === file) return true;
  offeredFrom = file;
  const snapshot = existsSync(file)
    ? parseMcpToolsSnapshot(readFileSync(file, "utf8"), MCP_TOOLS_FILE)
    : { format: "curb.mcp-tools" as const, version: 1 as const, servers: {} };
  return offerMcpToolsFrom(snapshot);
}
