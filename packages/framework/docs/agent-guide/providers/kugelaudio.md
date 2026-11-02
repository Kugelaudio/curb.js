# `kugelaudio`

Runs on one key, `KUGELAUDIO_API_KEY`.

```ts
import { kugelaudio } from "curb/providers";

kugelaudio.llm(options?: KugelaudioLlmOptions): LlmDescriptor;
kugelaudio.stt(options?: KugelaudioSttOptions): SttDescriptor;
kugelaudio.tts(options?: KugelaudioTtsOptions): TtsDescriptor;
```

## `kugelaudio.llm(options?)`

KugelAudio's EU-hosted LLM, in closed alpha.

| Option | Type | Default |
|---|---|---|
| `model` | one of `KUGELAUDIO_LLM_MODELS` | `DEFAULT_KUGELAUDIO_LLM_MODEL` |

## `kugelaudio.stt(options?)`

Kugel Ear 1.

| Option | Type | Default | What it does |
|---|---|---|---|
| `language` | `string` | detects German or English | `"de"`, or `"de,fr"` to detect among several, expecting the first. Supported: de, en, fr, it, es, pt, nl, pl, ro |
| `turnDetection` | `"kugelturn"`, `"vad"` | `"kugelturn"` | What ends a caller's turn: KugelTurn hears when the speaker finished; `vad` waits for a second of pause |
| `turnDetectionLevel` | `"responsive"`, `"conservative"` | `"responsive"` | `conservative` holds longer through a pause mid-thought |
| `boostedPhrases` | `string[]` | | Names and terms to spell the way you write them ([Pronunciation](../pronunciation.md)) |
| `dictionaryIds` | `number[]` | every active dictionary | Dictionaries used as vocabulary; `[]` for none |
| `projectId` | `number` | the key's project | The project whose dictionaries apply |

## `kugelaudio.tts(options?)`

| Option | Type | Default | What it does |
|---|---|---|---|
| `voice` | `number` | the voice of `language` | A KugelAudio voice id |
| `model` | `string` | `"kugel-3.5"` | The TTS model |
| `language` | `string` | `"en"` | How text is read, and which voice reads it when `voice` is not set |
| `dictionaryIds` | `number[]` | | Pronunciation dictionaries. Needs `projectId` |
| `projectId` | `number` | | The number in your dashboard URL |

## Example

```tsx
<Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "de" })} tts={kugelaudio.tts({ language: "de" })} />
```

## Version history

| Version | Changes |
|---|---|
| v1.11.9 | `kugelaudio.llm()` added |
| v1.4.33 | `kugelaudio.stt()` added |
| v1.2.6 | `kugelaudio.tts()` introduced |
