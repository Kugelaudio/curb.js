# `elevenlabs`

Speech-to-text and text-to-speech. Key: `ELEVEN_API_KEY`, or `ELEVENLABS_API_KEY`. Install
`@livekit/agents-plugin-elevenlabs` in the project. It does not run in a hosted agent.

```ts
import { elevenlabs } from "curb/providers";

elevenlabs.stt(options?: ElevenlabsSttOptions): SttDescriptor; // { model? }
elevenlabs.tts(options?: ElevenlabsTtsOptions): TtsDescriptor; // { voice?, model? }
```

## Example

```tsx
<Agent tts={elevenlabs.tts({ voice: "ELEVENLABS_VOICE_ID" })} />
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `elevenlabs` introduced |
