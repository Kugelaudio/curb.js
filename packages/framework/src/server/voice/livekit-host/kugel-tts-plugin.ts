/**
 * Kugel TTS as a first-class LiveKit agents TTS plugin. Wraps the existing
 * {@link KugelTtsSession} (one shared `/ws/tts/multi` socket, one context per
 * reply segment) behind the `tts.TTS` / `tts.SynthesizeStream` contract.
 *
 * Word timestamps from the ingress's forced alignment are forwarded as
 * LiveKit `timedTranscripts`, which powers the framework's synchronized
 * transcripts: an interrupted reply's chat-context entry is truncated to the
 * words that actually PLAYED — with exact alignment, not estimates.
 */

import {
  type APIConnectOptions,
  APIError,
  AudioByteStream,
  shortuuid,
  tts,
} from "@livekit/agents";
import { createTimedString, type TimedString } from "@livekit/agents";
import { logError, logInfo } from "../../log.js";
import {
  KugelTtsSession,
  type KugelTtsConfig,
  type TtsWordTimestamp,
} from "../kugel-tts.js";

export class KugelTTS extends tts.TTS {
  label = "kugelaudio.TTS";
  readonly session: KugelTtsSession;
  private readonly streams = new Map<number, KugelSynthesizeStream>();
  private turnCounter = 0;
  private closing = false;

  constructor(config: KugelTtsConfig) {
    // `alignedTranscript` is the flag that makes the timed transcripts below
    // MEAN anything. LiveKit gates the aligned-transcript path on
    // `tts.capabilities.alignedTranscript && session.useTtsAlignedTranscript`
    // (agent_activity.ts); the session half defaults to true, so without this
    // half every TimedString we emit was computed, forwarded and dropped, and
    // the interrupted-reply cut fell back to estimating from audio duration.
    // That estimate is what put the split in the wrong place on screen.
    super(config.sampleRate, 1, { streaming: true, alignedTranscript: true });
    this.session = new KugelTtsSession(config, {
      onAudio: (b64, turnId) => this.streams.get(turnId)?.handleAudio(b64),
      onDone: (turnId) => this.streams.get(turnId)?.handleDone(),
      onWordTimestamps: (turnId, words) => this.streams.get(turnId)?.handleWords(words),
      onError: (message, turnId) => this.streams.get(turnId)?.handleError(message),
    });
    // Prewarm the socket so the first reply skips the WS handshake.
    void this.session.connect().catch(() => {
      // KEEP-JUSTIFIED: prewarm is best-effort; the first turn reconnects and
      // surfaces a hard failure through the stream's error path.
    });
  }

  stream(options?: { connOptions?: APIConnectOptions }): KugelSynthesizeStream {
    return this.createStream(true, options?.connOptions);
  }

  private createStream(reportErrors: boolean, connOptions?: APIConnectOptions): KugelSynthesizeStream {
    const turnId = ++this.turnCounter;
    const stream = new KugelSynthesizeStream(this, turnId, reportErrors, connOptions);
    this.streams.set(turnId, stream);
    return stream;
  }

  /** One-shot synthesis: drive a streaming segment with the full text. */
  synthesize(text: string, connOptions?: APIConnectOptions): tts.ChunkedStream {
    // LiveKit starts the one-shot task after this method returns. It can run
    // after close() has already cancelled all registered streams.
    return new KugelChunkedStream(
      this,
      text,
      () => this.closing ? undefined : this.createStream(false),
      connOptions,
    );
  }

  /** Report playback failures to the caller of this stream, outside the session error budget. */
  synthesizeForPlayback(text: string): KugelSynthesizeStream {
    const stream = this.createStream(false);
    stream.pushText(text);
    stream.endInput();
    return stream;
  }

  releaseStream(turnId: number): void {
    this.streams.delete(turnId);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const stream of this.streams.values()) stream.close();
    await this.session.close();
    await super.close();
  }
}

