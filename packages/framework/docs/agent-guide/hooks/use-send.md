# `useSend`

Sends a message to the caller's page or the host, without the model ([App messages](../app-messages.md)).

```ts
import { useSend } from "curb";

function useSend(): MessageSender;
```

## Returns

| Method | What it does |
|---|---|
| `toClient(key, payload?)` | Sends to the caller's page. A phone call has no page, so it is dropped with a warning |
| `toHost(key, payload?)` | Sends to the host. With no host, it is dropped with a warning |
| `askHost(key, payload?, { timeoutMs? })` | Sends to the host and resolves with its reply's payload. Rejects with `HostUnavailableError`, or `HostTimeoutError` after `timeoutMs` (10000) |

## Example

```tsx
function ShowClaim() {
  const send = useSend();
  return (
    <Tool
      name="show_claim"
      description="Show the open claim on the caller's screen."
      onCall={() => {
        send.toClient("claim.show", { id: "C-1" });
        return { ok: true };
      }}
    />
  );
}
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `useSend` introduced, replacing `useHost` |
