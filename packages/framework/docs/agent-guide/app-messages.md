# App messages

An agent can talk to the page the caller is on, and to whatever hosts the call, without the model
being involved.

`useSend()` sends small keyed messages to the caller's app (`toClient`) or to whatever
hosts the call (`toHost`, `askHost`); `useMessage(key, { from, schema?, onMessage })`
handles what they send. A key is any non-empty string up to 256 characters.

```tsx
import { useState } from "react";
import { HostTimeoutError, HostUnavailableError, Text, Tool, useMessage, useSend, z } from "curb";

export function Claims() {
  const send = useSend();
  const [claimId, setClaimId] = useState<string | null>(null);
  const [supervisorOnline, setSupervisorOnline] = useState(false);

  // From the caller's app. The return value is the reply to the app's send.
  useMessage("claim-submitted", {
    from: "client",
    schema: z.object({ claimId: z.string() }),
    onMessage: ({ claimId }) => {
      setClaimId(claimId);
      return { received: true };
    },
  });
  // From the host.
  useMessage("ops.supervisor_online", { from: "host", onMessage: () => setSupervisorOnline(true) });

  return (
    <>
      {claimId !== null && <Text>{`The caller submitted claim ${claimId}.`}</Text>}
      {supervisorOnline && (
        <Tool
          name="ask_supervisor"
          description="Ask a human supervisor to approve a refund."
          onCall={async () => {
            send.toClient("show-status", { status: "waiting-for-supervisor" });
            try {
              const answer = await send.askHost("human.requested", { topic: "refund" });
              return { ok: true, data: answer };
            } catch (error) {
              if (error instanceof HostUnavailableError || error instanceof HostTimeoutError) {
                return { ok: false, message: "No supervisor is available. Offer a callback instead." };
              }
              throw error;
            }
          }}
        />
      )}
    </>
  );
}
```

- `from` is required: a `"client"` handler never sees a host message and vice versa.
- With a `schema`, `onMessage` gets the parsed payload; a payload it refuses never
  reaches `onMessage` and the sender gets `invalid_payload` with the issues.
- A message nobody listens for is refused `no_handler`; a handler that throws is
  `handler_failed`. Nothing is dropped silently.
- `toClient` with no app in the room yet, `toClient` on a phone call (no app), and
  `toHost` with no host are dropped with one warning per key and reason, and counted in the
  call record. `askHost` rejects `HostUnavailableError` with no host, and
  `HostTimeoutError` after `{ timeoutMs }` (default 10000).
- After a `useMessage` handler runs the context is recompiled, so a store change it
  makes can unlock a skill or tool, like any other gate.
- Each call has its own messages. The wire formats (host protocol and LiveKit) are in
  [Host protocol](./host-protocol.md#app-messages).

## Ask for feedback at the end of a call

Make the question a tool. When the caller answers, the agent calls the tool, and the
tool sends the answer to KugelAudio with `send.toHost`. The answer is kept with the call
as its data.

In `src/agent/agent.tsx`, add a component that renders the tool in `<GlobalTools>`, and
put `<Feedback />` inside `<Agent>`, beside `<Skills>`, so that the tool exists wherever
the conversation ends. `GlobalTools`, `Tool`, `useSend` and `z` come from `"curb"`.

```tsx
function Feedback() {
  const send = useSend();
  return (
    <GlobalTools>
      <Tool
        name="record_feedback"
        description="Record the caller's answer to the feedback question at the end of the call."
        schema={z.object({
          rating: z
            .number()
            .int()
            .min(1, "Ask for a number from 1 to 5.")
            .max(5, "Ask for a number from 1 to 5.")
            .describe("The caller's rating, from 1 (poor) to 5 (excellent)."),
          comment: z
            .string()
            .max(500)
            .optional()
            .describe("Anything else the caller said about the call, in their words."),
        })}
        success="Feedback recorded."
        onSubmit={(input) => {
          send.toHost("feedback", input);
          return { ok: true };
        }}
      />
    </GlobalTools>
  );
}
```

`send.toHost("feedback", input)` sends the rating and the comment under the name
`feedback`. It doesn't wait for a reply, and KugelAudio never replies, so use `toHost`
rather than `askHost`.

Then tell the agent when to ask, in its `<SystemPrompt>`:

```text
When the caller has what they called for, ask: "Before you go, how would you rate this
call from 1 to 5?" Call record_feedback with the answer, then say goodbye and end the
call. If the caller does not want to answer, end the call without asking again.
```

Open a call on the agent's **Calls** page: its **Data** tab shows `feedback` with the
rating and the comment. If the agent sends `feedback` more than once in a call, the tab
shows the latest answer, and lists every send with its time in the call under
**Sent N times**.

- `npm run dev` has no host, so there the message is dropped and the terminal shows a
  warning. To see the answer on the **Data** tab, deploy the agent and call it from its
  **Playground** in the dashboard.
- One message carries at most 16 KB of data. A larger one is not cut short: the **Data**
  tab says it was not kept, and none of it is stored.
- A call that starts while the agent keeps nothing keeps none of what the agent sends
  either (see [the recording notice](./web-calls.md#show-a-recording-notice-before-the-call)).
- Never send secrets, passwords or card numbers. What the agent sends is stored with the
  call, like what the caller says.

To keep every answer in a system of your own as well, send it there from `onSubmit`, as
in the next recipe.

## Next steps

- [Host protocol](./host-protocol.md#app-messages): the wire format.
