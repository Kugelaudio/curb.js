import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../project.node.js";
import { MCP_TOOLS_FILE, NO_MCP_TOOLS, parseMcpToolsSnapshot, type McpToolsSnapshot } from "./snapshot.js";

/**
 * The MCP tools a hermetic call offers: the project's `mcp.tools.json`. A project with no file
 * offers none ({@link NO_MCP_TOOLS}): one with no MCP server needs no file, and each server of one
 * that has servers gets an error state that names the fix. Throws `[MCP_TOOLS_INVALID]` on a file
 * that is not a snapshot.
 */
export function readMcpToolsSnapshot(projectRoot = resolveProjectRoot()): McpToolsSnapshot {
  const file = join(projectRoot, MCP_TOOLS_FILE);
  return existsSync(file) ? parseMcpToolsSnapshot(readFileSync(file, "utf8"), MCP_TOOLS_FILE) : NO_MCP_TOOLS;
}
