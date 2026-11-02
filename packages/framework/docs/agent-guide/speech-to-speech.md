# Speech-to-speech models

A speech-to-speech model hears the caller and speaks by itself, in one model. Set it on `<Agent s2s>`
and the agent keeps its skills, tools and held actions: nothing else in the project changes.

## Add a model

1. Put the key in `.env`:

   ```text
   OPENAI_API_KEY=...
   ```

2. Set the model on `<Agent>`, and remove `stt` and `tts`:

   ```tsx
   import { Agent } from "curb";
   import { anthropic, openai } from "curb/providers";

   <Agent llm={anthropic("claude-sonnet-5-5")} s2s={openai.live()}>
   ```

3. Run `npx curb check`, then call the agent with `npm run dev`.

`curb check` warns with `AGENT_S2S_SPEECH_PROVIDER_IGNORED` when `stt` or `tts` is still set, and it
may still list speech keys of the agent's default providers. A call does not need them.

## Choose a model

| Descriptor | Protocol | How the model hands work to the agent |
|---|---|---|
| `openai.live()` | OpenAI Live | It delegates a turn by itself |
| `openai.realtime()` | OpenAI Realtime | It calls one tool Curb gives it, `ask_back_office` |

The agent is written the same way on both. Set `voice` and `model` on the descriptor, and `baseURL`
for another endpoint on the same protocol ([`openai`](./providers/openai.md)):

```tsx
<Agent llm={anthropic("claude-sonnet-5-5")} s2s={openai.realtime({ model: "my-model", voice: "marin" })}>
```

## How a call runs

The model owns the call: the microphone, turn-taking, interruptions, the transcript and the speech.
It starts with the prompt the agent renders in `<Agent>` and the list of its tools and skills, and it
answers what it can alone.

Anything else it hands over. Curb then runs an ordinary turn on `llm`, with the agent's skills, tools
and held actions, and gives the model the outcome to say. So an agent with `s2s` still needs `llm`,
and that key too.

`<Agent s2s>` is set once for the whole agent. A `<Skill>` cannot change it, and neither can
`adjustable`.

## What changes on a call

- The model says the outcome in its own words, so a [`confirm`](./confirmations.md) read-back is not
  word for word. A held action runs only on what the caller said.
- A fixed first line and a goodbye are worded by the model too.
- Text of a skill reaches `llm`, not the model. Put what the model must always know in the agent's
  prompt.
- A call cannot be transferred.
- The transcript holds what the caller and the model said. A back-office reply is not in it, and on
  Realtime the model's request to the back office is marked as not the caller's.
- When the caller is done, the model hands that over and the agent runs `end_call`. A model may answer
  a goodbye by itself, so after 6 seconds of quiet following its line, `llm` reads the transcript once
  and ends the call if it is over. That is one more `llm` call per long pause.
- When the model keeps dropping the connection, Curb ends the call rather than leave the caller in
  silence.

## Testing

`curb say` and `curb test` run the turn on `llm`, so they test what the agent does, not when the model
hands a turn over or how it sounds. Listen to a call in `npm run dev` for that.

## Version history

| Version | Changes |
|---|---|
| Unreleased | `<Agent s2s>` added |
