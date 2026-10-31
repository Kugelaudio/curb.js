# Changing the pipeline

Speech-to-text, the LLM and text-to-speech are props, so a change is a render. This example
switches them in the three ways Curb has:

- **By state.** `switch_to_german` sets a store, and the agent's `stt` and `tts` follow from
  the next reply on, mid-call.
- **By skill.** `/report` has its own `llm` on the `<Skill>` link, used while it is the active
  skill.
- **From outside.** `adjustable` lets the caller's app change the voice and your host change
  more, nothing else.

`boostedPhrases` teaches the recognizer the product's names. Everything runs on one
`KUGELAUDIO_API_KEY`, from `npx curb login` or `.env`.

```bash
npx curb check
npx curb test
```
