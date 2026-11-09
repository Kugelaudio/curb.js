# Using LiveKit agents-js plugins in the voice pipeline

The framework's voice layer (`src/server/voice/`) speaks its own narrow,
push/callback contracts — `VoiceStt`, `VoiceTts`, `VoiceVad` — not LiveKit's.
The adapters in `src/server/voice/adapters/livekit/` wrap a
[`@livekit/agents`](https://github.com/livekit/agents-js) plugin instance and
expose it as one of those contracts, so any LiveKit STT / TTS / VAD provider
(Deepgram, AssemblyAI, ElevenLabs, Cartesia, Silero, …) drops into the existing
`VoiceSession` without touching the session, the wire protocol, or the browser
client.

LLM plugins are intentionally **not** adapted: the agent brain
(`AgentSession.runTurnStream`) is a higher-level, tool-calling abstraction than
LiveKit's `llm.LLM` chat model.

## Install the optional peer dependencies

`@livekit/agents` and `@livekit/rtc-node` are **optional peer dependencies** —
only projects that use these adapters need them:

```bash
npm install @livekit/agents @livekit/rtc-node
```

Plus the specific provider plugin(s) you want, e.g.
`@livekit/agents-plugin-deepgram`, `@livekit/agents-plugin-elevenlabs`,
`@livekit/agents-plugin-silero`. If the peer deps are missing, the adapters
throw an agent-readable error naming the exact install command.

## What each adapter does

| Adapter | Wraps | Produces | Notes |
|---|---|---|---|
| `createLivekitStt(plugin, { sampleRate })` | `stt.STT` | a `makeStt` factory `(handlers) => VoiceStt` | `sampleRate` is the mic PCM rate (16 kHz). Maps `START_OF_SPEECH`/`INTERIM`/`FINAL` events to `onSpeechStart`/`onInterim`/`onFinal`. |
| `createLivekitTts(plugin, handlers)` | `tts.TTS` | a `VoiceTts` (with `.sampleRate`) | Reports the plugin's own output rate. One `SynthesizeStream` per turn; `flush()` = barge-in cancel. |
| `createLivekitVad(plugin, handlers, { sampleRate })` | `VAD` | a `VoiceVad` | Fast barge-in only (an alternative to the built-in `SileroVad`). Maps `START/END_OF_SPEECH`. |

All three are **async factories** — they preload the `@livekit` runtime so the
objects they return (which `VoiceSession` calls synchronously) can frame audio
without awaiting. Build them before constructing the `VoiceSession`.

## Wiring recipe

This mirrors `voice-host.ts:createVoiceConnection`, but swaps the concrete
Azure/Kugel/Silero implementations for LiveKit plugins:

```ts
import { STT as DeepgramSTT } from "@livekit/agents-plugin-deepgram";
import { TTS as ElevenLabsTTS } from "@livekit/agents-plugin-elevenlabs";
import { VAD as SileroVAD } from "@livekit/agents-plugin-silero";

import { VoiceSession } from "../voice-session.js";
import {
  createLivekitStt,
  createLivekitTts,
  createLivekitVad,
} from "./index.js";

const MIC_SAMPLE_RATE = 16000; // browser MicRecorder captures @16 kHz

export async function createLivekitVoiceConnection(options: {
  send: VoiceSessionOptions["send"];
  runTurn: VoiceSessionOptions["runTurn"];
}): Promise<VoiceSession> {
  let session: VoiceSession | null = null;

  // TTS + VAD are constructed with handlers that route back into the session.
  // `session` is assigned before any audio flows, so reading it lazily is safe.
  const tts = await createLivekitTts(new ElevenLabsTTS(), {
    onAudio: (b64, turnId) => session?.handleTtsAudio(b64, turnId),
    onError: (msg) => session?.sendError(msg),
  });

  const vad = await createLivekitVad(
    new SileroVAD(),
    { onSpeechStart: () => session?.onVadSpeechStart() },
    { sampleRate: MIC_SAMPLE_RATE },
  );

  const makeStt = await createLivekitStt(new DeepgramSTT(), {
    sampleRate: MIC_SAMPLE_RATE,
  });

  session = new VoiceSession({
    send: options.send,
    runTurn: options.runTurn,
    tts,
    vad,
    makeStt, // VoiceSession calls this synchronously with its handlers
    ttsSampleRate: tts.sampleRate, // reported by the plugin, not hard-coded
  });
  return session;
}
```

You can also mix and match — e.g. keep the built-in Azure STT + Kugel TTS but
use a LiveKit VAD, or use a LiveKit STT with Kugel TTS. Each adapter is
independent; `VoiceSession` only sees the four contracts.

## Runtime selection (props on `<Agent>`)

The providers are props on the agent tree, built with the factories in
`curb/providers` and resolved by `src/server/voice/providers.ts`:

```tsx
import { azure, deepgram, kugelaudio } from "curb/providers";

<Agent stt={azure.stt({ language: "de" })} tts={kugelaudio.tts({ voice: 1840 })}>
  {/* While /support is the active skill, its own stt applies. */}
  <Skill path="/support" stt={deepgram.stt({ model: "nova-3" })}>Support</Skill>
</Agent>
```

`kugelaudio.stt()` + `kugelaudio.tts()` (the defaults) and `azure.stt()` are the
framework-native paths; `deepgram.stt`, `elevenlabs.stt/tts`, `cartesia.tts` and
`openai.stt/tts` lazy-load the matching `@livekit/agents-plugin-*` package,
resolved from the consuming project's node_modules. `create-curb.js` asks
which ones at scaffold time, writes them as props and installs only those
plugin packages. Keys stay in the environment under each plugin's canonical
name (`DEEPGRAM_API_KEY`, `ELEVEN_API_KEY`, `CARTESIA_API_KEY`,
`OPENAI_API_KEY`); a missing key or plugin package surfaces as an
agent-readable error naming the exact fix. A prop that changes mid-call swaps
the provider live (from the next reply).

## How the impedance mismatch is bridged

LiveKit plugins are **pull** (async-iterator) + **`AudioFrame`**; our contracts
are **push** (callbacks) + raw base64 PCM. Each adapter:

- runs a background `for await` loop draining the plugin's event/audio stream
  and fans results into the framework's callbacks;
- converts audio at the boundary via `AudioByteStream` (PCM `Buffer` →
  `AudioFrame[]` on the way in) and `frame.data` → base64 (on the way out);
- resolves LiveKit's numeric enums (`SpeechEventType`, `VADEventType`) from the
  loaded module rather than by literal value, so the mapping can't silently
  drift if LiveKit re-encodes them.
```
