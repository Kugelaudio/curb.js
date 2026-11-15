# `<Handoff>`

Hands the caller to a person: put through to a number within the hours, a callback request
otherwise. It also hands off on its own when something is not working, and, when you ask for it,
when the caller's requests keep failing ([Human handoff](../human-handoff.md)).

```tsx
import { Handoff } from "curb";

function Handoff(props: HandoffProps): ReactNode;
```

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `to` | `string` | | The number a person answers, international format, like `+493012345678` |
| `hours` | `OpeningHours` or `(now: Date) => boolean \| Promise<boolean>` | always | When someone is there: `{ timeZone, open: { "mon-fri": "08:00-17:00", sat: ["09:00-12:00"] } }` |
| `afterErrors` | `number` or `false` | `3` | Hand off on its own when something is not working: after this many tool calls in a row threw, or this many turns in a row got no reply, 1 to 10; `false` never |
| `afterFailedAttempts` | `number` or `false` | `false` | Hand off on its own when nothing is broken but the agent gets nowhere: after this many tool calls in a row answered `ok: false` ("That slot is taken"), 1 to 10; `false` leaves it to the model |
| `ringTimeoutSeconds` | `number` | `30` | How long it rings, 10 to 60 seconds |
| `onEnded` | decision or function | the agent takes the call back | What happens when the person hangs up and the caller stays ([When the person hangs up](../human-handoff.md#when-the-person-hangs-up)) |
| `onCallbackRequest` | `(request: CallbackRequest) => void \| Promise<void>` | none | Where a callback request goes; it is in the call's record either way |
| `name` | `string` | `handoff` | The handoff tool's name |
| `callbackName` | `string` | `request_callback` | The callback tool's name, offered only after a handoff reached nobody |

`CallbackRequest` is `{ name, phone, reason, summary }`. `reason` is `caller_requested`,
`agent_stuck` or `agent_failure`.

`afterFailures` is the old name of `afterErrors` and still sets it when `afterErrors` is not
given.

## Example

```tsx
<GlobalTools>
  <Handoff
    to="+493012345678"
    hours={{ timeZone: "Europe/Berlin", open: { "mon-fri": "08:00-17:00" } }}
    onCallbackRequest={(request) => tickets.create(request)}
  />
</GlobalTools>
```

## Version history

| Version | Changes |
|---|---|
| v1.22.0 | `afterFailures` renamed `afterErrors`, and a tool result with `ok: false` no longer counts toward it; `afterFailedAttempts` added |
| v1.21.0 | `<Handoff>` introduced |
