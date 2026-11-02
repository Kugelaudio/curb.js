# `<Mcp>`

Tools from an MCP server ([MCP servers](../mcp.md)).

```tsx
import { Mcp } from "curb";

function Mcp(props: McpProps): ReactNode;
```

## Props

| Prop | Type | What it does |
|---|---|---|
| `id` | `string` | A server configured in `defineAgent({ mcpServers })`, also the prefix of its tools (`<id>__<tool>`) |
| `url` | `string` | Declares the server here: no `mcpServers` entry is needed |
| `auth` | `{ kind: "none" }`, `{ kind: "bearer", token }`, `{ kind: "oauth" }` | Default: a bearer token from `MCP_<ID>_TOKEN` when it is set, else OAuth, signed in once in the preview |
| `headers` | object | Headers for each request |
| `only` | `string[]` | Keep only these tools |

With neither `id` nor `url`, it brings in every registered server. In `<GlobalTools>` the tools reach every
skill; in a skill, only that skill.

## Example

```tsx
<Mcp id="linear" url="https://mcp.linear.app/mcp" only={["search_issues"]} />
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<Mcp>` introduced |
