# Functions

Everything else `curb` exports.

## Define an agent

| Function | What it does |
|---|---|
| [`defineAgent`](./functions/define-agent.md) | Declares the agent |
| [`createAgentStore`](./functions/create-agent-store.md) | State that lasts the whole call |
| [`defineTool`](./functions/define-tool.md) | Types the props of a `Tool` outside JSX |
| [`z`](./functions/z.md) | Zod, for validating input |

## Errors

See [Errors](./functions/errors.md).

| Error | Thrown when |
|---|---|
| `ToolInputError` | A handler refuses its input, with a message for the model |
| `isToolInputError` | Tests for that error |
| `AgentAuthoringError` | The agent is authored wrongly, with a code and a fix |
| `MessageRefusedError` | A message was refused by the app or the host |
| `HostUnavailableError` | `askHost` found no host connected |
| `HostTimeoutError` | `askHost` got no answer in time |
| `SettingsRefusedError` | A settings update is not allowed or not valid |

## Building on Curb

These are for programs built around Curb. An agent does not need them.

| Export | What it does |
|---|---|
| `AgentSession` | The conversation loop on a runtime |
| `AgentSiteRuntime` | The headless React host of one conversation |
| `AgentInfoStore` | The store behind `useAgentInfo` |
| `RouteProvider` | Provides the current skill's path to a tree |
| `AgentRouter` | Removed: renders nothing and warns with `AGENT_ROUTER_REMOVED` |
| `compileSite` | Compiles a semantic tree into context and tools |
| `flattenContext` | Compiled context as text lines |
| `createSemanticRoot` | A React root that renders into a semantic tree |
| `createSkillRoutes` | Routes from a project's skill modules |
| `skillPathFromModuleId` | A module's skill path |
| `titleFromSkillPath` | A readable title from a skill path |
| `listPublicMarkdown` | Lists `context/` files |
| `preloadPublicMarkdown` | Loads `context/` files |
| `resolvePublicMarkdown` | Reads one `context/` file |
| `validateSchemaInput` | Validates input |
| `zodSchemaToFields` | A Zod object as field descriptions |
| `diagnoseAgentAuthoring` | Runs the authoring checks |
| `formatAuthoringDiagnostic` | Prints a diagnostic |
| `mergeAuthoringDiagnostics` | Merges diagnostics without repeats |
| `AUTHORING_DIAGNOSTIC_CODES` | Every code ([Diagnostics](./diagnostics.md)) |
| `McpManager` | Connects to and calls MCP servers |
| `configureMcp` | Sets up the MCP manager |
| `getMcpManager` | The current MCP manager |
| `preloadMcpTools` | Connects the configured servers early |
| `resolveMcpServer` | Finds a configured server |
| `setMcpOAuthCallbackUrl` | Sets where MCP sign-in returns to |

## Next steps

- [Components](./components.md): what an agent renders.
- [Hooks](./hooks.md): what a component can read and do.
