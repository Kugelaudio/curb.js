# Your own LLM

Curb works with any OpenAI-compatible endpoint, and with Anthropic and OpenAI directly.

```tsx
import { Agent } from "curb";
import { anthropic, kugelaudio } from "curb/providers";

<Agent llm={anthropic("claude-sonnet-5-5")} stt={kugelaudio.stt({ language: "de" })} tts={kugelaudio.tts({ language: "de" })}>
```

The environment holds the keys only ([Configuration](./configuration.md)).

## An OpenAI-compatible model

```tsx
import { openaiCompatible } from "curb/providers";

<Agent llm={openaiCompatible({ baseURL: "http://127.0.0.1:8000/v1", model: "my-model", reasoningEffort: "none" })}>
```

`openaiCompatible()` sends nothing beyond the conversation and the tools unless you set it,
so the model runs with the server's defaults. For a reasoning model such as Qwen that often
means thinking out loud: the server returns the reasoning as plain reply text, and the agent
would speak it. Switch thinking off and set the model's recommended sampling on the
descriptor:

- `reasoningEffort`, sent as `reasoning_effort`: one of `"none"`, `"minimal"`, `"low"`,
  `"medium"`, `"high"`, `"xhigh"`, `"max"`. `"none"` turns thinking off where the endpoint
  takes it; the endpoint's documentation lists the values each model supports.
- `temperature` (0 to 2) and `topP` (above 0, at most 1), sent as `temperature` and `top_p`.
- `body`: extra request fields the endpoint accepts, sent as written. A field Curb sets
  itself (`model`, `messages`, `tools`, `tool_choice`, `stream`, `stream_options`) or one an
  option above sets (`temperature`, `top_p`, `reasoning_effort`) is refused when the agent
  renders, naming what to use instead.

Some hosted OpenAI-compatible APIs take `reasoning_effort`, not `chat_template_kwargs` (key in
`AGENT_LLM_API_KEY`):

```tsx
import { openaiCompatible } from "curb/providers";

<Agent
  llm={openaiCompatible({
    baseURL: "https://llm.example.com/v1",
    model: "qwen3.8-27b",
    reasoningEffort: "none",
    temperature: 0.7,
    topP: 0.8,
  })}
>
```

On a vLLM server, Qwen's chat template switches thinking off through
`chat_template_kwargs`, and `top_k` is a vLLM sampling field:

```tsx
<Agent
  llm={openaiCompatible({
    baseURL: "http://127.0.0.1:8000/v1",
    model: "qwen3.8-27b",
    temperature: 0.7,
    topP: 0.8,
    body: { top_k: 20, chat_template_kwargs: { enable_thinking: false } },
  })}
>
```

## Next steps

- [Providers](./providers.md): every LLM provider and its options.
