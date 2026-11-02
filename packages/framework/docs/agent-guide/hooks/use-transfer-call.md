# `useTransferCall`

Puts the caller through to a number from your own code ([Human handoff](../human-handoff.md)).

```ts
import { useTransferCall } from "curb";

function useTransferCall(): (request: TransferCallRequest) => Promise<TransferOutcome>;
```

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `to` | `string` | | The number in international format |
| `ringTimeoutSeconds` | `number` | `30` | How long it rings, 10 to 60 seconds |
| `announce` | `string` | none | Said to the caller before it dials |
| `onEnded` | decision or function | the agent takes the call back | What happens when the person hangs up and the caller stays ([When the person hangs up](../human-handoff.md#when-the-person-hangs-up)) |

## Returns

`outcome` is `answered`, `no_answer`, `busy`, `failed` or `refused`, beside `code`, `message` and
`transferId`. It never rejects for an outcome, and throws `TypeError` for a bad request.

## Example

```tsx
function ReachSales() {
  const transfer = useTransferCall();
  return (
    <Tool
      name="reach_sales"
      description="The caller asks for sales."
      onCall={async () => {
        const { outcome } = await transfer({ to: "+493012345678", announce: "One moment." });
        return { ok: outcome === "answered", message: outcome };
      }}
    />
  );
}
```

## Version history

| Version | Changes |
|---|---|
| v1.15.0 | `onEnded` added |
| v1.9.0 | `useTransferCall` introduced |
