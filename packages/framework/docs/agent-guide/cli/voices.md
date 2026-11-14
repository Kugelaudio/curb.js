# `curb voices`

Lists the KugelAudio voices this project can use, each with the id `kugelaudio.tts({ voice })`
takes. It runs on the project's KugelAudio access: your `npx curb login`, or a `KUGELAUDIO_API_KEY`
in `.env` or the environment. Without either it says how to sign in and exits 1.

```bash
npx curb voices [--language <code>] [--json]
```

## Options

| Option | What it does |
|---|---|
| `--language <code>` | Only voices that speak it. `en` also lists `en-US` and `en-GB` voices |
| `--json` | Prints the list as one JSON array on stdout |

## Output

One line per voice: its id, its name, then sex, age, category and languages, then the start of its
description.

```text
1072  Olivia Taylor  (female, middle_age, conversational, en-NZ)  Olivia Taylor is a 32-year-old New Zealand-based customer support agent with a New Zealand…
1 voice(s). Use one with tts={kugelaudio.tts({ voice: <id>, language: "<code>" })}.
```

Pick the voice by its description, then set it with the language the agent speaks:

```tsx
<Agent tts={kugelaudio.tts({ voice: 1072, language: "en" })}>
```

`npx curb check` looks up every voice id the agent sets and fails with `AGENT_VOICE_NOT_FOUND` when
KugelAudio does not have it, so a wrong id never reaches a call, where it would be silent.

## Version history

| Version | Changes |
|---|---|
| v1.19.0 | `curb voices` introduced |
