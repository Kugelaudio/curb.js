# `<Tool>`

What the model can call. A tool that is not rendered is not in the request
([State and conditional tools](../state.md)).

```tsx
import { Tool } from "curb";

function Tool(props: ToolProps): ReactNode;
```

## Props

Every tool takes these:

| Prop | Type | What it does |
|---|---|---|
| `name` | `string` | The name the model calls |
| `description` | `string` | When to call it, for the model |
| `icon` | `string` | A [lucide](https://lucide.dev/icons) icon name for the preview. Never reaches the model |

Then one of three ways to take input:

| Form | Props | Use it for |
|---|---|---|
| Schema | `schema`, `onSubmit`, `tryWith` | Most tools: a Zod object, and typed input in `onSubmit` |
| Fields | [`<Field>`](./field.md) children, `onSubmit`, `tryWith` | A few flat fields |
| No input | `onCall` | A tool that takes nothing |

`onSubmit` and `onCall` return a `ToolResult`, `{ ok, message?, data? }`, or a promise of one. With
`schema` or fields, more props apply, and `confirm` holds the tool until the caller agrees:

| Prop | Type | What it does |
|---|---|---|
| `success` | `string` | The line after a successful run. Without it, the result's `message` |
| `error` | `string` | The line when a failed result has no `message` |
| `tryWith` | object | What the preview's Try form opens with. Never reaches the model |
| `confirm` | `(input) => string` | The question that holds the tool until the caller says yes. Only with `onSubmit` ([Confirmations](../confirmations.md)) |

A handler can refuse its input with [`ToolInputError`](../functions/errors.md#toolinputerror).

## Example

```tsx
import { Tool, z } from "curb";

<Tool
  name="open_claim"
  description="Open a claim once the caller has described what happened."
  schema={z.object({ policy: z.string(), what: z.string() })}
  onSubmit={async ({ policy, what }) => {
    const id = await claims.open(policy, what);
    return { ok: true, message: `Claim ${id} is open.` };
  }}
/>
```

## Version history

| Version | Changes |
|---|---|
| v1.5.0 | `tryWith` added |
| v1.4.33 | `confirm` added |
| v1.0.0 | `icon` added |
| v0.1.2 | `<Tool>` introduced |
