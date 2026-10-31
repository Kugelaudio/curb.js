// Type imports only: the agent also loads where LiveKit's native modules cannot.
import type { VoicePipeline, llm, voice } from "curb/orchestration";

type LlmOutput = Awaited<ReturnType<voice.Agent["llmNode"]>>;

const OPENING_HOURS = "We are open Monday to Friday, from nine to five.";

/** A fixed reply as the stream `llmNode` returns. */
function reply(text: string): LlmOutput {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  }) as LlmOutput;
}

/** Spells a word out for the voice. Holds back the last, possibly unfinished, word of a chunk. */
function spellOut(word: string, spelled: string): TransformStream<string, string> {
  let held = "";
  const replaced = (text: string) => text.replaceAll(word, spelled);
  return new TransformStream({
    transform(chunk, controller) {
      const text = held + chunk;
      const end = text.lastIndexOf(" ") + 1;
      held = text.slice(end);
      if (end > 0) controller.enqueue(replaced(text.slice(0, end)));
    },
    flush(controller) {
      if (held !== "") controller.enqueue(replaced(held));
    },
  });
}

export const pipeline: VoicePipeline = {
  // The options LiveKit's AgentSession is built with. Callers here pause while they look
  // something up, so a turn ends later than Curb's default.
  session: (defaults) => ({
    ...defaults,
    turnHandling: {
      ...defaults.turnHandling,
      endpointing: { minDelay: 800, maxDelay: 6000 },
    },
  }),

  // The agent class. Override any LiveKit node; call super for the step Curb runs.
  agent: (Base) =>
    class extends Base {
      // Answered without the model. Curb's conversation does not record this reply.
      override async llmNode(
        chatCtx: llm.ChatContext,
        toolCtx: llm.ToolContext,
        settings: voice.ModelSettings,
      ): Promise<LlmOutput> {
        const said = this.turnInputFrom(chatCtx);
        if (said !== null && /opening hours/i.test(said)) return reply(OPENING_HOURS);
        return super.llmNode(chatCtx, toolCtx, settings);
      }

      // What the voice reads, not what the transcript shows.
      override async ttsNode(
        text: ReadableStream<string>,
        settings: voice.ModelSettings,
      ): ReturnType<voice.Agent["ttsNode"]> {
        return super.ttsNode(text.pipeThrough(spellOut("IBAN", "I B A N")), settings);
      }
    },

  // The running session. Called once per call, before it starts.
  onSession: ({ session, roomName, events }) => {
    session.on(events.AgentStateChanged, ({ newState }) => {
      console.log(`${roomName}: agent is ${newState}`);
    });
  },
};
