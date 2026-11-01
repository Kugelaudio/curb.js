# `useRouter`

Loads a skill from code. Use it when a tool's result decides what comes next
([Complex handoffs](../complex-handoffs.md)).

```ts
import { useRouter } from "curb";

function useRouter(): { push: (path: string) => void };
```

## Returns

| Value | What it is |
|---|---|
| `push(path)` | Loads the skill and makes it active, as `read_skill` does for the model |

## Example

```tsx
function Triage() {
  const { push } = useRouter();
  return (
    <Tool
      name="caller_wants_to_cancel"
      description="The caller wants to cancel."
      onCall={() => {
        push("/cancellation");
        return { ok: true };
      }}
    />
  );
}
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `useRouter` introduced |
