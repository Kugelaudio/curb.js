# `createAgentStore`

Returns a hook on state that lasts the whole call and survives a skill leaving the request. Call it
once, at module level. A change re-renders the agent, so a tool gated on a store field appears and
leaves on its own ([State and conditional tools](../state.md)).

```ts
import { createAgentStore } from "curb";

function createAgentStore<T extends object>(key: string, initializer: StoreInitializer<T>): UseAgentStore<T>;
```

## Parameters

| Parameter | Type | What it is |
|---|---|---|
| `key` | `string` | The store's name, unique in the project |
| `initializer` | `(set, get) => T` | Returns the first state and its actions |

## Returns

A hook. `useClaim()` gives the whole state, and `useClaim((state) => state.verified)` one value.

## Example

```tsx
import { createAgentStore } from "curb";

export const useClaim = createAgentStore("claim", (set) => ({
  verified: false,
  verify: () => set({ verified: true }),
}));
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `createAgentStore` introduced |
