# Voice

Speech to text, the LLM and text to speech are props on `<Agent>`. Curb runs the call around them:
turn-taking, interruptions, and speaking the reply sentence by sentence while the model writes.
A new project runs all three on KugelAudio, so you can start talking with no setup.

The providers on this page, the other settings and their keys are listed in
[Providers](./providers.md) and [Configuration](./configuration.md).

The LLM and the speech providers are props on `<Agent>`, built with the
factories in `curb/providers`. Each returns a plain descriptor; the server
resolves it and reads the key from the environment, so nothing secret is in the
tree.

| Factory | Options | Key (env) |
|---|---|---|
| `kugelaudio.llm(...)` | `model`: `"qwen3.8-27b"` (default) or `"mistral-medium-3.5-128b"` | `KUGELAUDIO_API_KEY` |
| `anthropic(model)` | | `ANTHROPIC_API_KEY` |
| `openai(model)` | | `OPENAI_API_KEY` |
| `openaiCompatible({ baseURL, model, ... })` | `reasoningEffort`, `temperature`, `topP`, `body` | `AGENT_LLM_API_KEY`, else `OPENAI_API_KEY`, else none |
| `kugelaudio.stt(...)` | `language`, `turnDetection`, `turnDetectionLevel`, `boostedPhrases`, `dictionaryIds`, `projectId` | `KUGELAUDIO_API_KEY` |
| `azure.stt(...)` | `language`, `region`, `segmentationMs` | `AZURE_SPEECH_KEY` (`AZURE_SPEECH_REGION` default region, else `eastus`) |
| `deepgram.stt(...)` | `model`, `language` | `DEEPGRAM_API_KEY` |
| `elevenlabs.stt(...)` / `elevenlabs.tts(...)` | `model` / `voice`, `model` | `ELEVEN_API_KEY` |
| `openai.stt(...)` / `openai.tts(...)` | `model`, `language` / `voice`, `model` | `OPENAI_API_KEY` |
| `kugelaudio.tts(...)` | `voice`, `model`, `language`, `dictionaryIds`, `projectId` | `KUGELAUDIO_API_KEY` |
| `cartesia.tts(...)` | `voice`, `model`, `language` | `CARTESIA_API_KEY` |

Without a prop the defaults apply: `kugelaudio.llm()`,
`azure.stt()` and `kugelaudio.tts()` (English). A `kugelaudio.tts()` without `voice`
speaks the default voice of its `language`: 1072 for English, 1887 for German, and the
English 1072 for any other language, so give such an agent a `voice`
(`defaultKugelVoice(language)` from `"curb/providers"` returns the default). A chosen provider
whose key is missing fails with an error naming the variable.

`kugelaudio.llm()` is KugelAudio's LLM, hosted in the EU, on the same `KUGELAUDIO_API_KEY` as
its speech, so an agent on KugelAudio needs no other key; a hosted agent gets that key from
KugelAudio. Thinking is off on KugelAudio's side, so the agent never speaks its reasoning, and
nothing beyond the conversation and the tools is sent. It is served at `KUGELAUDIO_API_BASE`
(default `https://api.eu.kugelaudio.com`) plus `/v1`. An organization gets it with hosted
agents, in closed alpha; until then its turns answer 403 `LLM_NOT_ENABLED`.

To run your own model, see [Your own LLM](./custom-llm.md). For one model that both hears and speaks, see [Speech-to-speech models](./speech-to-speech.md).

## Speech to text

`kugelaudio.stt()` is Kugel Ear 1, KugelAudio's own speech-to-text, on the same
`KUGELAUDIO_API_KEY` as `kugelaudio.tts()`, so an agent on KugelAudio speech needs no
second vendor key. Set `language` to what your callers speak ("de", or "de,en" to detect
among several, expecting the first): without it the service detects German or English,
and a short German "Äh" or "Nein" can come out as English. KugelTurn, the end-of-turn
model inside the service, decides when the caller has finished (`turnDetectionLevel:
"conservative"` holds longer through pauses mid-thought). Names and product terms the
recognizer should spell your way go in `boostedPhrases`:

```tsx
<Agent
  stt={kugelaudio.stt({ language: "de", boostedPhrases: ["Curb", "Kugel Ear"] })}
  tts={kugelaudio.tts({ voice: 1887, language: "de" })}
>
```

Each caller turn becomes one transcript: the service's more accurate second pass over the
turn when it arrives within two seconds, else its first transcript. Supported languages:
de, en, fr, it, es, pt, nl, pl, ro; any other code fails when the agent starts.

## A different voice per skill

A `<Skill>` link can carry the same props. While that skill is the active one
(the most recently read), its props override the agent's, slot by slot:

```tsx
import { Skill, Skills } from "curb";
import { kugelaudio } from "curb/providers";

export const skills = (
  <Skills>
    <Skill path="/billing" description="Invoices and payments.">Billing</Skill>
    <Skill path="/claims" description="Filing a claim." tts={kugelaudio.tts({ voice: 17 })}>Claims</Skill>
  </Skills>
);
```

Put such props on the link in the always-rendered `<Skills>` index, so they
hold however the skill was reached. Props are reactive: render another value
(from state, `useAgentInfo`, a skill change) and a running call switches to it.
A speech provider is swapped from the agent's next reply on (the reply being
spoken finishes in the old voice); the LLM applies from the next turn. A
re-render with an equal value changes nothing.

## Turn-taking

Curb decides when the caller has finished. Three settings in `.env` change how it listens:

| Variable | Default (ms) | What it does |
|---|---|---|
| `VOICE_ENDPOINTING_MIN_MS` | 300 | The shortest pause that can end a turn |
| `VOICE_ENDPOINTING_MAX_MS` | 3000 | The longest pause before a turn ends |
| `VOICE_SILENCE_FOLLOWUP_MS` | 6000 | How long the agent waits in silence before it checks in |

## Next steps

- [Testing](./testing.md): check the agent from the terminal.
- [Mid-call changes](./mid-call-changes.md): switch voice, language or model during a call.
- [Pronunciation](./pronunciation.md): teach it your product's names.
