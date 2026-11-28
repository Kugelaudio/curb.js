// TEST-ONLY: a real MCP server of an order system, run as a child process by the tests, on
// streamable HTTP at 127.0.0.1 (the one transport Curb's MCP servers use). It prints
// `listening <port>` once it is up and `request <method>` for every request it answers, so a
// test can tell whether anything connected to it.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

function ordersServer() {
  const server = new McpServer({ name: "orders", version: "0.0.0" });
  server.registerTool(
    "find_order",
    { description: "Find an order by its id.", inputSchema: { id: z.string().describe("The order id") } },
    async ({ id }) => ({ content: [{ type: "text", text: `Order ${id} is paid.` }] }),
  );
  return server;
}

const http = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  process.stdout.write(`request ${req.method} ${body?.method ?? ""}\n`);
  // Stateless: a server and transport of their own for every request.
  const server = ordersServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});

http.listen(0, "127.0.0.1", () => {
  process.stdout.write(`listening ${http.address().port}\n`);
});
