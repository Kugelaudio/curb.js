import { createContext, useContext } from "react";
import { getMcpManager, type McpManager } from "./manager.js";

/** The MCP manager a runtime renders against when it has one of its own (a hermetic test call);
 * null renders against the process's default manager. */
export const McpManagerContext = createContext<McpManager | null>(null);

/** The MCP manager `<Mcp>` registers servers with, reads tools from and calls. */
export function useMcpManager(): McpManager {
  return useContext(McpManagerContext) ?? getMcpManager();
}
