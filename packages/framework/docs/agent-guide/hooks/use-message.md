# `useMessage`

Handles every message with that key for as long as the component is mounted
([App messages](../app-messages.md)).

```ts
import { useMessage } from "curb";

function useMessage<S extends z.ZodType>(key: string, options: UseMessageWithSchema<S>): void;
function useMessage(key: string, options: UseMessageWithoutSchema): void;
```

## Options

| Option | Type | What it does |
|---|---|---|
| `from` | `"client"` or `"host"` | Who may send it |
| `schema` | Zod schema | A payload it refuses is answered `invalid_payload` and never reaches `onMessage` |
| `onMessage` | `(payload, meta) => unknown` | What it returns is the reply to a client's `ask` |

## Example

```tsx
function Cart() {
  const [total, setTotal] = useState(0);
  useMessage("cart.updated", {
    from: "client",
    schema: z.object({ total: z.number() }),
    onMessage: ({ total }) => setTotal(total),
  });
  return <Text>The cart totals {total} euros.</Text>;
}
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `useMessage` introduced, replacing `useHostMessage` |
