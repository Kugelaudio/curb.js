# `anthropic`

An LLM. Key: `ANTHROPIC_API_KEY`.

```ts
import { anthropic } from "curb/providers";

anthropic(model: string): LlmDescriptor;
```

## Example

```tsx
<Agent llm={anthropic("claude-sonnet-5-5")} />
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `anthropic` introduced |
