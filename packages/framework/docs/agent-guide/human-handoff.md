# Human handoff

Put the caller through to a person, and have a way out when nobody answers.

Project: `examples/human-handoff`. Put the caller through to a person, and have a way out when
nobody answers.

```tsx
import { Agent, GlobalTools, SystemPrompt, Tool, TransferCallTool, z } from "curb";

<Agent>
  <SystemPrompt>
    When the caller asks for a person, call transfer_call straight away.
    When the transfer fails, tell them nobody could be reached and offer a callback.
  </SystemPrompt>
  <GlobalTools>
    <TransferCallTool to="+493012345678" ringTimeoutSeconds={25} />
    <Tool
      name="request_callback"
      description="Ask the support desk to call the caller back."
      schema={z.object({ phone: z.string().describe("The number to call back on.") })}
      success="The callback is recorded."
      onSubmit={(input) => {
        // Send it where someone reads it: your own API here, or send.toHost (below).
        return { ok: true, data: input };
      }}
    />
  </GlobalTools>
</Agent>
```

The model passes one sentence as `announce`, which the caller hears before anything is
dialed. They then hear a ringback tone. The model reads the outcome in plain words. When the
person leaves and the caller is still there, the agent takes the call back. A mailbox that picks
up counts as answered, so switch it off on the target number.

A transfer needs a host that dials: KugelAudio does on a hosted phone call, with the conditions in
[Outbound calls and forwarding](https://docs.kugelaudio.com/hosted-agents/outbound-calls), and your
own host can ([Host protocol](./host-protocol.md#transfer-on-your-own-host)). In `curb dev` and on a browser
call it is refused.

Under `curb say` and `curb test` no host answers, so a real transfer ends as `failed` and your
fallback runs: leave the tool unfaked to test that. To test the path where someone picks up, fake
it. A fake replaces the tool's handler, so anything the handler would have set stays unset.

## Transfer from your own code

On a hosted phone call the agent can put the caller through to another number. The
ready tool lets the model do it; `useTransferCall()` is the same thing for your own code.

```tsx
import { Instruction, TransferCallTool, Tool, useTransferCall } from "curb";

export function Handover() {
  const transfer = useTransferCall();
  return (
    <>
      <Instruction>When the caller asks for a person, call transfer_call.</Instruction>
      <TransferCallTool to="+493012345678" ringTimeoutSeconds={25} />
      <Tool
        name="call_claims_desk"
        description="Put the caller through to the claims desk."
        onCall={async () => {
          const { outcome } = await transfer({
            to: "+493098765432",
            announce: "One moment, I am connecting you to the claims desk.",
          });
          return { ok: outcome === "answered", message: `Transfer: ${outcome}.` };
        }}
      />
    </>
  );
}
```

- `transfer({ to, ringTimeoutSeconds?, announce?, onEnded? })` resolves
  `{ outcome, code?, message?, transferId? }` with `outcome` one of `answered`, `no_answer`,
  `busy`, `failed`, `refused`. It never rejects for an outcome; a bad `to`, a
  `ringTimeoutSeconds` outside 10 to 60, a blank `announce` or an `onEnded` that is not one
  ([below](#when-the-person-hangs-up)) throws `TypeError` (on `<TransferCallTool>`, an
  authoring error when it renders).
- The caller never waits in silence. `announce` is said first, in the agent's voice: it
  cannot be interrupted, and the number is dialed only once it has played. Without
  `announce` nothing is said. Then the caller hears a ringback tone (425 Hz, 1 s on, 4 s
  off) until the outcome arrives, whatever it is, or the call ends. Outside a phone call
  nothing plays.
- `answered`: the target is in the call and the agent is handed off: it stops listening
  and speaking. When the target leaves and the caller is still there, the agent takes the
  call back and is told the transfer ended, unless `onEnded` says otherwise (below). The
  caller hanging up ends the call.
- `refused`: nothing was dialed, and one error line in the log names the code.
  `upgrade_required` means the plan has no `outbound-calls` feature;
  `transfer_unsupported_session` means this is not a phone call (a browser session or
  `curb dev`), where transfers never work; `transfer_in_progress`, one transfer at a time.
- `failed` with code `transfer_no_reply`: the host did not answer the request within 20 s,
  or sent no result within the ring time plus 30 s.
- `<TransferCallTool>` takes `to`, and optionally `name` (default `transfer_call`),
  `description`, `ringTimeoutSeconds` and `onEnded`. The model calls it with `announce`, the one
  sentence it says to the caller before connecting ("One moment, I am connecting you to our
  sales team."); a call without one is refused and nobody is dialed, so the model calls
  again with it. The tool tells the model each outcome in plain words ("nobody answered",
  "the line was busy") so it can tell the caller.

A refused transfer comes back as `outcome: "refused"` with a `code`:

| `code` | Why |
|---|---|
| `upgrade_required` | The organization's plan has no outbound calls |
| `transfer_unsupported_session` | Not a phone call (a browser call or the preview) |
| `transfer_unsupported_number` | The call's number is from your own Twilio or Telnyx account |
| `transfer_in_progress` | Another transfer of this call is still ringing |
| `callback_destination_blocked` | The number is outside Germany, Austria and Switzerland, or premium-rate |

## When the person hangs up

By default, when the person the call was put through to hangs up and the caller is still
there, the agent takes the call back. A transfer's `onEnded` decides instead:

```tsx
import { TransferCallTool } from "curb";

export function Handover() {
  return (
    <>
      {/* After sales, the call is done. */}
      <TransferCallTool
        name="transfer_sales"
        to="+493011111111"
        onEnded={{ action: "end_call", goodbye: "Thank you for calling. Goodbye!" }}
      />
      {/* After support, the agent continues with its own instruction. */}
      <TransferCallTool
        name="transfer_support"
        to="+493022222222"
        onEnded={{ action: "continue", instruction: "Ask whether support could solve the problem." }}
      />
    </>
  );
}
```

`transfer({ to, onEnded })` takes the same option.

- `{ action: "end_call", goodbye? }` ends the call. `goodbye` is said first, in the agent's
  voice, and cannot be interrupted; without it the call ends at once. A goodbye that fails, or
  has not finished after 20 s, is reported and the call ends anyway.
- `{ action: "continue", instruction? }` gives the call back to the agent. `instruction` says
  what it does next; without it, as without `onEnded`, the agent tells the caller the other
  person left and asks whether it can help with anything else.
- `onEnded` may also be a function, sync or async, that gets `{ to, transferId }` and returns
  a decision, or nothing to continue:
  `onEnded={async () => ((await ticketSolved()) ? { action: "end_call" } : undefined)}`.
- The agent stays quiet until the decision is made. A function that throws, returns
  something else, or takes longer than 5 s is logged and the agent continues, so the caller
  is never left alone. When the caller hangs up, the call ends and `onEnded` is not asked.

## Next steps

- [Complex handoffs](./complex-handoffs.md): hand over by code, to a skill, or with a note.
