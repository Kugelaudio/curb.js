# `defineTool`

Types the props of a [`<Tool>`](../components/tool.md) outside JSX. It returns what you pass.

```ts
import { defineTool } from "curb";

function defineTool(config: ToolProps): ToolProps;
```

## Example

```tsx
const openClaim = defineTool({
  name: "open_claim",
  description: "Open a claim.",
  schema: z.object({ policy: z.string() }),
  onSubmit: async ({ policy }) => ({ ok: true, message: `Opened for ${policy}.` }),
});

<Tool {...openClaim} />
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `defineTool` introduced |
