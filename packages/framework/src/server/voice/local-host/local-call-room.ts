/**
 * A browser call over the page's own WebSocket (`../call-room.ts`): the voice session's audio
 * and transcripts as raw PCM and JSON frames (`../../../local-voice-wire.ts`), no WebRTC, no
 * media server. `curb dev`'s calls run on it unless the environment names a LiveKit.
 *
 * The LiveKit `AgentSession` runs exactly as it does in a room: the same VAD, endpointing,
 * interruption and transcription synchronizer. Only the three sinks a room would provide
 * are replaced: an `AudioInput` fed by the page's microphone frames, an `AudioOutput` that
 * sends the agent's voice to the page and learns from it how much actually played, and the
 * transcript sinks. The agents framework's own console mode is built the same way.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { voice } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import {
  LOCAL_VOICE_INPUT_SAMPLE_RATE,
  LOCAL_VOICE_OUTPUT_SAMPLE_RATE,
  parseLocalVoiceClientMessage,
  type LocalVoiceClientMessage,
  type LocalVoiceServerMessage,
} from "../../../local-voice-wire.js";
import { logError, logInfo } from "../../log.js";
import { parseUrlOrNull } from "../../request-url.js";
import type { VoiceCallRoom } from "../call-room.js";
import type { CallParticipant } from "../livekit-host/call-opening.js";
import { createSynchronizer, type TranscriptSink } from "./synchronizer.js";

/** The page's participant: one browser tab, never a phone line or a transfer target. */
const PAGE_PARTICIPANT: CallParticipant = { identity: "browser" };

/**
 * How long past a segment's own length the page may take to say it played. A page that
 * never answers (a crashed tab whose socket is still open) would otherwise hold the reply,
 * and every turn after it, forever.
 */
const PLAYOUT_REPORT_SLACK_MS = 5_000;

type Send = (message: LocalVoiceServerMessage | Buffer) => void;

/** The page's microphone, as the session's audio input. */
export class PageAudioInput extends voice.AudioInput {
  private controller: ReadableStreamDefaultController<AudioFrame> | null = null;
  private closed = false;

  constructor() {
    super();
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: (controller) => {
          this.controller = controller;
        },
      }),
    );
  }

  /** One frame of 16-bit mono PCM at {@link LOCAL_VOICE_INPUT_SAMPLE_RATE}. */
  push(pcm: Buffer): void {
    if (this.closed || !this.controller) return;
    if (pcm.byteLength % 2 !== 0) {
      throw new Error(`a microphone frame of ${pcm.byteLength} bytes is not 16-bit PCM`);
    }
    // Copied: the socket reuses its buffer, and Int16Array needs an aligned offset.
    const samples = new Int16Array(pcm.byteLength / 2);
    new Uint8Array(samples.buffer).set(pcm);
    this.controller.enqueue(new AudioFrame(samples, LOCAL_VOICE_INPUT_SAMPLE_RATE, 1, samples.length));
  }

  override async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.controller?.close();
    }
    await super.close();
  }
}

/** What the page says about the segment being played: done, or cut after `playedMs`. */
type PlayoutReport = LocalVoiceClientMessage;

/**
 * The agent's voice, sent to the page. A segment ends at `flush` (played to its end) or
 * `clearBuffer` (a barge-in); either way the PAGE says how much of it played, because only
 * the page knows: the server pushes audio faster than real time, so its own clock says
 * nothing about what the caller heard. That figure is what cuts an interrupted reply's
 * transcript to the words actually spoken.
 */
export class PageAudioOutput extends voice.AudioOutput {
  private pushedMs = 0;
  private startedAt = 0;
  private waiting: ((report: PlayoutReport | null) => void) | null = null;
  private settling: Promise<void> | null = null;

