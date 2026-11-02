# `<ErrorMessage>`

An error the model reads in its context on its next step. Input a tool refuses gets its message
without this ([Tools](../tools.md)).

```tsx
import { ErrorMessage } from "curb";

function ErrorMessage(props: { source?: string; children: ReactNode }): ReactNode;
```

## Props

| Prop | Type | What it does |
|---|---|---|
| `source` | `string` | Where the error came from: a tool's name, or `mcp:<server>` |
| `children` | `ReactNode` | The error text |

## Example

```tsx
{lookupFailed && <ErrorMessage source="find_policy">The policy system is down. Offer to call back.</ErrorMessage>}
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<ErrorMessage>` introduced |
