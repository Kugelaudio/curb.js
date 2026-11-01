# `useRoutePath`

The path of the skill this component renders in, or `null` at the agent level.

```ts
import { useRoutePath } from "curb";

function useRoutePath(): string | null;
```

## Example

```tsx
function WhereAmI() {
  const path = useRoutePath();
  return path === "/claims" ? <Text>You are in the claims skill.</Text> : null;
}
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `useRoutePath` introduced |
