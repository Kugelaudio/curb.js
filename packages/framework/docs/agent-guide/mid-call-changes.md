# Mid-call changes

Project: `examples/pipeline`. Speech-to-text, the LLM and text-to-speech are props, so a change
is a render.

**By state.** A tool sets a store, and the store sets the providers, so the call moves to German
from the next reply on:

```tsx
const useLanguage = createAgentStore<{ language: "en" | "de"; setLanguage: (language: "en" | "de") => void }>(
  "language",
  (set) => ({ language: "en", setLanguage: (language) => set({ language }) }),
);

function App() {
  const language = useLanguage((state) => state.language);
  const setLanguage = useLanguage((state) => state.setLanguage);
  return (
    <Agent stt={kugelaudio.stt({ language: language === "de" ? "de,en" : "en,de" })} tts={kugelaudio.tts({ language })}>
      <Instruction>{`Reply in ${language === "de" ? "German" : "English"}.`}</Instruction>
      <GlobalTools>
        <Tool
          name="switch_to_german"
          description="Use when the caller asks for German."
          onCall={async () => {
            setLanguage("de");
            return { ok: true, message: "From your next reply on the call is in German." };
          }}
        />
      </GlobalTools>
    </Agent>
  );
}
```

The STT takes both languages, the likelier one first, so it hears the request to switch. The
instruction is in `<current_context>`, so the system prompt stays the same for the provider's cache.

**By skill.** A skill's link overrides the agent's providers while the skill is active. The active
skill is the one read last, so another read ends it. A skill's `llm` applies from the caller's next
turn, not to the reply in the turn that opened the skill:

```tsx
<Skill path="/report" description="Use for a written summary." llm={kugelaudio.llm({ model: "mistral-medium-3.5-128b" })}>
  Report
</Skill>
```

**From outside.** Nothing is adjustable unless you list it, per sender:

```tsx
<Agent adjustable={{ client: ["tts.voice"], host: ["tts.voice", "stt.language", "llm"] }}>
```

The caller's app then calls `agent.update({ tts: { voice: 17 } })` from `curb/client`, and your own
host sends `PATCH /v1/sessions/{id}` ([Host protocol](./host-protocol.md#live-session-settings)). A hosted
agent has no published route for your server yet: there, change settings from the caller's app
or from a tool in the agent.

## Live settings: `adjustable` and `useSession`

The caller's app (`curb/client`'s `agent.update`) and the host
(`PATCH /v1/sessions/{id}`) may change a few settings mid-call, but only those
`<Agent adjustable>` lists for them. Absent, nothing is adjustable.

```tsx
import { Agent } from "curb";
import { kugelaudio } from "curb/providers";

export function App() {
  return (
    <Agent
      tts={kugelaudio.tts({ voice: 1072 })}
      adjustable={{ client: ["tts.voice"], host: ["tts.voice", "stt.language", "llm"] }}
    >
      {/* the prompt, skills and tools */}
    </Agent>
  );
}
```

Paths: `"tts.voice"`, `"tts.model"`, `"stt.language"`, `"llm"`. An accepted change
overrides the prop until the next change of the same path, and TTS changes drop when the
rendered TTS provider changes; a refused one changes nothing. Read the effective providers (props plus outside changes) in any component:

```tsx
import { Text, useSession } from "curb";

export function CurrentVoice() {
  const { settings } = useSession();         // { llm, stt, tts } descriptors, read-only
  // e.g. { voice: 17 } after the app called agent.update({ tts: { voice: 17 } })
  return <Text>{`Speaking with ${settings.tts.provider} ${JSON.stringify(settings.tts.options)}.`}</Text>;
}
```

The body, the refusal codes and the wire format are in [Host protocol](./host-protocol.md#live-session-settings).

During a call, `useSession().call` is that call: its `sessionId` and its own
`scratchDir`, a writable directory removed when the call ends. A runner may serve
several calls in one process, so read the call's identity here, never from
`process.env`, and write files only under `scratchDir`. `scratchDir` is absent in `curb dev`
and when the runner could not create one.

```tsx
import { Text, useSession } from "curb";

export function CallInfo() {
  const { call } = useSession();
  return <Text>{call ? `Call ${call.sessionId}.` : "Not on a call."}</Text>;
}
```

## Next steps

- [Voice](./voice.md): the providers and their options.
- [Host protocol](./host-protocol.md#live-session-settings): the wire format of a settings change.
