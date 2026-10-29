import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * TEST-ONLY: a small in-process MCP server imitating a Linear-style issue
 * tracker, so unit tests can exercise the full manager/tool pipeline without
 * network calls or OAuth. It is not part of any agent's `mcpServers` and not
 * exported from the package — user-facing MCP support is remote-only.
 */
export function createLinearDemoServer(): McpServer {
  const server = new McpServer({ name: "linear-demo", version: "0.0.0" });

  const issues: Array<{ id: string; title: string; description: string; comments: string[] }> = [
    { id: "ENG-1", title: "Spike: evaluate MCP gateways", description: "Compare OSS options.", comments: [] },
  ];

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description: "List the issues in the workspace.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(issues.map(({ comments: _c, ...i }) => i)) }],
      structuredContent: { issues: issues.map(({ comments: _c, ...i }) => i) },
    }),
  );

  server.registerTool(
    "create_issue",
    {
      title: "Create issue",
      description: "Create a new issue with a title and optional description.",
      inputSchema: {
        title: z.string().describe("Short summary of the issue"),
        description: z.string().optional().describe("Longer details"),
      },
    },
    async ({ title, description }) => {
      const issue = {
        id: `ENG-${issues.length + 1}`,
        title,
        description: description ?? "",
        comments: [],
      };
      issues.push(issue);
      return {
        content: [{ type: "text", text: `Created ${issue.id}: ${issue.title}` }],
        structuredContent: { id: issue.id, title: issue.title },
      };
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a comment to an existing issue.",
      inputSchema: {
        issueId: z.string().describe("Issue id, e.g. ENG-1"),
        body: z.string().describe("Comment text"),
      },
    },
    async ({ issueId, body }) => {
      const issue = issues.find((candidate) => candidate.id === issueId);
      if (!issue) {
        return { isError: true, content: [{ type: "text", text: `No issue "${issueId}".` }] };
      }
      issue.comments.push(body);
      return { content: [{ type: "text", text: `Comment added to ${issueId}.` }] };
    },
  );

  return server;
}
