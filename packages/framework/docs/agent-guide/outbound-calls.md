# Outbound calls

Your backend can ask a hosted agent to call someone, with what you already know about the call. Placing
the call goes through the [KugelAudio outbound calls API](https://docs.kugelaudio.com/hosted-agents/outbound-calls),
which is part of hosted agents, in closed alpha. This page covers the agent's side.

## Read what you sent

The request's `metadata` reaches the agent as `client.<key>`, from its first sentence, like a web
page's context ([Knowing the caller](./knowing-the-caller.md)).

## Greet like a caller

The agent reads `call.direction`: `outbound` when it placed the call. Open with who is
calling and why, and say that an AI speaks:

```tsx
import { Text, useAgentInfo, useClient } from "curb";

export function OutboundOpening() {
  const direction = useAgentInfo((info) => info["call.direction"]);
  const { name, topic } = useClient();
  if (direction !== "outbound") return null;
  return (
    <Text>
      You are calling {name ?? "the customer"} about {topic ?? "their request"}. Open with:
      "Hallo, hier ist die digitale Assistenz von Example." Then explain why you call.
    </Text>
  );
}
```

## Tell a callback from an incoming call

The agent reads `call.direction`: `outbound` when it is calling the visitor back, `inbound`
for every other call. Open a callback by saying who is calling, that the visitor asked for
the call, and that they are speaking with an AI:

```tsx
import { Text, useAgentInfo } from "curb";

export function CallbackGreeting() {
  const direction = useAgentInfo((info) => info["call.direction"]);
  return direction === "outbound" ? (
    <Text>
      You are calling the visitor back because they asked for a call on the website. Open
      with: "Hallo, hier ist die digitale Assistenz von Example. Sie hatten gerade einen
      Rückruf angefordert." Then help with their question.
    </Text>
  ) : null;
}
```

Render `<CallbackGreeting />` inside `<Agent>` in `src/agent/agent.tsx`, after
`<SystemPrompt>`. The widget's context reaches a callback too, so `useClient()` reads the
same keys as on a browser call (see
[Tell the agent where a call comes from](./web-calls.md#tell-the-agent-where-a-call-comes-from)).

## Forward the call

Any phone call can be put through to a person: see [Human handoff](./human-handoff.md).

## Next steps

- [Who speaks first](./who-speaks-first.md): set the opening line.
