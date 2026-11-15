# `<Handoff>`

Hands the caller to a person: put through to a number within the hours, a callback request
otherwise. It also hands off on its own when tools keep failing ([Human handoff](../human-handoff.md)).

```tsx
import { Handoff } from "curb";

function Handoff(props: HandoffProps): ReactNode;
```

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `to` | `string` | | The number a person answers, international format, like `+493012345678` |
| `hours` | `OpeningHours` or `(now: Date) => boolean \| Promise<boolean>` | always | When someone is there: `{ timeZone, open: { "mon-fri": "08:00-17:00", sat: ["09:00-12:00"] } }` |
| `afterFailures` | `number` or `false` | `3` | Hand off on its own after this many failed tool calls in a row, or this many turns without a reply in a row, 1 to 10; `false` never |
| `ringTimeoutSeconds` | `number` | `30` | How long it rings, 10 to 60 seconds |
| `onEnded` | decision or function | the agent takes the call back | What happens when the person hangs up and the caller stays ([When the person hangs up](../human-handoff.md#when-the-person-hangs-up)) |
| `onCallbackRequest` | `(request: CallbackRequest) => void \| Promise<void>` | none | Where a callback request goes; it is in the call's record either way |
| `name` | `string` | `handoff` | The handoff tool's name |
| `callbackName` | `string` | `request_callback` | The callback tool's name, offered only after a handoff reached nobody |

`CallbackRequest` is `{ name, phone, reason, summary }`. `reason` is `caller_requested`,
`agent_stuck` or `agent_failure`.

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
| v1.21.0 | `<Handoff>` introduced |
