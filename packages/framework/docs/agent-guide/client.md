# Client

`curb/client` is the browser side of a call, for your own page on your own host. It needs a LiveKit
room you already joined.

| Export | What it does |
|---|---|
| `connectAgent` | Connects to the agent in a room |
| `AgentRefusedError` | The agent refused a request. Has `code`, `issues` and `path` |
| `AgentUnavailableError` | No agent answered in time |
| `DEFAULT_AGENT_TIMEOUT_MS` | The timeout of a request, 10000 |
| `MAX_CLIENT_MESSAGE_BYTES` | The largest message |

## `connectAgent`

```ts
import { connectAgent } from "curb/client";

const agent = connectAgent(room);
agent.on("cart.updated", (payload) => render(payload));
await agent.send("page.changed", { path: location.pathname });
```

`connectAgent(room, { agentIdentity? })` returns an object with these:

| Method | What it does |
|---|---|
| `send(key, payload?)` | Sends a message the agent handles with `useMessage` |
| `ask(key, payload?)` | The same, and resolves with what `onMessage` returned |
| `on(key, handler)` | Handles a message from `send.toClient`. Returns a function that stops it |
| `update(settings)` | Changes a setting of `<Agent adjustable>`, and resolves with the effective settings |
| `close()` | Stops listening |

`agentIdentity` picks the agent in a room with several participants.

## Next steps

- [App messages](./app-messages.md): the agent's side of these messages.
- [Mid-call changes](./mid-call-changes.md): what `update` can change.
