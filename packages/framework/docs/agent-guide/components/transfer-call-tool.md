# `<TransferCallTool>`

A ready tool that puts the caller through to a number and tells the model what happened
([Human handoff](../human-handoff.md)).

```tsx
import { TransferCallTool } from "curb";

function TransferCallTool(props: TransferCallToolProps): ReactNode;
```

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `to` | `string` | | The number in international format, like `+493012345678` |
| `name` | `string` | `transfer_call` | The tool's name |
| `description` | `string` | says what it does | When the model should call it |
| `ringTimeoutSeconds` | `number` | `30` | How long it rings, 10 to 60 seconds |
| `onEnded` | decision or function | the agent takes the call back | What happens when the person hangs up and the caller stays ([When the person hangs up](../human-handoff.md#when-the-person-hangs-up)) |
| `warm` | `true` or `{ consultTimeoutSeconds? }` | off | Ask the person at the number first ([Warm transfer](../human-handoff.md#warm-transfer)). The model then also writes a `brief`, what the agent tells them; `consultTimeoutSeconds` (10 to 120, default 45) is how long they have to answer from their pickup; a reply given in time is still read |

## Example

```tsx
<TransferCallTool to="+493012345678" description="The caller asks for a person." ringTimeoutSeconds={20} />
```

With `warm`, the caller is put through only when the person says yes:

```tsx
<TransferCallTool to="+493012345678" warm={{ consultTimeoutSeconds: 30 }} />
```

## Version history

| Version | Changes |
|---|---|
| v1.29.0 | `warm` added |
| v1.15.0 | `onEnded` added |
| v1.9.0 | `<TransferCallTool>` introduced |
