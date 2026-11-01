# `z`

[Zod](https://zod.dev), re-exported so a project needs no dependency of its own.

```ts
import { z } from "curb";
```

## Example

```tsx
const schema = z.object({ policy: z.string().length(8), amount: z.number().positive() });
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `z` introduced |
