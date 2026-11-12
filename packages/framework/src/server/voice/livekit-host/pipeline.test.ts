import { llm, voice } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { AgentInfoStore } from "../../../info-store.js";
import type { AgentTurnStreamEvent } from "../../../llm/types.js";
import { CurbVoiceAgent } from "./curb-agent.js";
import { startVoiceAgent, type VoiceAgentStartOptions } from "./host.js";
import { voiceAgentClass, voiceSessionOptions, type VoicePipeline, type VoiceSessionOptions } from "./pipeline.js";

const defaults: VoiceSessionOptions = {
  turnHandling: { turnDetection: "vad", endpointing: { minDelay: 300, maxDelay: 3000 } },
};

function userSaid(text: string): llm.ChatContext {
  const chat = new llm.ChatContext();
  chat.addMessage({ role: "user", content: text });
  return chat;
}

async function replyOf(stream: Awaited<ReturnType<voice.Agent["llmNode"]>>): Promise<string> {
  let reply = "";
  const reader = stream!.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) reply += String(read.value);
  return reply;
}

const curbReplies = {
  instructions: "Test agent",
  async *runTurn(input: string): AsyncGenerator<AgentTurnStreamEvent> {
    yield { type: "delta", delta: `curb: ${input}`, text: `curb: ${input}` };
  },
};

describe("a project's voice pipeline", () => {
  it("leaves the session and the agent alone when there is none", () => {
    expect(voiceSessionOptions(defaults, undefined)).toBe(defaults);
    expect(voiceAgentClass(undefined)).toBe(CurbVoiceAgent);
  });

  it("edits the options the session is built with", () => {
    const options = voiceSessionOptions(defaults, {
      session: (current) => ({
        ...current,
        turnHandling: { ...current.turnHandling, endpointing: { minDelay: 800, maxDelay: 6000 } },
      }),
    });
    expect(options.turnHandling?.endpointing).toEqual({ minDelay: 800, maxDelay: 6000 });
    expect(options.turnHandling?.turnDetection).toBe("vad");
  });

  it("lets a subclass answer a turn itself and leave the rest to Curb", async () => {
    const Agent = voiceAgentClass({
      agent: (Base) =>
        class extends Base {
          override async llmNode(
            chatCtx: llm.ChatContext,
            toolCtx: llm.ToolContext,
            settings: voice.ModelSettings,
          ): ReturnType<voice.Agent["llmNode"]> {
            if (this.turnInputFrom(chatCtx) !== "opening hours") return super.llmNode(chatCtx, toolCtx, settings);
            return new ReadableStream<string>({
              start(controller) {
                controller.enqueue("Nine to five.");
                controller.close();
              },
            }) as Awaited<ReturnType<voice.Agent["llmNode"]>>;
          }
        },
    });
    const agent = new Agent(curbReplies);
    const tools = new llm.ToolContext();

    expect(await replyOf(await agent.llmNode(userSaid("opening hours"), tools, {}))).toBe("Nine to five.");
    expect(await replyOf(await agent.llmNode(userSaid("hello"), tools, {}))).toBe("curb: hello");
  });

  it("lets a subclass run Curb's turn itself", async () => {
    const Agent = voiceAgentClass({
      agent: (Base) =>
        class extends Base {
          async firstDelta(input: string): Promise<string> {
            for await (const event of this.runTurn(input, new AbortController().signal)) {
              if (event.type === "delta") return event.delta;
            }
            return "";
          }
        },
    });
    const agent = new Agent(curbReplies) as CurbVoiceAgent & { firstDelta(input: string): Promise<string> };
    expect(await agent.firstDelta("hello")).toBe("curb: hello");
  });

  it("reaches the session of a real call, in order", async () => {
    const steps: string[] = [];
    const reached = new Error("the session was built");
    const pipeline: VoicePipeline = {
      agent: (Base) => {
        steps.push("agent");
        return Base;
      },
      session: (current) => {
        steps.push(`session ${String(current.turnHandling?.turnDetection)}`);
        return current;
      },
      onSession: ({ session, roomName, events }) => {
        expect(session).toBeInstanceOf(voice.AgentSession);
        expect(events).toBe(voice.AgentSessionEventTypes);
        steps.push(`onSession ${roomName}`);
        throw reached;
      },
    };
    const start = startVoiceAgent({
      room: {},
      roomName: "room-1",
      // What a call reads of its bundle before the session is built: its speech settings, and
      // the info, active skill and span attributes its trace starts from.
      bundle: {
        runtime: { settings: { s2s: () => undefined }, info: new AgentInfoStore(), snapshot: () => ({ context: { path: "", title: "" } }) },
        session: { spanAttributes: () => ({}) },
      },
      client: { bind() {} },
      providers: { stt: {}, tts: {} },
      vad: {},
      pipeline,
    } as unknown as VoiceAgentStartOptions);

    await expect(start).rejects.toBe(reached);
    expect(steps).toEqual(["agent", "session vad", "onSession room-1"]);
  });
});