export class KugelSynthesizeStream extends tts.SynthesizeStream {
  label = "kugelaudio.SynthesizeStream";
  private readonly kugel: KugelTTS;
  private readonly turnId: number;
  private readonly bstream: AudioByteStream;
  private readonly requestId = shortuuid();
  private readonly segmentId = shortuuid();
  private pendingWords: TimedString[] = [];
  /** Alignment words received for this reply. Reported once per reply because
   * "are word timestamps actually arriving" was diagnosed three times from the
   * absence of evidence rather than its presence — a silent path looks
   * identical to a working one. */
  private wordsSeen = 0;
  /** Overlap accounting for one reply, so "do we stream into TTS or wait for
   * the whole reply" is answered by measurement instead of by reading the
   * pipeline. `inputDoneAt` after `firstAudioAt` means the ingress was still
   * being fed while audio was already playing — i.e. genuinely overlapped. */
  private firstTextAt: number | null = null;
  private firstAudioAt: number | null = null;
  private inputDoneAt: number | null = null;
  private chunksIn = 0;
  private lastFrameB64: string | null = null;
  private done = false;
  private failure?: APIError;
  private resolveDone!: () => void;
  private readonly doneFut = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    kugel: KugelTTS,
    turnId: number,
    private readonly reportErrors: boolean,
    connOptions?: APIConnectOptions,
  ) {
    super(kugel, connOptions);
    this.kugel = kugel;
    this.turnId = turnId;
    this.bstream = new AudioByteStream(kugel.sampleRate, kugel.numChannels);
    this.abortSignal.addEventListener("abort", () => this.resolveDone(), { once: true });
  }

  handleAudio(b64: string): void {
    if (this.closed) return;
    this.firstAudioAt ??= performance.now();
    // Emit the PREVIOUS chunk now that we know it isn't the last — the last
    // one is flagged `final` in handleDone (cartesia's lastFrame pattern).
    this.emitBuffered(false);
    this.lastFrameB64 = b64;
  }

  handleWords(words: TtsWordTimestamp[]): void {
    if (this.closed) return;
    this.wordsSeen += words.length;
    this.pendingWords.push(
      ...words.map((word) =>
        createTimedString({ text: `${word.word} `, startTime: word.startSec, endTime: word.endSec }),
      ),
    );
  }

  handleDone(): void {
    if (this.done) return;
    this.done = true;
    if (this.firstTextAt !== null) {
      const since = (at: number | null) => (at === null ? "n/a" : `${Math.round(at - this.firstTextAt!)}ms`);
      const overlapped =
        this.firstAudioAt !== null && this.inputDoneAt !== null && this.inputDoneAt > this.firstAudioAt;
      logInfo(
        "voice",
        `tts stream reply ${this.turnId}: ${this.chunksIn} chunk(s) in, firstText @${Math.round(this.firstTextAt!)}, first audio +${since(this.firstAudioAt)}, input done +${since(this.inputDoneAt)} — ${overlapped ? "OVERLAPPED (still feeding while speaking)" : "serial (all text in before first audio)"}`,
      );
    }
    logInfo(
      "voice",
      this.wordsSeen > 0
        ? `tts alignment: ${this.wordsSeen} word timestamp(s) for reply ${this.turnId}`
        : `tts alignment: NONE for reply ${this.turnId} — the ingress returned no word_timestamps, so an interrupted reply cannot be cut at the word the caller heard`,
    );
    this.emitBuffered(true);
    if (!this.queue.closed) this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    this.resolveDone();
  }

  override get error(): APIError | undefined {
    return this.failure;
  }

  handleError(message: string): void {
    if (this.done || this.closed) return;
    this.done = true;
    // LiveKit cannot replay a streaming input queue that has already been consumed.
    this.failure = new APIError(message, { retryable: false });
    if (!this.input.closed) this.input.close();
    this.resolveDone();
    logError("voice", `Kugel TTS stream error: ${message}`);
  }

  private emitBuffered(final: boolean): void {
    if (this.lastFrameB64 === null) {
      if (!final) return;
      // Final with nothing buffered: still flush the byte stream remainder.
      for (const frame of this.bstream.flush()) this.put(frame, true);
      return;
    }
    const bytes = Buffer.from(this.lastFrameB64, "base64");
    this.lastFrameB64 = null;
    const frames = this.bstream.write(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const tail = final ? this.bstream.flush() : [];
    const all = [...frames, ...tail];
    for (let i = 0; i < all.length; i += 1) {
      this.put(all[i]!, final && i === all.length - 1);
    }
  }

  private put(frame: import("@livekit/rtc-node").AudioFrame, final: boolean): void {
    if (this.queue.closed) return;
    this.queue.put({
      requestId: this.requestId,
      segmentId: this.segmentId,
      frame,
      final,
      timedTranscripts: this.pendingWords.length > 0 ? this.pendingWords : undefined,
    });
    this.pendingWords = [];
  }

  protected async run(): Promise<void> {
    try {
      let sawText = false;
      for await (const data of this.input) {
        if (this.failure || this.closed) break;
        if (data === tts.SynthesizeStream.FLUSH_SENTINEL) continue;
        if (!data) continue;
        sawText = true;
        this.chunksIn += 1;
        this.firstTextAt ??= performance.now();
        this.markStarted();
        await this.kugel.session.streamInput(this.turnId, data);
      }
      this.inputDoneAt = performance.now();
      if (!this.failure && !this.closed) {
        if (sawText) {
          await this.kugel.session.endInput(this.turnId);
          await this.doneFut; // audio keeps arriving until context_closed
        } else {
          this.handleDone();
        }
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.done || this.failure) {
        // Cancel only this turn so another stream can keep playing.
        this.done = true;
        void this.kugel.session.flush(this.turnId).catch(() => {
          // KEEP-JUSTIFIED: cancellation cleanup after the reply was already
          // abandoned; there is no consumer left to surface this to.
        });
        this.resolveDone();
      }
      this.kugel.releaseStream(this.turnId);
    }
    if (this.failure && this.reportErrors) throw this.failure;
  }
}

/** One-shot wrapper: pipe the full text through a streaming segment. */
class KugelChunkedStream extends tts.ChunkedStream {
  label = "kugelaudio.ChunkedStream";

  constructor(
    kugel: KugelTTS,
    text: string,
    private readonly createStream: () => KugelSynthesizeStream | undefined,
    connOptions?: APIConnectOptions,
  ) {
    super(text, kugel, connOptions);
  }

  protected async run(): Promise<void> {
    if (this.abortSignal.aborted) return;
    const stream = this.createStream();
    if (!stream) return;
    const closeStream = () => stream.close();
    this.abortSignal.addEventListener("abort", closeStream, { once: true });
    try {
      stream.pushText(this.inputText);
      stream.endInput();
      for await (const audio of stream) {
        if (audio === tts.SynthesizeStream.END_OF_STREAM) break;
        if (!this.queue.closed) this.queue.put(audio);
      }
      if (stream.error) throw stream.error;
    } finally {
      this.abortSignal.removeEventListener("abort", closeStream);
    }
  }
}
