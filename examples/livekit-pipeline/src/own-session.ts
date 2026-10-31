// A LiveKit worker that builds the whole session itself. It replaces `curb start`: run it with
// `npm run own-session`. Curb still renders the agent and runs its turns; this file owns everything
// around them, and nothing `defineAgent({ pipeline })` sets applies here.
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
