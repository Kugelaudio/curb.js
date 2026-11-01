# Functions

Everything else `curb` exports.

## Define an agent

| Function | What it does |
|---|---|
| `defineAgent` | Declares the agent |
| `createAgentStore` | State that lasts the whole call |
| `defineTool` | Types the props of a `Tool` outside JSX |
| `z` | Zod, for validating input |

### `defineAgent`

```tsx
import { defineAgent } from "curb";

export const agent = defineAgent({ app: App, timeZone: "Europe/Berlin", firstTurn: "agent" });
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `app` | component | | The agent's React tree |
| `maxLoadedSkills` | `number` | `3` | Skills open at once. The least recently used leaves past this |
| `maxSteps` | `number` | `8` | Model steps per turn |
| `maxTranscriptMessages` | `number` | `60` | Messages sent to the model per step. The full transcript is kept |
| `timeZone` | `string` | `"UTC"` | An IANA time zone. Every request carries today's date and time in it |
| `firstTurn` | `"user"`, `"agent"`, `{ say }` | `"user"` | Who opens the call ([Who speaks first](./who-speaks-first.md)) |
| `mcpServers` | array | | Remote MCP servers ([MCP servers](./mcp.md)) |
| `goals` | object | | What counts as a successful call ([Goals and experiments](./goals-and-experiments.md)) |
| `experiments` | object | | A/B experiments, by name |
| `afterCall` | `CallHook` | | Runs once the call is over ([After-call code](./after-call-code.md)) |
| `afterEvaluation` | `CallHook` | | Runs once the call's goals are judged |
| `pipeline` | object | | Changes the LiveKit pipeline of voice calls ([Override the LiveKit pipeline](./livekit-pipeline.md)) |
| `preview` | `{ suggestedPrompts?, chatPlaceholder? }` | | Hints for the preview. Never reach the model |

It refuses a time zone that does not exist, a `firstTurn` no conversation can open with, goals or
experiments a host could not evaluate, and a hook that is not a function.

`CallHook`, `CallEvent` and `CallRecord` are the types of those functions and of what they receive.

### `createAgentStore`

```ts
import { createAgentStore } from "curb";

export const useClaim = createAgentStore("claim", (set) => ({
  verified: false,
  verify: () => set({ verified: true }),
}));
```

`createAgentStore(key, initializer)` returns a hook on state that lasts the whole call and survives a
skill leaving the request. Call it once, at module level. A change re-renders the agent, so a tool
gated on a store field appears and leaves on its own ([State and conditional tools](./state.md)).

### `defineTool`

```ts
const openClaim = defineTool({
  name: "open_claim",
  description: "Open a claim.",
  schema: z.object({ policy: z.string() }),
  onSubmit: async ({ policy }) => ({ ok: true, message: `Opened for ${policy}.` }),
});

<Tool {...openClaim} />
```

### `z`

[Zod](https://zod.dev), re-exported so a project needs no dependency of its own.

## Errors

| Error | Thrown when |
|---|---|
| `ToolInputError` | A handler refuses its input, with a message for the model |
| `isToolInputError` | Tests for that error |
| `AgentAuthoringError` | The agent is authored wrongly, with a code and a fix |
| `MessageRefusedError` | A message was refused by the app or the host |
| `HostUnavailableError` | `askHost` found no host connected |
| `HostTimeoutError` | `askHost` got no answer in time |
| `SettingsRefusedError` | A settings update is not allowed or not valid |

### `ToolInputError`

```ts
import { ToolInputError } from "curb";

throw new ToolInputError("That policy number has eight digits.");
```

The model reads the message and can ask the caller again. `data` is optional:
`new ToolInputError(message, { data })`.

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
