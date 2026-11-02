# `defineAgent`

Declares the agent. `src/agent/agent.tsx` exports its result.

```ts
import { defineAgent } from "curb";

function defineAgent(definition: AgentDefinition): AgentDefinition;
```

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `app` | component | | The agent's React tree |
| `maxLoadedSkills` | `number` | `3` | Skills open at once. The least recently used leaves past this |
| `maxSteps` | `number` | `8` | Model steps per turn |
| `maxTranscriptMessages` | `number` | `60` | Messages sent to the model per step. The full transcript is kept |
| `timeZone` | `string` | `"UTC"` | An IANA time zone. Every request carries today's date and time in it |
| `firstTurn` | `"user"`, `"agent"`, `{ say }` | `"user"` | Who opens the call ([Who speaks first](../who-speaks-first.md)) |
| `mcpServers` | array | | Remote MCP servers ([MCP servers](../mcp.md)) |
| `goals` | object | | What counts as a successful call ([Goals and experiments](../goals-and-experiments.md)) |
| `experiments` | object | | A/B experiments, by name |
| `afterCall` | `CallHook` | | Runs once the call is over ([After-call code](../after-call-code.md)) |
| `afterEvaluation` | `CallHook` | | Runs once the call's goals are judged |
| `pipeline` | object | | Changes the LiveKit pipeline of voice calls ([Override the LiveKit pipeline](../livekit-pipeline.md)) |
| `preview` | `{ suggestedPrompts?, chatPlaceholder? }` | | Hints for the preview. Never reach the model |

It refuses a time zone that does not exist, a `firstTurn` no conversation can open with, goals or
experiments a host could not evaluate, and a hook that is not a function.

`CallHook`, `CallEvent` and `CallRecord` are the types of those functions and of what they receive.

## Example

```tsx
import { defineAgent } from "curb";

export const agent = defineAgent({ app: App, timeZone: "Europe/Berlin", firstTurn: "agent" });
```

## Version history

| Version | Changes |
|---|---|
| v1.15.0 | `afterCall`, `afterEvaluation` and `pipeline` added |
| v1.8.0 | `goals` and `experiments` added |
| v1.4.33 | `timeZone` added, and `firstTurn` takes `{ say }` |
| v0.3.0 | `firstTurn` added |
| v0.1.2 | `defineAgent` introduced |
