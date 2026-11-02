# Providers

The LLM and the speech providers are props, imported from `curb/providers`. Keys stay in the environment
([Configuration](./configuration.md#provider-keys)).

| Export | What it gives you |
|---|---|
| [`kugelaudio`](./providers/kugelaudio.md) | `kugelaudio.llm()`, `kugelaudio.stt()`, `kugelaudio.tts()` |
| [`anthropic`](./providers/anthropic.md) | An LLM |
| [`openai`](./providers/openai.md) | An LLM, `openai.stt()`, `openai.tts()` |
| [`openaiCompatible`](./providers/openai-compatible.md) | Any OpenAI-compatible LLM |
| [`azure`](./providers/azure.md) | `azure.stt()` |
| [`deepgram`](./providers/deepgram.md) | `deepgram.stt()` |
| [`elevenlabs`](./providers/elevenlabs.md) | `elevenlabs.stt()`, `elevenlabs.tts()` |
| [`cartesia`](./providers/cartesia.md) | `cartesia.tts()` |
| `defaultKugelVoice` | `defaultKugelVoice(language?)`: the default voice of a language |
| `DEFAULT_VOICE_LANGUAGE` | The language with none set, `"en"` |
| `KUGELAUDIO_LLM_MODELS` | The models `kugelaudio.llm()` accepts |
| `DEFAULT_KUGELAUDIO_LLM_MODEL` | The one it uses by default |

## Next steps

- [Voice](./voice.md): choosing the providers.
- [Configuration](./configuration.md): every environment variable.
