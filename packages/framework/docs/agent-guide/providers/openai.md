# `openai`

An LLM, speech-to-text and text-to-speech. Key: `OPENAI_API_KEY`. `openai.stt()` and `openai.tts()` need
`@livekit/agents-plugin-openai` in the project.

```ts
import { openai } from "curb/providers";

openai(model: string): LlmDescriptor;
openai.stt(options?: OpenaiSttOptions): SttDescriptor; // { model?, language? }
openai.tts(options?: OpenaiTtsOptions): TtsDescriptor; // { voice?, model? }
```

## `openai.live(options?)`, `openai.realtime(options?)`

OpenAI's speech-to-speech models as the agent's voice on `<Agent s2s>` ([Speech-to-speech models](../speech-to-speech.md)): the model hears the caller
and speaks, so a call uses no `stt` and no `tts`. It answers what it can alone and hands the rest to
the agent. Your skills, tools and held actions run as a turn on `llm`, and the model says the outcome
in its own words. Three things follow:

- A `confirm` read-back is said in the model's words, not word for word.
- A fixed first line and a goodbye are worded by the model too.
- `curb say` and `curb test` run the turn on `llm`, so they test what the agent does, not when the model hands a turn over or how it sounds.

| Option | Type | What it does |
|---|---|---|
| `model` | `string` | Defaults to `"gpt-live-1"` for `openai.live()` |
| `voice` | `string` | The model's voice |
| `baseURL` | `string` | Another endpoint on the same protocol |
| `apiKeyEnv` | `string` | The environment variable holding the endpoint's key, read when a call starts; default `OPENAI_API_KEY` |
| `verbatim` | `boolean` | `openai.live()` only, on an endpoint that takes `expects_reply` on a commentary. The model says each reply of the back office word for word, and the caller's next finished turn goes back to `llm` |

## Example

```tsx
<Agent llm={openai("gpt-5.5")} stt={openai.stt()} tts={openai.tts()} />
```

## Version history

| Version | Changes |
|---|---|
| v1.18.0 | `verbatim` on `openai.live()`, and `apiKeyEnv` on `openai.live()` and `openai.realtime()`, added |
| Unreleased | `openai.live()` and `openai.realtime()` added |
| v1.2.6 | `openai` introduced |
