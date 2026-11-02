# `useClient`

What the caller's page said, the `client.*` values without the prefix. Anyone can edit a link, so it
is never proof of identity ([Knowing the caller](../knowing-the-caller.md)).

```ts
import { useClient } from "curb";

function useClient(): ClientInfo;
```

## Example

```tsx
function PageTopic() {
  const { topic } = useClient();
  return topic ? <Text>The caller came from the page about {topic}.</Text> : null;
}
```

## Version history

| Version | Changes |
|---|---|
| v1.4.33 | `useClient` introduced |
