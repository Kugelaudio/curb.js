# `cartesia`

Text-to-speech. Key: `CARTESIA_API_KEY`. Install `@livekit/agents-plugin-cartesia` in the project.

```ts
import { cartesia } from "curb/providers";

cartesia.tts(options?: CartesiaTtsOptions): TtsDescriptor; // { voice?, model?, language? }
```

## Example

```tsx
<Agent tts={cartesia.tts({ voice: "CARTESIA_VOICE_ID", language: "de" })} />
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `cartesia` introduced |
