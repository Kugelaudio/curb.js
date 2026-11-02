# MCP servers

Declare a remote MCP server inline, right where you use it, with no separate
config:

```tsx
<Mcp id="linear" url="https://mcp.linear.app/mcp" only={["create_issue"]} />
```

`id` is the tool namespace (`linear__create_issue`) and the credential key.
Placement is scope, like any tool: inside `<GlobalTools>` it is everywhere;
inside a skill it is scoped to that skill. `only` is an optional allowlist of
raw tool names. The server registers and connects on render; its tools appear
once it is ready.

**Credentials are implicit: never put a secret in agent code:**

- Omit `auth` → a bearer token from `MCP_<ID>_TOKEN` in `.env`
  (`id="linear"` → `MCP_LINEAR_TOKEN`) if present, else **OAuth**: the server
  parks until you log in once via the preview's "MCP servers" menu; tokens
  persist per-`id` in `.mcp-auth/<id>.json` (gitignored).
- Override with `auth={{ kind: "bearer", token }}` or `auth={{ kind: "none" }}`.

Alternatives: `defineAgent({ mcpServers: [{ id, url, enabled }] })` pre-registers
a server for eager connection before the first render; servers added at runtime
through the preview persist in the project's `mcp.servers.json` (tokens never
land there).

## Next steps

- [Components](./components/mcp.md): every prop of `<Mcp>`.
