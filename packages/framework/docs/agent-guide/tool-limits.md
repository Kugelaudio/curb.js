# Tool limits

Some rules should hold however the model reasons: a refund tool that runs at most once, a
cancellation that must come after the caller was verified. Put them on the tool, and the
framework enforces them instead of the prompt.

| Prop | Type | What it does |
|---|---|---|
| `maxCallsPerConversation` | `number` | The most times the model may call the tool in one conversation |
| `onlyAfter` | `string` | The name of a tool that must have succeeded earlier in the conversation |

A call that breaks a limit is refused: the model gets a failed result with a fixed message, and
the handler does not run. A refused call does not count toward `maxCallsPerConversation`, and neither does a call whose input fails the tool's schema. A tool
without either prop behaves as it always did.

## Example

```tsx
import { Agent, Tool, z } from "curb";

<Agent>
  <Tool
    name="verify_caller"
    description="Check the caller's date of birth against the account."
    schema={z.object({ dateOfBirth: z.iso.date() })}
    onSubmit={async ({ dateOfBirth }) => ({ ok: await accounts.verify(dateOfBirth) })}
  />
  <Tool
    name="issue_refund"
    description="Refund the last order."
    onlyAfter="verify_caller"
    maxCallsPerConversation={1}
    onCall={async () => {
      await orders.refundLast();
      return { ok: true, message: "The refund was issued." };
    }}
  />
</Agent>;
```

Before `verify_caller` succeeds, `issue_refund` returns
`"issue_refund" is not available yet: "verify_caller" has to succeed first.` A second successful call
returns `"issue_refund" has reached its limit of 1 call in this conversation and cannot be called again.`
Neither runs `onCall`.

A call that passed validation and then failed counts toward `maxCallsPerConversation`, and a prerequisite counts only
once a call of it returned `ok: true`. See [`<Tool>`](./components/tool.md) for the other props.

## Checks

A wrong declaration throws an authoring error as soon as the tool renders: a
`maxCallsPerConversation` that is not a whole number of 1 or more, an `onlyAfter` that names no tool
in the loaded context, or one that names the tool itself. Render the prerequisite tool in the same
skill or in the agent, so it is loaded whenever the gated tool is.
