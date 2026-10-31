# Pronunciation

Two settings make the agent hear and say your product's names correctly.

## Hearing a name

`boostedPhrases` tells speech recognition how to spell names and terms:

```tsx
<Agent stt={kugelaudio.stt({ language: "de", boostedPhrases: ["Curb", "Kugel Ear"] })}>
```

## Saying a name

Brand names, product names and abbreviations that TTS says wrong are fixed with
a **pronunciation dictionary**, not by spelling them out phonetically in the
prompt: the prompt is read by the model, and a phonetic respelling there leaks
into the text chat too.

```tsx
import { Agent } from "curb";
import { kugelaudio } from "curb/providers";

export function App() {
  return (
    <Agent
      tts={kugelaudio.tts({
        voice: 1840,
        language: "de",
        projectId: 42,          // the number in your dashboard URL
        dictionaryIds: [7],   // applied in order
      })}
    >
      {/* the prompt, skills and tools */}
    </Agent>
  );
}
```

Dictionaries belong to a KugelAudio project, so `projectId` is **required**
whenever `dictionaryIds` is set; the framework refuses the unpaired
combination at startup rather than letting the service reject the first spoken
turn of a live call. Find both in the console under
`/dashboard/<org>/<project>/dictionaries`: the project id is in the URL.

Omitting `dictionaryIds` entirely applies the project's own default selection.
Passing an empty array is a different thing: it opts out of every dictionary,
including the defaults.

## Next steps

- [Voice](./voice.md): the providers and their options.
