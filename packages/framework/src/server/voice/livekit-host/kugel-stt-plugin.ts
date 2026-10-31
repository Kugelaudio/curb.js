/**
 * Kugel Ear 1 (`kugel-ear-1`) streaming speech-to-text as a LiveKit agents STT plugin, over
 * KugelAudio's `/v1/audio/transcriptions/stream` WebSocket (protocol: the public Speech to
 * Text API reference, "Stream live audio").
 *
 * One socket per stream, kept open across the caller's turns. The base class resamples room
 * audio to 16 kHz; it goes out as base64 PCM16 `audio_chunk` frames of 50 ms. The server
 * ends each turn itself (KugelTurn by default) and sends the turn's fast final, then a
 * revision (`alternatives` with `revises_final`): the whole turn decoded again, about 1.0 to
 * 1.3 s later. The REVISION is the turn's text, because the fast final can miss the start
 * of a turn (in testing it held only the second of two German sentences). The
 * fast final stands in when no revision arrives within {@link REVISION_WAIT_MS}. Either way
 * the turn becomes one FINAL_TRANSCRIPT plus END_OF_SPEECH, the events the Azure plugin
 * emits, so LiveKit's turn handling is unchanged; LiveKit cannot end a turn before that
 * final, so KugelTurn decides when the agent answers.
 *
 * Without speech the server closes an empty turn about once a second, and the revision of an
 * empty turn invents words ("Okay.", "Yeah."), so a turn whose fast final is empty is dropped
 * together with its revision.
 *
 * Failures go through LiveKit's own retry (`stt.SpeechStream.mainTask`): a server-side error
 * frame (code 429 or 5xx, which ingress sends before it closes 1011 or 1013), a server
 * restart (1012/1013), a dropped or stalled connection (no handshake within the connect
 * timeout, no pong within {@link PING_INTERVAL_MS}) and a refusal with 429 or 5xx throw a
 * retryable `APIError`, and LiveKit runs the stream again with backoff; a refused key or
 * permission (401/402/403), a 4xx error frame and a protocol violation are not retried and
 * end the session as an STT error. Either way a deaf call surfaces instead of looking healthy
 * (see azure-stt-plugin.ts for that incident). A final already received when the socket
 * closes (ingress sends it right before a 1012) still becomes the turn.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  type APIConnectOptions,
  normalizeLanguage,
  stt,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { logError, logInfo } from "../../log.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";

export const KUGEL_STT_SAMPLE_RATE = 16000;
export const KUGEL_STT_MODEL = "kugel-ear-1";
const STREAM_PATH = "/v1/audio/transcriptions/stream";
/** Audio per `audio_chunk`: small enough not to delay KugelTurn's 200 ms decision. */
const CHUNK_MS = 50;
const CHUNK_BYTES = (KUGEL_STT_SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
/** Closes after which reconnecting helps: transcription failed mid-stream (1011), the server
 * restarts (1012, 1013), or the connection dropped without a close frame (1006). */
const RETRYABLE_CLOSES = new Set([1006, 1011, 1012, 1013]);
/** How long the end of the call waits for the server to send the last turn and close. */
const DRAIN_TIMEOUT_MS = 5000;
/** How long a fast final waits for its revision before it stands as the turn's text. */
export const REVISION_WAIT_MS = 2000;
/** Liveness: a ping this often, and a socket that has not answered the previous one is dead. */
export const PING_INTERVAL_MS = 10_000;
const TURN_END_REASONS = new Set([
  "client_end_of_speech",
  "model_end_of_turn",
  "silence_timeout",
  "max_duration",
]);

export type KugelSttPluginConfig = {
  /** HTTP(S) API base, e.g. https://api.kugelaudio.com. */
  apiBase: string;
  apiKey: string;
  /** Language code(s); several detect among them, expecting the first. Unset: German or English. */
  language?: string[];
  turnDetection?: "kugelturn" | "vad";
  turnDetectionLevel?: "responsive" | "conservative";
  boostedPhrases?: string[];
  dictionaryIds?: number[];
  projectId?: number;
  /** HTTP CONNECT proxy supplied by the hosted runner's egress policy. */
  proxyUrl?: string;
  /** THIS CALL'S reporter (a runner may serve several calls at once). */
  reporter?: CallReporter;
  /** How long a fast final waits for its revision. Default {@link REVISION_WAIT_MS}. */
  revisionWaitMs?: number;
  /** Liveness ping interval. Default {@link PING_INTERVAL_MS}. */
  pingIntervalMs?: number;
};

export class KugelSttError extends Error {}

/** The stream's WebSocket URL for an HTTP(S) API base. */
export function kugelSttUrl(apiBase: string): string {
  const base = apiBase.trim().replace(/\/+$/, "").replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  return `${base}${STREAM_PATH}`;
}

/** The `config` frame: only what is set, so the service keeps its defaults for the rest. */
export function kugelSttConfigFrame(config: KugelSttPluginConfig): Record<string, unknown> {
  if (config.turnDetectionLevel !== undefined && config.turnDetection === "vad") {
    throw new KugelSttError(
      'kugelaudio.stt({ turnDetectionLevel }) only works with turnDetection "kugelturn"; drop one of them.',
    );
  }
  const frame: Record<string, unknown> = {
    type: "config",
    sample_rate: KUGEL_STT_SAMPLE_RATE,
    model: KUGEL_STT_MODEL,
  };
  if (config.language?.length) frame.language = config.language.length === 1 ? config.language[0] : config.language;
  if (config.turnDetection !== undefined) frame.turn_detection = config.turnDetection;
  if (config.turnDetectionLevel !== undefined) frame.turn_detection_level = config.turnDetectionLevel;
  if (config.boostedPhrases?.length) frame.boosted_phrases = config.boostedPhrases;
  if (config.dictionaryIds !== undefined) frame.dictionary_ids = config.dictionaryIds;
  if (config.projectId !== undefined) frame.project_id = config.projectId;
  return frame;
}

export class KugelSTT extends stt.STT {
  label = "kugelaudio.STT";
  readonly config: KugelSttPluginConfig;

  constructor(config: KugelSttPluginConfig) {
    super({ streaming: true, interimResults: true });
    // Fail at construction, not on the first spoken turn of a live call.
    kugelSttConfigFrame(config);
    this.config = config;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async _recognize(_buffer: unknown): Promise<stt.SpeechEvent> {
    throw new KugelSttError("Kugel STT is streaming-only; use stream().");
  }

  stream(options?: { connOptions?: APIConnectOptions }): KugelSpeechStream {
    return new KugelSpeechStream(this, this.config, options?.connOptions);
  }
}

type ServerFrame = {
  type?: string;
  partial_text?: string;
  is_final?: boolean;
  revises_final?: boolean;
  turn_end_reason?: string;
  language?: string;
  error?: string;
  error_code?: string;
  code?: number;
};

export class KugelSpeechStream extends stt.SpeechStream {
  label = "kugelaudio.SpeechStream";
  private readonly config: KugelSttPluginConfig;
  private ws: WebSocket | null = null;
  /** Why this attempt has to end; the audio loop throws it at its next frame. */
  private failure: Error | null = null;
  /** START_OF_SPEECH was sent for the current turn (by a partial or by its final). */
  private speechStarted = false;
  /** The fast final waiting for its revision. */
  private pendingFinal: { text: string; timer: NodeJS.Timeout } | null = null;
  private resolveDrained: (() => void) | null = null;
  /** An audio_chunk went out on this attempt's socket; without one there is no turn to end. */
  private audioSent = false;
  private heartbeat: NodeJS.Timeout | null = null;
  /** The connect timeout of LiveKit's options: a handshake that takes longer is a failed attempt. */
  private readonly connectTimeoutMs: number;

  constructor(sttImpl: KugelSTT, config: KugelSttPluginConfig, connOptions?: APIConnectOptions) {
    super(sttImpl, KUGEL_STT_SAMPLE_RATE, connOptions);
    this.config = config;
    this.connectTimeoutMs = (connOptions ?? DEFAULT_API_CONNECT_OPTIONS).timeoutMs;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    logError("voice", error.message);
    this.failure = error;
  }

  private emit(type: stt.SpeechEventType, text?: string): void {
    if (this.queue.closed) return;
    const event: stt.SpeechEvent = { type };
    if (text !== undefined) {
      event.alternatives = [
        {
          language: normalizeLanguage(this.config.language?.[0] ?? ""),
          text,
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ];
    }
    this.queue.put(event);
  }

  private handleFrame(raw: WebSocket.RawData): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw.toString()) as ServerFrame;
    } catch {
      this.fail(new KugelSttError(`Kugel STT sent a frame that is not JSON: ${raw.toString().slice(0, 200)}`));
      return;
    }
    if (frame.error !== undefined) {
      const message = `Kugel STT refused the stream: ${frame.error} (${frame.error_code ?? frame.code ?? "no code"})`;
      // A server-side failure or a rate limit may pass on a new connection (ingress sends this
      // frame, then closes 1011 or 1013); a refused request (a 422 language, a 400 model) will not.
      const code = frame.code ?? 0;
      this.fail(code === 429 || code >= 500 ? new APIConnectionError({ message }) : new KugelSttError(message));
      return;
    }
    const text = frame.partial_text?.trim() ?? "";
    if (frame.type === "alternatives" && frame.revises_final) {
      if (this.pendingFinal) {
        this.settle(text);
      } else {
        // Its fast final was empty (the revision then invents words) or already stood in.
        logInfo("voice", `stt revision without a waiting final, dropped: ${JSON.stringify(text)}`);
      }
      return;
    }
    if (frame.type === "partial" && frame.is_final) {
      const reason = frame.turn_end_reason;
      if (reason === undefined || !TURN_END_REASONS.has(reason)) {
        this.fail(new KugelSttError(`Kugel STT ended a turn with an unknown turn_end_reason ${JSON.stringify(reason)}.`));
        return;
      }
      // A new final with one still waiting: the earlier turn's revision is not coming.
      if (this.pendingFinal) this.settle(this.pendingFinal.text);
      if (!text) {
        this.speechStarted = false; // no speech in this turn; its revision is dropped above
        return;
      }
      logInfo("voice", `stt final (${reason}), waiting for its revision: ${JSON.stringify(text)}`);
      const waitMs = this.config.revisionWaitMs ?? REVISION_WAIT_MS;
      const timer = setTimeout(() => {
        if (!this.pendingFinal) return;
        logInfo("voice", `stt: no revision within ${waitMs} ms; the fast final stands`);
        this.settle(this.pendingFinal.text);
      }, waitMs);
      this.pendingFinal = { text, timer };
      return;
    }
    if (frame.type === "partial") {
      if (!text) return;
      if (!this.speechStarted) {
        this.speechStarted = true;
        this.emit(stt.SpeechEventType.START_OF_SPEECH);
      }
      this.emit(stt.SpeechEventType.INTERIM_TRANSCRIPT, text);
    }
    // Other frames (word alternatives without a revision) carry nothing a LiveKit turn uses.
  }

  /** The turn's text is decided: hand it to LiveKit as the final transcript. */
  private settle(text: string): void {
    if (this.pendingFinal) clearTimeout(this.pendingFinal.timer);
    this.pendingFinal = null;
    if (!text) {
      logInfo("voice", "stt turn dropped: its revision is empty");
      this.speechStarted = false;
      return;
    }
    logInfo("voice", `stt turn: ${JSON.stringify(text)}`);
    this.config.reporter?.turn({ speaker: "caller", text, final: true });
    if (!this.speechStarted) this.emit(stt.SpeechEventType.START_OF_SPEECH);
    this.emit(stt.SpeechEventType.FINAL_TRANSCRIPT, text);
    this.emit(stt.SpeechEventType.END_OF_SPEECH);
    this.speechStarted = false;
  }

  /** Opens the socket and sends the config frame; rejects with the refusal's HTTP status. */
  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(kugelSttUrl(this.config.apiBase), {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        // A server that accepts the TCP connection but never answers the upgrade fails the
        // attempt (ws emits an error) instead of leaving the call deaf.
        handshakeTimeout: this.connectTimeoutMs,
        ...(this.config.proxyUrl ? { agent: new HttpsProxyAgent(this.config.proxyUrl) } : {}),
      });
      ws.once("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () => {
          const status = response.statusCode ?? -1;
          reject(
            new APIStatusError({
              message: `Kugel STT refused the connection: HTTP ${status} ${body.slice(0, 300)}`.trim(),
              // A wrong key, no credit or no permission stays wrong on retry; a rate limit or
              // an unavailable service may not.
              options: { statusCode: status, retryable: status === 429 || status >= 500 },
            }),
          );
        });
      });
      ws.once("error", (error) =>
        reject(new APIConnectionError({ message: `Kugel STT connection failed: ${error.message}` })),
      );
      ws.once("open", () => {
        ws.removeAllListeners("error");
        ws.on("error", (error) =>
          this.fail(new APIConnectionError({ message: `Kugel STT socket error: ${error.message}` })),
        );
        ws.on("message", (raw) => this.handleFrame(raw));
        ws.on("close", (code, reason) => this.handleClose(ws, code, reason.toString()));
        this.startHeartbeat(ws);
        ws.send(JSON.stringify(kugelSttConfigFrame(this.config)));
        resolve(ws);
      });
    });
  }

  /** A half-open connection is silent forever; an unanswered ping ends it (close 1006, retried). */
  private startHeartbeat(ws: WebSocket): void {
    let answered = true;
    ws.on("pong", () => (answered = true));
    this.heartbeat = setInterval(() => {
      if (!answered) {
        logError("voice", "kugel stt: no pong within the ping interval; reconnecting");
        ws.terminate();
        return;
      }
      answered = false;
      ws.ping();
    }, this.config.pingIntervalMs ?? PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopHeartbeat();
    // A final that already arrived is the caller's turn whatever happens to the socket next
    // (ingress sends it right before closing 1012 for a restart); its revision is not coming.
    if (this.pendingFinal) this.settle(this.pendingFinal.text);
    if (this.resolveDrained) {
      this.resolveDrained();
      return;
    }
    const message = `Kugel STT closed the stream: ${code} ${reason}`.trim();
    this.fail(
      code === 1000 || !RETRYABLE_CLOSES.has(code)
        ? new APIConnectionError({ message, options: { retryable: false } })
        : new APIConnectionError({ message }),
    );
  }

  private send(chunk: Buffer): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ type: "audio_chunk", audio_b64: chunk.toString("base64") }));
    this.audioSent = true;
  }

  protected async run(): Promise<void> {
    // LiveKit may run this again after a retryable failure: start each attempt clean.
    this.failure = null;
    this.speechStarted = false;
    this.resolveDrained = null;
    this.audioSent = false;
    this.ws = await this.connect();
    logInfo("voice", "kugel stt stream started");
    let pending = Buffer.alloc(0);
    try {
      for await (const item of this.input) {
        if (this.failure) throw this.failure;
        if (item === stt.SpeechStream.FLUSH_SENTINEL) {
          if (pending.length > 0) this.send(pending);
          pending = Buffer.alloc(0);
          continue;
        }
        const frame = item as AudioFrame;
        pending = Buffer.concat([pending, Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)]);
        while (pending.length >= CHUNK_BYTES) {
          this.send(pending.subarray(0, CHUNK_BYTES));
          pending = pending.subarray(CHUNK_BYTES);
        }
      }
      if (this.failure) throw this.failure;
      if (pending.length > 0) this.send(pending);
      await this.drain();
    } finally {
      this.stopHeartbeat();
      if (this.pendingFinal) clearTimeout(this.pendingFinal.timer);
      this.pendingFinal = null;
      const ws = this.ws;
      this.ws = null;
      ws?.close();
    }
  }

  /** End of the call: end the last turn and let the server send its final before closing. */
  private async drain(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // No audio, no turn: end_of_speech on an empty stream is refused (close 1008). A call
    // nobody joined ends here; the socket is closed normally below.
    if (!this.audioSent) return;
    const drained = new Promise<void>((resolve) => (this.resolveDrained = resolve));
    ws.send(JSON.stringify({ type: "end_of_speech" }));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        // KEEP-JUSTIFIED: the call is over; a server that does not close within the drain
        // window only costs the last turn's transcript, and the socket is closed below.
        timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    // The last turn's final arrived but its revision did not before the close: it stands.
    if (this.pendingFinal) this.settle(this.pendingFinal.text);
  }
}
