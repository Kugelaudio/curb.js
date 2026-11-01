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

## Example

```tsx
<TransferCallTool to="+493012345678" description="The caller asks for a person." ringTimeoutSeconds={20} />
```

## Version history

| Version | Changes |
|---|---|
| v1.15.0 | `onEnded` added |
| v1.9.0 | `<TransferCallTool>` introduced |
