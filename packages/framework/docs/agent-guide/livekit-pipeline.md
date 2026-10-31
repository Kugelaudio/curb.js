# Override the LiveKit pipeline

Project: `examples/livekit-pipeline`. A Curb call runs on a LiveKit `AgentSession`, and Curb's
`voice.Agent` answers its turns ([Architecture](./architecture.md)). You can edit that pipeline or
write your own:

| You want | Use | Runs on |
|---|---|---|
| Other turn handling, an event listener, one step changed | `defineAgent({ pipeline })` | Every route: `curb dev`, `curb start`, a built artifact |
| A session you build yourself | Your own worker, with `curb/orchestration` | That worker only |

Start with the first. Curb's session also does the opening line, the silence check-in, transfers,
provider swaps and the call report, and a worker of your own does none of them until you write
them.

## Edit the pipeline

`pipeline` has three optional parts:

```ts
import { pipeline } from "./pipeline";

export const agent = defineAgent({ app: App, pipeline });
```

| Part | Receives | Use it for |
|---|---|---|
| `session` | The options Curb would build `voice.AgentSession` with | Returning changed options: turn handling, interruptions, providers |
| `agent` | Curb's agent class | Returning a subclass that replaces `sttNode`, `llmNode` or `ttsNode` |
| `onSession` | `{ session, roomName, events }`, once per call | Subscribing to session events, before the session starts |

Keep `curb/orchestration` to `import type` in anything under `src/agent/`: the agent also loads
where LiveKit's native modules cannot, so `onSession` gets the event names as `events`.

### Change the session

Endpointing decides when a caller's turn is over. Callers who pause to look something up need
longer than the default:

```ts
import type { VoicePipeline } from "curb/orchestration";

export const pipeline: VoicePipeline = {
  session: (defaults) => ({
    ...defaults,
    turnHandling: {
      ...defaults.turnHandling,
      endpointing: { minDelay: 800, maxDelay: 6000 },
    },
  }),
};
```

Spread `defaults` so the rest stays. Leave `llm` as it is: it keeps LiveKit calling `llmNode`, and
that is where Curb answers. This applies to voice calls and overrides
`VOICE_ENDPOINTING_MIN_MS` and `VOICE_ENDPOINTING_MAX_MS`.

### Replace a step

`agent` receives Curb's agent class. Override a LiveKit node, and call `super` for the steps you
keep. This one answers a question without the model:

```ts
import type { VoicePipeline, llm, voice } from "curb/orchestration";

type LlmOutput = Awaited<ReturnType<voice.Agent["llmNode"]>>;

export const pipeline: VoicePipeline = {
  agent: (Base) =>
    class extends Base {
      override async llmNode(
        chatCtx: llm.ChatContext,
        toolCtx: llm.ToolContext,
        settings: voice.ModelSettings,
      ): Promise<LlmOutput> {
        const said = this.turnInputFrom(chatCtx);
        if (said !== null && /opening hours/i.test(said)) {
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue("We are open Monday to Friday, from nine to five.");
              controller.close();
            },
          }) as LlmOutput;
        }
        return super.llmNode(chatCtx, toolCtx, settings);
      }
    },
};
```

A subclass has two more helpers from Curb:

| Member | What it does |
|---|---|
| `this.turnInputFrom(chatCtx)` | The caller's last words, or `null` |
| `this.runTurn(text, signal)` | Runs a Curb turn: skills, tools and the model. Yields its events |

A reply that skips `super.llmNode` is heard but is not in Curb's conversation, so the model does
not see it on the next turn and it is not in the call report. Use it for lines that stand alone.

`ttsNode` changes what the voice reads, not the transcript. The example spells out a word there.
Its stream arrives in chunks that can split a word, so hold back the last word of each chunk:

```ts
override async ttsNode(text: ReadableStream<string>, settings: voice.ModelSettings) {
  return super.ttsNode(text.pipeThrough(spellOut("IBAN", "I B A N")), settings);
}
```

### Listen to the session

```ts
export const pipeline: VoicePipeline = {
  onSession: ({ session, roomName, events }) => {
    session.on(events.AgentStateChanged, ({ newState }) => {
      console.log(`${roomName}: agent is ${newState}`);
    });
  },
};
```

## Write your own pipeline

A worker of your own builds the session itself. Curb still renders the agent and runs its turns,
and everything around them is yours:

```ts
import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  CurbLLMStub,
  CurbVoiceAgent,
  ServerOptions,
  buildVoiceProviders,
  cli,
  createVoiceAgentBundle,
  defineAgent,
  silero,
  voice,
} from "curb/orchestration";

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    const bundle = await createVoiceAgentBundle();
    const { stt, tts } = await buildVoiceProviders({ settings: bundle.runtime.settings.current() });

    const session = new voice.AgentSession({
      stt,
      tts,
      vad: await silero.VAD.load(),
      // The stub keeps LiveKit calling llmNode. Curb's agent answers there.
      llm: new CurbLLMStub(),
      turnHandling: { turnDetection: "vad", endpointing: { minDelay: 500, maxDelay: 4000 } },
    });

    await session.start({
      room: ctx.room,
      agent: new CurbVoiceAgent({
        instructions: "curb agent (context compiled per turn by the curb runtime)",
        runTurn: (text, signal) => bundle.session.runTurnStream(text, { spoken: true, signal }),
      }),
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
```

Run it with the TypeScript loader, which LiveKit's job processes inherit, and the three `LIVEKIT_*`
variables set:

```bash
node --env-file-if-exists=.env --import tsx src/own-session.ts start
```

Swap any part from here: subclass `CurbVoiceAgent`, drop it for a `voice.Agent` of your own, or
call `bundle.session.runTurnStream` from your own loop. `pipeline` is not read here, and neither
`curb dev` nor a hosted agent runs this file.

## Next steps

- [Orchestration](./orchestration-api.md): everything `curb/orchestration` exports.
- [Voice sessions](./voice-sessions.md): what Curb's own session does.
- [Providers](./providers.md): changing speech and the LLM with a prop, no override needed.
