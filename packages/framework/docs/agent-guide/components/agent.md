# `<Agent>`

The root of the tree. Everything the agent says and can do renders inside it.

```tsx
import { Agent } from "curb";

function Agent(props: AgentProps): ReactNode;
```

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `llm` | [LLM provider](../providers.md) | `kugelaudio.llm()` | The model |
| `stt` | [Speech-to-text provider](../providers.md) | `azure.stt()` | Speech recognition |
| `tts` | [Text-to-speech provider](../providers.md) | `kugelaudio.tts()` | The voice |
| `adjustable` | `{ client?: paths, host?: paths }` | nothing | What the caller's page and the host may change during a call. Paths: `"tts.voice"`, `"tts.model"`, `"stt.language"`, `"llm"` ([Mid-call changes](../mid-call-changes.md)) |

A changed prop swaps that provider from the next render, also during a call.

## Example

```tsx
import { Agent, SystemPrompt } from "curb";
import { kugelaudio } from "curb/providers";

<Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "de" })} tts={kugelaudio.tts({ language: "de" })}>
  <SystemPrompt>You answer calls for an insurance company.</SystemPrompt>
</Agent>
```

## Version history

| Version | Changes |
|---|---|
| v1.4.33 | `<Agent>` renders the skills a conversation opens |
| v1.2.6 | `llm`, `stt`, `tts` and `adjustable` added |
| v0.1.2 | `<Agent>` introduced |
