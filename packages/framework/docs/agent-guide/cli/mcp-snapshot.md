# `curb mcp snapshot`

Connects to every MCP server of the agent and writes the tools each one lists to `mcp.tools.json`
at the project root: per server, each tool's name, description and input schema. A
[hermetic test](../testing.md#hermetic-runs) offers MCP tools from that file and never connects to
a server, so it runs with no network, no sign-in and no token.

```bash
npx curb mcp snapshot
```

The servers are those the agent declares (`defineAgent({ mcpServers })`), those added in the
preview of `curb dev` (`mcp.servers.json`), and every `<Mcp url>` a skill renders: the command
renders every skill once to find them. It uses the credentials a call uses (`MCP_<ID>_TOKEN` in
`.env`, or a sign-in from the preview), and waits at most 30 s for the servers to answer,
counted from the start, so a server that stalls while the agent connects it is reported rather
than waited for.

## Output

```text
Wrote mcp.tools.json: orders (2 tools). Commit it.
```

The servers and their tools are sorted by name, so the file changes only when a server's tools
do. Commit it, and run the command again when they change.

```json
{
  "format": "curb.mcp-tools",
  "version": 1,
  "servers": {
    "orders": {
      "tools": [
        {
          "name": "find_order",
          "description": "Find an order by its id.",
          "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }
      ]
    }
  }
}
```

A server configured with `enabled: false` has no tools to list and is left out.

## Exit codes

| Code | When |
|---|---|
| 0 | Every server listed its tools, or the agent has no MCP server (then nothing is written) |
| 1 | A server did not list its tools: it failed to connect, needs a sign-in, or did not answer in time. Nothing is written, and each such server is named with what to do |

## Version history

| Version | Changes |
|---|---|
| v1.30.0 | `curb mcp snapshot` introduced |
