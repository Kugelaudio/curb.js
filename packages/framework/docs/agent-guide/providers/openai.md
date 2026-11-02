# `openai`

An LLM, speech-to-text and text-to-speech. Key: `OPENAI_API_KEY`. `openai.stt()` and `openai.tts()` need
`@livekit/agents-plugin-openai` in the project.

```ts
import { openai } from "curb/providers";

openai(model: string): LlmDescriptor;
openai.stt(options?: OpenaiSttOptions): SttDescriptor; // { model?, language? }
openai.tts(options?: OpenaiTtsOptions): TtsDescriptor; // { voice?, model? }
```

## Example

```tsx
<Agent llm={openai("gpt-5.5")} stt={openai.stt()} tts={openai.tts()} />
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `openai` introduced |
