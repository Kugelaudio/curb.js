# `deepgram`

Speech-to-text. Key: `DEEPGRAM_API_KEY`. Install `@livekit/agents-plugin-deepgram` in the project.

```ts
import { deepgram } from "curb/providers";

deepgram.stt(options?: DeepgramSttOptions): SttDescriptor; // { model?, language? }
```

## Example

```tsx
<Agent stt={deepgram.stt({ language: "de" })} />
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `deepgram` introduced |
