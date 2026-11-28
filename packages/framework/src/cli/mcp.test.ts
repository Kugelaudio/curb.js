import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpManager } from "../mcp/manager.js";
import { parseMcpToolsSnapshot } from "../mcp/snapshot.js";
import { mcpCommand } from "./mcp.js";

/** An in-process MCP server of an order system: two tools. */
function ordersServer(): McpServer {
  const server = new McpServer({ name: "orders", version: "0.0.0" });
  server.registerTool(
    "find_order",
    { description: "Find an order by its id.", inputSchema: { id: z.string().describe("The order id") } },
    async ({ id }) => ({ content: [{ type: "text", text: `Order ${id}` }] }),
  );
  server.registerTool("list_refunds", { description: "List the open refunds.", inputSchema: {} }, async () => ({ content: [] }));
  return server;
}

const roots: string[] = [];
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "curb-mcp-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function snapshot(root: string, manager: McpManager) {
  const printed: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((text: string) => void errors.push(text));
  const code = await mcpCommand(["snapshot"], root, {
    connect: async () => {
      await manager.connectAll();
      return manager;
    },
    out: (text) => void printed.push(text),
  });
  return { code, printed: printed.join(""), errors: errors.join("\n") };
}

describe("curb mcp snapshot", () => {
  it("writes each server's tools, with names, descriptions and schemas, sorted, to mcp.tools.json", async () => {
    const root = projectRoot();
    const { code, printed } = await snapshot(root, new McpManager([{ id: "orders", createServer: ordersServer }]));

    expect(code).toBe(0);
    expect(printed).toBe("Wrote mcp.tools.json: orders (2 tools). Commit it.\n");
    const written = parseMcpToolsSnapshot(readFileSync(join(root, "mcp.tools.json"), "utf8"));
    expect(written.format).toBe("curb.mcp-tools");
    expect(written.servers.orders!.tools.map((tool) => tool.name)).toEqual(["find_order", "list_refunds"]);
    expect(written.servers.orders!.tools[0]).toMatchObject({
      name: "find_order",
      description: "Find an order by its id.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The order id" } }, required: ["id"] },
    });
  });

  it("writes nothing and exits 1 when a server does not list its tools, naming it", async () => {
    const root = projectRoot();
    const manager = new McpManager([
      { id: "orders", createServer: ordersServer },
      { id: "billing", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } },
    ]);
    const { code, errors } = await snapshot(root, manager);

    expect(code).toBe(1);
    expect(errors).toContain("Nothing written: an MCP server did not list its tools.");
    expect(errors).toContain('Failed to connect MCP server "billing"');
    expect(existsSync(join(root, "mcp.tools.json"))).toBe(false);
  });

  it("writes nothing when the agent has no MCP server, and leaves out a disabled one", async () => {
    const root = projectRoot();
    const { code, printed } = await snapshot(root, new McpManager([{ id: "orders", createServer: ordersServer, enabled: false }]));

    expect(code).toBe(0);
    expect(printed).toContain("skipped orders: it is configured with enabled: false");
    expect(printed).toContain("The agent has no MCP server, so there is nothing to write to mcp.tools.json.");
    expect(existsSync(join(root, "mcp.tools.json"))).toBe(false);
  });

  it("names the commands it takes", async () => {
    await expect(mcpCommand([], projectRoot())).rejects.toThrow("curb mcp: give the command.");
    await expect(mcpCommand(["list"], projectRoot())).rejects.toThrow('curb mcp: unknown command "list".');
    await expect(mcpCommand(["snapshot", "--all"], projectRoot())).rejects.toThrow("curb mcp snapshot: unknown argument --all.");
  });
});
