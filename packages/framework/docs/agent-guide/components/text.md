# `<Text>`

Factual context. A plain string in JSX is factual context too; use `<Text>` for a clear boundary or
to load a file.

```tsx
import { Text } from "curb";

function Text(props: { src?: string; children?: ReactNode }): ReactNode;
```

## Props

| Prop | Type | What it does |
|---|---|---|
| `src` | `string` | A markdown file under `context/` |
| `children` | `ReactNode` | The text |

Give `src` or children, never both.

## Example

```tsx
<Text src="deductibles.md" />
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<Text>` introduced |
