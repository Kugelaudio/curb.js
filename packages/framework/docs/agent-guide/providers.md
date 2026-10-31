# Providers

The LLM and the speech providers are props, imported from `curb/providers`. Keys stay in the environment
([Configuration](./configuration.md#provider-keys)).

| Export | What it gives you |
|---|---|
| `kugelaudio` | `kugelaudio.llm()`, `kugelaudio.stt()`, `kugelaudio.tts()` |
| `anthropic` | An LLM |
| `openai` | An LLM, `openai.stt()`, `openai.tts()` |
| `openaiCompatible` | Any OpenAI-compatible LLM |
| `azure` | `azure.stt()` |
| `deepgram` | `deepgram.stt()` |
| `elevenlabs` | `elevenlabs.stt()`, `elevenlabs.tts()` |
| `cartesia` | `cartesia.tts()` |
| `defaultKugelVoice` | `defaultKugelVoice(language?)`: the default voice of a language |
| `DEFAULT_VOICE_LANGUAGE` | The language with none set, `"en"` |
| `KUGELAUDIO_LLM_MODELS` | The models `kugelaudio.llm()` accepts |
| `DEFAULT_KUGELAUDIO_LLM_MODEL` | The one it uses by default |

## `kugelaudio`

Runs on one key, `KUGELAUDIO_API_KEY`.

### `kugelaudio.llm(options?)`

KugelAudio's EU-hosted LLM, in closed alpha.

| Option | Type | Default |
|---|---|---|
| `model` | one of `KUGELAUDIO_LLM_MODELS` | `DEFAULT_KUGELAUDIO_LLM_MODEL` |

### `kugelaudio.stt(options?)`

Kugel Ear 1.

| Option | Type | Default | What it does |
|---|---|---|---|
| `language` | `string` | detects German or English | `"de"`, or `"de,fr"` to detect among several, expecting the first. Supported: de, en, fr, it, es, pt, nl, pl, ro |
| `turnDetection` | `"kugelturn"`, `"vad"` | `"kugelturn"` | What ends a caller's turn: KugelTurn hears when the speaker finished; `vad` waits for a second of pause |
| `turnDetectionLevel` | `"responsive"`, `"conservative"` | `"responsive"` | `conservative` holds longer through a pause mid-thought |
| `boostedPhrases` | `string[]` | | Names and terms to spell the way you write them ([Pronunciation](./pronunciation.md)) |
| `dictionaryIds` | `number[]` | every active dictionary | Dictionaries used as vocabulary; `[]` for none |
| `projectId` | `number` | the key's project | The project whose dictionaries apply |

### `kugelaudio.tts(options?)`

| Option | Type | Default | What it does |
|---|---|---|---|
| `voice` | `number` | the voice of `language` | A KugelAudio voice id |
| `model` | `string` | `"kugel-3.5"` | The TTS model |
| `language` | `string` | `"en"` | How text is read, and which voice reads it when `voice` is not set |
| `dictionaryIds` | `number[]` | | Pronunciation dictionaries. Needs `projectId` |
| `projectId` | `number` | | The number in your dashboard URL |

## `anthropic`

```ts
anthropic(model: string)
```

Key: `ANTHROPIC_API_KEY`.

## `openai`

```ts
openai(model: string)
openai.stt({ model?, language? })
openai.tts({ voice?, model? })
```

Key: `OPENAI_API_KEY`.

## `openaiCompatible`

Any OpenAI-compatible endpoint. Its key, when it needs one, is `AGENT_LLM_API_KEY`, else `OPENAI_API_KEY`.

| Option | Type | What it does |
|---|---|---|
| `baseURL` | `string` | The endpoint, like `http://127.0.0.1:11434/v1`. Required |
| `model` | `string` | Required |
| `reasoningEffort` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` | Sent as `reasoning_effort`. `"none"` switches thinking off where the endpoint takes it |
| `temperature` | `number`, 0 to 2 | Sent as `temperature` |
| `topP` | `number`, above 0, at most 1 | Sent as `top_p` |
| `body` | object | Extra request fields, sent as written. A field Curb or an option above sets is refused |

Unset, each one is the endpoint's default. See [Your own LLM](./custom-llm.md).

## `azure`

```ts
azure.stt({ language?, region?, segmentationMs? })
```

Key: `AZURE_SPEECH_KEY`. `region` defaults to `AZURE_SPEECH_REGION`, else `eastus`. `segmentationMs` is the
trailing silence before Azure ends an utterance, default 300.

## `deepgram`

```ts
deepgram.stt({ model?, language? })
```

Key: `DEEPGRAM_API_KEY`.

## `elevenlabs`

```ts
elevenlabs.stt({ model? })
elevenlabs.tts({ voice?, model? })
```

Key: `ELEVEN_API_KEY`, or `ELEVENLABS_API_KEY`.

## `cartesia`

```ts
cartesia.tts({ voice?, model?, language? })
```

Key: `CARTESIA_API_KEY`.

## Next steps

- [Voice](./voice.md): choosing the providers.
- [Configuration](./configuration.md): every environment variable.
