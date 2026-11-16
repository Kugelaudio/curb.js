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

`maxCallsPerConversation` must be a whole number of 1 or more; anything else is an authoring error
when the tool renders. An `onlyAfter` that names a tool missing from the loaded context gets a
warning (the tool may live in a skill that is not loaded yet), and an `onlyAfter` that names the
tool itself is an error, because it can never run.
