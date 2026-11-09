/**
 * The bridge between LiveKit's voice runtime and curb's brain: LiveKit owns
 * audio, turn-taking, endpointing and interruption; curb owns the LLM loop
 * (React-compiled context, skills, tools, MCP). A `voice.Agent` subclass
 * whose `llmNode` streams curb's `runTurnStream` deltas instead of calling a
 * LiveKit LLM — the rest of the pipeline (TTS, transcripts, synchronized
 * truncation) treats them like any model output.
 */

import { llm, voice, type stt, type tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { AgentTurnStreamEvent } from "../../../llm/types.js";
import { SKIP_TURN_TOOL_NAME } from "../../../types.js";
import { logError, logInfo } from "../../log.js";
import { reportTurnEvent } from "../turn-report.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import type { ConversationClips } from "./clip-store.js";

/** Copy one AudioFrame's PCM16 into a standalone Buffer. */
function frameToBuffer(frame: AudioFrame): Buffer {
  return Buffer.from(
    frame.data.buffer.slice(frame.data.byteOffset, frame.data.byteOffset + frame.data.length * 2),
  );
}

/** Runs one curb turn. `signal` aborts when LiveKit drops this reply (barge-in,
 * superseded turn) and must cancel THIS turn only: pass it to
 * `runTurnStream(text, { signal })`. A wrapping generator only sees return()
 * at its next yield, so the signal is what stops a turn waiting on the provider. */
export type CurbTurnRunner = (userText: string, signal: AbortSignal) => AsyncGenerator<AgentTurnStreamEvent>;

/** The session pipeline gates reply generation on an LLM instance existing
 * (`this.llm === undefined → return`), even when `llmNode` is overridden.
 * This stub satisfies the gate; its `chat` can never be reached because
 * {@link CurbVoiceAgent.llmNode} owns inference. */
export class CurbLLMStub extends llm.LLM {
  label(): string {
    return "curb.LLM";
  }
  override get model(): string {
    return "curb-agent-session";
  }
  chat(): never {
    throw new Error("curb owns LLM inference via CurbVoiceAgent.llmNode; LLM.chat is unreachable.");
  }
}

export type CurbAgentCallbacks = {
  /** The model chose to say nothing this turn — the host arms the check-in.
   * (Everything else the UI needs — messages, tool activity — flows from the
   * shared AgentSession's subscription over the connection's WebSocket.) */
  onSkipTurn?: () => void;
};

export class CurbVoiceAgent extends voice.Agent {
  /** Runs one Curb turn. Protected so a project's subclass can drive it (`defineAgent({ pipeline })`). */
  protected readonly runTurn: CurbTurnRunner;
  private readonly callbacks: CurbAgentCallbacks;
  private readonly clips: ConversationClips | undefined;
  private readonly reporter: CallReporter | undefined;

  constructor(options: {
    instructions: string;
    runTurn: CurbTurnRunner;
    callbacks?: CurbAgentCallbacks;
    /** Tap the audio nodes into per-message debug clips (see ClipStore). */
    clips?: ConversationClips;
    /**
     * THIS CALL'S reporter, never a shared one.
     *
     * Held per agent because a runner may serve several calls at once and each one has its
     * own producer and sequence. Absent means the call keeps no record, which is how
     * `curb dev` and the unit suite run.
     */
    reporter?: CallReporter;
    /** Unique per agent of one call, so a provider swap's handoff names exactly this one. */
    id?: string;
    /** Speech providers carried by THIS agent. Set on a mid-call provider swap
     * (`AgentSession.updateAgent`); absent, the session's own are used. */
    stt?: stt.STT;
    tts?: tts.TTS;
    /** The previous agent's chat context, carried across a swap. */
    chatCtx?: llm.ChatContext;
  }) {
    super({
      instructions: options.instructions,
      ...(options.id === undefined ? {} : { id: options.id }),
      ...(options.stt === undefined ? {} : { stt: options.stt }),
      ...(options.tts === undefined ? {} : { tts: options.tts }),
      ...(options.chatCtx === undefined ? {} : { chatCtx: options.chatCtx }),
      // Word timestamps from Kugel TTS drive the synchronized transcript, so
      // an interrupted reply is truncated to exactly the words that played.
      useTtsAlignedTranscript: true,
    });
    this.runTurn = options.runTurn;
    this.callbacks = options.callbacks ?? {};
    this.clips = options.clips;
    this.reporter = options.reporter;
  }

  /** Tee the mic audio into the user clip store — byte-for-byte what STT
   * receives. Clips are segmented by user finals (the host calls
   * `clips.finish("user")` on each one). */
  override async sttNode(
    audio: Parameters<voice.Agent["sttNode"]>[0],
    modelSettings: voice.ModelSettings,
  ): Promise<Awaited<ReturnType<voice.Agent["sttNode"]>>> {
    const clips = this.clips;
    if (!clips) return super.sttNode(audio, modelSettings);
    // Node's web-streams typings and the DOM lib disagree on pipeThrough;
    // the runtime objects are the same web streams.
    const tapped = (audio as ReadableStream<AudioFrame>).pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        transform(frame, controller) {
          clips.append("user", frameToBuffer(frame), frame.sampleRate);
          controller.enqueue(frame);
        },
      }),
    ) as Parameters<voice.Agent["sttNode"]>[0];
    return super.sttNode(tapped, modelSettings);
  }

  /** Tee the synthesized audio into the assistant clip store — the exact TTS
   * output before WebRTC encoding, for any provider. Segmented per reply
   * (the host calls `clips.finish("assistant")` on conversation_item_added). */
  override async ttsNode(
    text: Parameters<voice.Agent["ttsNode"]>[0],
    modelSettings: voice.ModelSettings,
  ): Promise<Awaited<ReturnType<voice.Agent["ttsNode"]>>> {
    const output = await super.ttsNode(text, modelSettings);
    const clips = this.clips;
    if (!output || !clips) return output;
    return (output as ReadableStream<AudioFrame>).pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        transform(frame, controller) {
          clips.append("assistant", frameToBuffer(frame), frame.sampleRate);
          controller.enqueue(frame);
        },
      }),
    ) as Awaited<ReturnType<voice.Agent["ttsNode"]>>;
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    _toolCtx: llm.ToolContext,
    _modelSettings: voice.ModelSettings,
  ): Promise<Awaited<ReturnType<voice.Agent["llmNode"]>>> {
    const input = this.turnInputFrom(chatCtx);
    logInfo("voice", `llmNode input: ${input === null ? "(none)" : JSON.stringify(input.slice(0, 80))}`);
    if (input === null) return null;

    const runTurn = this.runTurn;
    const callbacks = this.callbacks;
    const reporter = this.reporter;
    let generator: AsyncGenerator<AgentTurnStreamEvent> | null = null;
    let cancelled = false;
    const turnCancel = new AbortController();

    // Absolute marks on the process clock, so they can be lined up against the
    // TTS plugin's own. The question they answer: does the FIRST delta reach
    // TTS while the model is still writing, or only after it has finished?
    const turnStartedAt = performance.now();
    logInfo("voice", `llm turn start @${Math.round(turnStartedAt)}`);
    const stream = new ReadableStream<string>({
      async start(controller) {
        try {
          generator = runTurn(input, turnCancel.signal);
          let sawSkipTurn = false;
          let firstDeltaAt: number | null = null;
          let deltas = 0;
          // Accumulated so the reply can be reported as ONE turn. Deltas are a streaming
          // detail; a transcript of forty fragments is not a transcript.
          let reply = "";
          for await (const event of generator) {
            // After cancel() the stream is closed; keep draining so the turn
            // unwinds, but enqueueing would throw.
            if (event.type === "delta" && event.delta && !cancelled) {
              firstDeltaAt ??= performance.now();
              deltas += 1;
              reply += event.delta;
              controller.enqueue(event.delta);
            }
            reportTurnEvent(reporter, event);
            if (event.type === "tool" && event.toolCall.name === SKIP_TURN_TOOL_NAME) sawSkipTurn = true;
          }
          // Reported after the stream closes, so an interrupted reply carries the words
          // that actually made it out rather than the ones that were planned.
          if (reply.trim() !== "") {
            reporter?.turn({ speaker: "agent", text: reply, final: true });
          }
          logInfo(
            "voice",
            `llm deltas: ${deltas} in ${Math.round(performance.now() - (firstDeltaAt ?? turnStartedAt))}ms, first @${Math.round(firstDeltaAt ?? 0)}, last @${Math.round(performance.now())}`,
          );
          if (sawSkipTurn) callbacks.onSkipTurn?.();
          if (!cancelled) controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
          else logError("voice", `cancelled turn failed while unwinding: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      cancel() {
        // Barge-in / superseded turn: cancel THIS reply's curb turn (stops its
        // LLM request now, or drops it from the queue), then unwind.
        cancelled = true;
        turnCancel.abort();
        void generator?.return(undefined);
      },
    });
    // The base signature widens the element type with an internal sentinel
    // symbol; a plain string stream is what the default node emits too.
    return stream as Awaited<ReturnType<voice.Agent["llmNode"]>>;
  }

  /** Curb keeps its own conversation history — LiveKit's chat context is
   * only mined for the latest user utterance. (Interruption awareness lives
   * in the host: LiveKit's `conversation_item_added` reports interrupted
   * replies with their playback-synchronized transcript, and curb's history
   * entry is rewritten to the words that actually played.) */
  protected turnInputFrom(chatCtx: llm.ChatContext): string | null {
    const items = chatCtx.items;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.type !== "message" || item.role !== "user") continue;
      return item.textContent?.trim() || null;
    }
    return null;
  }
}