  constructor(private readonly send: Send) {
    super(LOCAL_VOICE_OUTPUT_SAMPLE_RATE, undefined, { pause: false });
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (frame.sampleRate !== LOCAL_VOICE_OUTPUT_SAMPLE_RATE || frame.channels !== 1) {
      // The session resamples to `sampleRate` before it calls this; anything else is a bug
      // upstream, and playing it would be audibly wrong (pitch, speed), so it is refused.
      throw new Error(
        `local voice plays ${LOCAL_VOICE_OUTPUT_SAMPLE_RATE} Hz mono, got ${frame.sampleRate} Hz x${frame.channels}`,
      );
    }
    if (this.settling) await this.settling;
    await super.captureFrame(frame);
    if (this.pushedMs === 0) {
      this.startedAt = Date.now();
      this.onPlaybackStarted(this.startedAt);
    }
    this.pushedMs += (frame.samplesPerChannel / frame.sampleRate) * 1000;
    const { data } = frame;
    this.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  override flush(): void {
    super.flush();
    // Nothing played, or a clear already settles this segment.
    if (this.pushedMs === 0 || this.settling) return;
    this.send({ type: "audio_flush" });
    this.settle(this.pushedMs + PLAYOUT_REPORT_SLACK_MS);
  }

  clearBuffer(): void {
    if (this.pushedMs === 0) return;
    this.send({ type: "audio_clear" });
    // An open segment the page has not been told to finish yet is settled by this clear.
    if (!this.settling) this.settle(PLAYOUT_REPORT_SLACK_MS);
  }

  /** The page's answer to the flush or clear of the current segment. */
  report(message: PlayoutReport): void {
    const waiting = this.waiting;
    if (!waiting) {
      logError("voice", `local call: the page reported ${message.type} for no segment; ignored`);
      return;
    }
    this.waiting = null;
    waiting(message);
  }

  /** The page is gone: whatever is playing stopped where the clock says it was. */
  pageLeft(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(null);
  }

  private settle(timeoutMs: number): void {
    const pushedMs = this.pushedMs;
    const startedAt = this.startedAt;
    this.settling = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const report = await new Promise<PlayoutReport | null | "timeout">((resolve) => {
        this.waiting = resolve;
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      clearTimeout(timer);
      this.waiting = null;
      let playedMs: number;
      let interrupted: boolean;
      if (report === "timeout" || report === null) {
        // No figure from the page: the clock's estimate, said out loud. The transcript cut may
        // then be off by however far playback lagged behind the push.
        playedMs = Math.min(Math.max(0, Date.now() - startedAt), pushedMs);
        interrupted = playedMs < pushedMs;
        logError(
          "voice",
          `local call: ${report === null ? "the page left" : `no playout report within ${timeoutMs} ms`}; ` +
            `assuming ${Math.round(playedMs)} of ${Math.round(pushedMs)} ms played`,
        );
      } else {
        playedMs = Math.min(report.playedMs, pushedMs);
        interrupted = report.type === "playout_cleared";
      }
      this.pushedMs = 0;
      this.settling = null;
      this.onPlaybackFinished({ playbackPosition: playedMs / 1000, interrupted });
    })();
  }
}

/** The reply's paced words, sent to the page. */
function pageTranscriptSink(send: Send): TranscriptSink {
  return {
    captureText: async (text) => send({ type: "agent_text", text: typeof text === "string" ? text : text.text }),
    flush: () => send({ type: "agent_text_end" }),
    onAttached: () => undefined,
    onDetached: () => undefined,
  };
}

/** One local call: its room, and the socket the page attaches to it. */
export type LocalVoiceCall = {
  readonly id: string;
  /** Proves the socket that attaches is the page this call was started for. */
  readonly token: string;
  readonly room: VoiceCallRoom;
  /** The page's socket for this call. A second one replaces the first. */
  attach(socket: WebSocket): void;
};

export function createLocalVoiceCall(id = `local-${randomUUID().slice(0, 8)}`): LocalVoiceCall {
  const token = randomUUID();
  let socket: WebSocket | null = null;
  const joined = new Set<(participant: CallParticipant | undefined) => void>();
  const left = new Set<(participant: CallParticipant | undefined) => void>();
  const lost = new Set<(reason: string) => void>();
  let input: PageAudioInput | null = null;
  let output: PageAudioOutput | null = null;
  let disconnected = false;

  const send: Send = (message) => {
    const target = socket;
    if (!target || target.readyState !== target.OPEN) return; // no page: nobody to hear it
    if (Buffer.isBuffer(message)) target.send(message, { binary: true });
    else target.send(JSON.stringify(message));
  };

  const onMessage = (data: RawData, isBinary: boolean) => {
    try {
      if (isBinary) {
        input?.push(Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]));
        return;
      }
      const message = parseLocalVoiceClientMessage(data.toString());
      if (!output) throw new Error(`the page reported ${message.type} before the session started`);
      output.report(message);
    } catch (error) {
      // KEEP-JUSTIFIED: one malformed frame from the page must not end the call; it is
      // logged with its cause, and the next frame is read as usual.
      logError("voice", `local call ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const room: VoiceCallRoom = {
    name: id,
    participants: () => (socket ? [PAGE_PARTICIPANT] : []),
    onParticipantConnected: (listener) => void joined.add(listener),
    onParticipantDisconnected: (listener) => void left.add(listener),
    onDisconnected: (listener) => void lost.add(listener),
    startSession: async ({ session, agent }) => {
      input = new PageAudioInput();
      output = new PageAudioOutput(send);
      const synchronizer = await createSynchronizer(output, pageTranscriptSink(send));
      session.input.audio = input;
      session.output.audio = synchronizer.audioOutput;
      session.output.transcription = synchronizer.textOutput;
      // What the caller is saying, as RoomIO publishes it: one segment per final.
      let segment = 0;
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
        send({ type: "caller_text", id: `${id}-${segment}`, text: event.transcript, final: event.isFinal });
        if (event.isFinal) segment += 1;
      });
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
        send({ type: "agent_state", state: event.newState });
      });
      await session.start({ agent });
    },
    publishTransferTrack: () =>
      Promise.reject(new Error("a local call has no phone line, so there is no transfer track to publish")),
    disconnect: async () => {
      if (disconnected) return;
      disconnected = true;
      const closing = socket;
      socket = null;
      output?.pageLeft();
      await input?.close();
      closing?.close(1000, "call ended");
      for (const listener of lost) listener("call ended");
    },
  };

  return {
    id,
    token,
    room,
    attach: (next) => {
      if (disconnected) {
        next.close(4410, "this call has ended");
        return;
      }
      const previous = socket;
      socket = next;
      if (previous) {
        previous.off("message", onMessage);
        previous.close(4409, "another page took this call");
      }
      next.on("message", onMessage);
      next.on("close", () => {
        if (socket !== next) return;
        socket = null;
        output?.pageLeft();
        logInfo("voice", `local call ${id}: the page left`);
        for (const listener of left) listener(PAGE_PARTICIPANT);
      });
      logInfo("voice", `local call ${id}: the page joined`);
      if (!previous) for (const listener of joined) listener(PAGE_PARTICIPANT);
    },
  };
}

/** The local calls this server runs, by id, for the socket that comes to attach to one. */
export class LocalVoiceCalls {
  private readonly calls = new Map<string, LocalVoiceCall>();

  open(): LocalVoiceCall {
    const call = createLocalVoiceCall();
    this.calls.set(call.id, call);
    return call;
  }

  close(id: string): void {
    this.calls.delete(id);
  }

  /** Hand an upgrade on the local voice path to its call, or refuse it with a status. */
  upgrade(wss: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = parseUrlOrNull(request.url, "http://localhost");
    if (url === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\n\r\nBad request.\n");
      return;
    }
    const call = this.calls.get(url.searchParams.get("call") ?? "");
    if (!call || url.searchParams.get("token") !== call.token) {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\nNo such local call.\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => call.attach(ws));
  }
}
