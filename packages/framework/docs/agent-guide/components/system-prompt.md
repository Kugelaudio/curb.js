# `<SystemPrompt>`

The system prompt. Its children are the prompt: nothing is added when it compiles. A voice call adds
Curb's spoken-reply rules at runtime.

```tsx
import { SystemPrompt } from "curb";

function SystemPrompt(props: { children: ReactNode }): ReactNode;
```

## Example

```tsx
<SystemPrompt>You answer calls for an insurance company. Keep every reply short.</SystemPrompt>
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<SystemPrompt>` introduced |
