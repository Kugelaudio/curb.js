# `openaiCompatible`

Any OpenAI-compatible endpoint ([Your own LLM](../custom-llm.md)). Its key, when it needs one, is
`AGENT_LLM_API_KEY`, else `OPENAI_API_KEY`.

```ts
import { openaiCompatible } from "curb/providers";

openaiCompatible(options: OpenaiCompatibleOptions): LlmDescriptor;
```

## Options

| Option | Type | What it does |
|---|---|---|
| `baseURL` | `string` | The endpoint, like `http://127.0.0.1:11434/v1`. Required |
| `model` | `string` | Required |
| `reasoningEffort` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Sent as `reasoning_effort`. `"none"` switches thinking off where the endpoint takes it |
| `temperature` | `number`, 0 to 2 | Sent as `temperature` |
| `topP` | `number`, above 0, at most 1 | Sent as `top_p` |
| `body` | object | Extra request fields, sent as written. A field Curb or an option above sets is refused |

Unset, each one is the endpoint's default.

## Example

```tsx
<Agent llm={openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3", temperature: 0.2 })} />
```

## Version history

| Version | Changes |
|---|---|
| v1.7.2 | `reasoningEffort`, `temperature`, `topP` and `body` added |
| v1.2.6 | `openaiCompatible` introduced |
