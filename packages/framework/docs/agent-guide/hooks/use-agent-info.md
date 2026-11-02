# `useAgentInfo`

All the call's info, or one value with a selector. Which keys exist is in
[How a call opens](../voice-sessions.md#how-a-call-opens). The agent re-renders when a selected value
changes.

```ts
import { useAgentInfo } from "curb";

function useAgentInfo(): AgentInfo;
function useAgentInfo<T>(selector: (info: AgentInfo) => T): T;
```

## Example

```tsx
function Caller() {
  const number = useAgentInfo((info) => info["caller.phoneNumber"]);
  return number ? <Text>The caller's number is {String(number)}.</Text> : null;
}
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `useAgentInfo` introduced |
