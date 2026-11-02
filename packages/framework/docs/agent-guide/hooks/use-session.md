# `useSession`

The effective providers, and this call's identity.

```ts
import { useSession } from "curb";

function useSession(): SessionView;
```

## Returns

| Value | What it is |
|---|---|
| `settings` | The effective providers |
| `call.sessionId` | The host's id for this call. On a LiveKit worker, the room name; in `curb dev`, the preview conversation's id |
| `call.scratchDir` | A writable directory of this call's own, removed when the call ends. Not set in `curb dev` |

`call` is set on every route that runs a call, and absent under `curb say` and `curb test`. Read a
call's identity here, never from `process.env`: a runner that serves several calls has one environment
for all of them.

## Example

```tsx
function CallInfo() {
  const { call } = useSession();
  return <Text>{call ? `Call ${call.sessionId}.` : "Not on a call."}</Text>;
}
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `useSession` introduced |
