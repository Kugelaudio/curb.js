import type { ToolDefinition, ToolInputSchema, ToolResult } from "../types.js";

/** The subset of an MCP `tools/list` entry we rely on. */
export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** Result shape returned by the SDK's `client.callTool`. */
export type McpCallToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

export function namespacedToolName(serverId: string, toolName: string): string {
  return `${serverId}__${toolName}`;
}

/**
 * Pass the MCP tool's JSON Schema through verbatim (the model needs the real
 * schema to call the tool). Fall back to an empty object schema when a server
 * omits one. The `ToolInputSchema` type intentionally allows arbitrary nested
 * JSON Schema, so no lossy flattening happens here.
 */
function toInputSchema(raw: unknown): ToolInputSchema {
  if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "object") {
    const schema = raw as ToolInputSchema;
    return { ...schema, properties: schema.properties ?? {} };
  }

  return { type: "object", properties: {}, additionalProperties: false };
}

export function mcpToolToDefinition(serverId: string, tool: McpToolInfo): ToolDefinition {
  return {
    id: `mcp:${serverId}:${tool.name}`,
    name: namespacedToolName(serverId, tool.name),
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema),
    // Default for out-of-tree consumers (`McpManager.allDefinitions`). Inside
    // the agent tree the compiler assigns the real scope from where <Mcp> is
    // placed: <GlobalTools> -> "global", inside a skill page -> "page".
    scope: "global",
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Normalize MCP's two failure surfaces (tool ran but failed → `isError`, vs. the
 * request itself failed → thrown earlier by the caller) into our `ToolResult`.
 * No silent failures: an errored call always becomes `{ ok: false, message }`.
 */
export function normalizeMcpResult(result: McpCallToolResult): ToolResult {
  if (result.isError) {
    return {
      ok: false,
      message: textFromContent(result.content) || "MCP tool returned an error.",
      data: result,
    };
  }

  return { ok: true, data: result.structuredContent ?? result.content };
}
