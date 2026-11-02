# `<Field>`

One input field of a [`<Tool>`](./tool.md), written as a child. It adds nothing a Zod schema does
not; it is shorter for a few flat fields.

```tsx
import { Field } from "curb";

function Field(props: FieldProps): ReactNode;
```

## Props

| Prop | Type | What it does |
|---|---|---|
| `name` | `string` | The input's name |
| `type` | `"string"`, `"number"`, `"integer"`, `"boolean"`, `"email"` | Its type |
| `description` | `string` | What it is, for the model |
| `required` | `boolean` | Whether the model must fill it |

## Example

```tsx
<Tool name="find_policy" description="Find a policy by its number." onSubmit={findPolicy}>
  <Field name="number" type="string" description="The policy number" required />
</Tool>
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<Field>` introduced |
