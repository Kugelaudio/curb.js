# `<GlobalTools>`

Tools inside it are available in every skill. It takes no props.

```tsx
import { GlobalTools } from "curb";

function GlobalTools(props: { children: ReactNode }): ReactNode;
```

## Example

```tsx
<GlobalTools>
  <TransferCallTool to="+493012345678" description="The caller asks for a person." />
</GlobalTools>
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<GlobalTools>` introduced |
