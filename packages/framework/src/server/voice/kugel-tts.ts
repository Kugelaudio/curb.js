import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import { logInfo } from "../log.js";
import { kugelAgentHeaders } from "../../provider-keys.js";

/**
 * KugelAudio `/ws/tts/multi` client (wire protocol and context lifecycle):
 *
 * One persistent WebSocket, one context per assistant turn. Callers stream
 * raw LLM deltas; the ingress buffers text and admits complete sentences
 * itself, so audio for sentence N starts while the LLM is still producing
 * sentence N+1. Barge-in (`flush`) sends `close_context immediate=true`: the
 * server cancels in-flight generation and late frames are dropped by
 * context id.
 */
export type KugelTtsConfig = {
  apiBase: string;
  apiKey: string;
  voiceId: number;
  modelId: string;
  sampleRate: number;
  /** ISO 639-1 (avoids ~60–150ms auto-detect when normalize=true). */
  language: string;
  /** HTTP CONNECT proxy supplied by the hosted runner's egress policy. */
  proxyUrl?: string;
  /** Pronunciation dictionaries to apply, by id. The service requires
   * `projectId` alongside a selection and rejects the request without it. */
  dictionaryIds?: number[];
  /** KugelAudio project id, required whenever `dictionaryIds` is set. */
  projectId?: number;
};

/** One aligned word of a turn's speech, in seconds from the turn's first
 * audio sample (chunk-relative service times are rebased here). */
export type TtsWordTimestamp = { word: string; startSec: number; endSec: number };

export type KugelTtsHandlers = {
  /** Base64 PCM16 for one turn — passed through as received. */
  onAudio: (audioBase64: string, turnId: number) => void;
  onError: (message: string) => void;
  /** A turn's context finished draining (all audio delivered). Optional —
   * the streaming voice session doesn't need it; one-shot synthesis does. */
  onDone?: (turnId: number) => void;
  /** Word-aligned timestamps for a turn's audio, absolute within the turn.
   * Providing this handler opts the session into server-side alignment
   * (`word_timestamps: true`); it fires once per sentence chunk. */
  onWordTimestamps?: (turnId: number, words: TtsWordTimestamp[]) => void;
};

/** Backoff for the ingress's per-key concurrency limit: the first wait, doubled
 * per refusal, until the waits add up to the budget. */
export type ConcurrencyRetry = { firstDelayMs: number; budgetMs: number };

const DEFAULT_CONCURRENCY_RETRY: ConcurrencyRetry = { firstDelayMs: 100, budgetMs: 5000 };

/** The ingress's refusal when the key's organization already runs its maximum
 * of concurrent generations. It arrives without a context
 * id, and the ingress closes the socket right after it (4029). A runner serves
 * several calls on one key, so this means "wait", not "fail". Other rate
 * limits (requests per minute) are not retried. */
const CONCURRENCY_LIMIT_ERROR = /^Concurrent generation limit reached \(\d+\)$/;

type TurnContext = {
  contextId: string;
  turnId: number;
  /** Audio bytes seen per sentence chunk — rebases each chunk's word
   * timestamps (chunk-relative) onto the turn's timeline. The service sends
   * a chunk's timestamps only after all of its audio frames. */
  bytesByChunk: Map<number, number>;
  /** All text sent for this context, so a context refused at admission can be
   * replayed whole on a fresh socket. */
  text: string;
  /** `endInput` ran: a replay ends with flush + close as well. */
  inputEnded: boolean;
  /** Refused by the concurrency limit and waiting to replay; deltas collect
   * in `text` instead of going out. */
  awaitingRetry: boolean;
  retryAttempts: number;
  retryWaitedMs: number;
};

type ServerFrame = {
  context_id?: string;
  audio?: string;
  chunk_id?: number;
  word_timestamps?: Array<{ word?: string; start_ms?: number; end_ms?: number }>;
  context_closed?: boolean;
  session_closed?: boolean;
  error?: string;
};

export class KugelTtsSession {
  private readonly config: KugelTtsConfig;
  private readonly handlers: KugelTtsHandlers;
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  /** Contexts still routing audio (input may already be closed). Frames for
   * ids not in here are late frames from a barge-in — dropped. */
  private readonly contexts = new Map<string, TurnContext>();
  /** Contexts cancelled by barge-in whose word timestamps may still arrive —
   * alignment of the last generated chunk lands after the cancel, and a cut
   * turn is exactly when the caller needs its word times. Audio for these
   * stays dropped. Bounded to the most recent few. */
  private readonly retired = new Map<string, TurnContext>();
  /** Context currently accepting text input (null between turns). */
  private inputContextId: string | null = null;
  /** Serializes outbound frames: a context's first message carries the voice
   * config and must not interleave with later deltas. */
  private sendChain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly retry: ConcurrencyRetry;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    config: KugelTtsConfig,
    handlers: KugelTtsHandlers,
    retry: ConcurrencyRetry = DEFAULT_CONCURRENCY_RETRY,
  ) {
    this.config = config;
    this.handlers = handlers;
    this.retry = retry;
  }

  /** Prewarm the socket so the first turn skips the WS handshake. */
  async connect(): Promise<void> {
    await this.ensureWs();
  }

  /** Stream one LLM delta for the given turn; opens the turn's context on
   * the first delta. */
  streamInput(turnId: number, text: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed || !text) return;
      const current = this.inputContextId === null ? undefined : this.contexts.get(this.inputContextId);
      if (current?.awaitingRetry) {
        current.text += text;
        return;
      }
      const askedAt = performance.now();
      const ws = await this.ensureWs();
      const waited = performance.now() - askedAt;
      // Only when it cost something: a prewarmed socket returns instantly and
      // logging that every delta would bury the case that matters.
      if (waited > 5) {
        logInfo("voice", `tts socket wait ${Math.round(waited)}ms @${Math.round(performance.now())}`);
      }

      if (this.inputContextId === null) {
        // A new turn supersedes any context still draining audio — otherwise
        // two replies would interleave on the shared socket.
        for (const [staleId, stale] of this.contexts) {
          this.contexts.delete(staleId);
          this.retire(staleId, stale);
          // A context waiting to replay never reached this socket.
          if (stale.awaitingRetry) continue;
          this.sendJson(ws, { close_context: true, context_id: staleId, immediate: true });
        }
        const contextId = randomUUID().replaceAll("-", "").slice(0, 12);
        this.inputContextId = contextId;
        logInfo("voice", `tts context open @${Math.round(performance.now())}`);
        this.contexts.set(contextId, {
          contextId,
          turnId,
          bytesByChunk: new Map(),
          text,
          inputEnded: false,
          awaitingRetry: false,
          retryAttempts: 0,
          retryWaitedMs: 0,
        });
        this.sendJson(ws, this.openFrame(contextId, text));
        return;
      }

      const context = this.contexts.get(this.inputContextId);
      if (context) context.text += text;
      this.sendJson(ws, { context_id: this.inputContextId, text });
    });
  }

  /** First message of a context: it carries the voice/session config. */
  private openFrame(contextId: string, text: string): Record<string, unknown> {
    return {
      context_id: contextId,
      text,
      model_id: this.config.modelId,
      sample_rate: this.config.sampleRate,
      normalize: true,
      language: this.config.language,
      // Server-side forced alignment costs an extra engine RPC per
      // sentence — only ask for it when someone is listening.
      word_timestamps: this.handlers.onWordTimestamps !== undefined,
      voice_settings: { voice_id: this.config.voiceId },
      // Pronunciation dictionaries, sent only when authored. The service
      // treats `dictionary_ids: []` as an explicit opt-out rather than
      // "unset", so an empty array must not be sent in place of nothing.
      ...(this.config.projectId !== undefined
        ? { project_id: this.config.projectId }
        : {}),
      ...(this.config.dictionaryIds?.length
        ? { dictionary_ids: this.config.dictionaryIds }
        : {}),
    };
  }

  /** Close the current turn's input: flush the server's sentence buffer, then
   * let the context drain gracefully (audio keeps arriving until
   * `context_closed`). */
  endInput(): Promise<void> {
    return this.enqueue(async () => {
      if (this.inputContextId === null) return;
      const contextId = this.inputContextId;
      this.inputContextId = null;
      const context = this.contexts.get(contextId);
      if (context) {
        context.inputEnded = true;
        // The replay sends flush + close itself.
        if (context.awaitingRetry) return;
      }
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      logInfo("voice", `tts flush @${Math.round(performance.now())}`);
      this.sendJson(ws, { context_id: contextId, text: "", flush: true });
      this.sendJson(ws, { close_context: true, context_id: contextId });
    });
  }

  /** Barge-in: cancel every in-flight context server-side, drop late frames. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      const cancelled = [...this.contexts];
      this.contexts.clear();
      this.inputContextId = null;
      for (const [contextId, context] of cancelled) this.retire(contextId, context);
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const [contextId, context] of cancelled) {
        if (context.awaitingRetry) continue;
        this.sendJson(ws, { close_context: true, context_id: contextId, immediate: true });
      }
    });
  }

  private retire(contextId: string, context: TurnContext): void {
    this.retired.set(contextId, context);
    while (this.retired.size > 4) {
      const oldest = this.retired.keys().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    await this.flush();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.sendJson(ws, { close_socket: true });
      ws.close();
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.sendChain.then(operation);
    // Keep the chain alive after a failed operation; the error still reaches
    // the caller through `next`.
    this.sendChain = next.catch(() => undefined);
    return next;
  }

  private sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  private ensureWs(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;

    const base = this.config.apiBase
      .replace("https://", "wss://")
      .replace("http://", "ws://")
      .replace(/\/+$/, "");
    const url = `${base}/ws/tts/multi?api_key=${encodeURIComponent(this.config.apiKey)}`;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: kugelAgentHeaders(process.env),
        ...(this.config.proxyUrl ? { agent: new HttpsProxyAgent(this.config.proxyUrl) } : {}),
      });
      ws.on("open", () => {
        this.ws = ws;
        this.connecting = null;
        resolve(ws);
      });
      ws.on("message", (data) => this.handleFrame(ws, data.toString()));
      ws.on("error", (error) => {
        this.connecting = null;
        if (this.ws === ws) this.ws = null;
        const message = `Kugel TTS connection failed: ${error.message}`;
        this.handlers.onError(message);
        reject(new Error(message));
      });
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        // Contexts waiting to replay after a concurrency refusal live on.
        const inFlight = [...this.contexts.values()].filter((context) => !context.awaitingRetry);
        if (inFlight.length > 0 && !this.closed) {
          this.handlers.onError(
            `Kugel TTS connection closed with ${inFlight.length} context(s) in flight.`,
          );
          for (const context of inFlight) this.finishContext(context.contextId);
        }
      });
    });
    return this.connecting;
  }

  private handleFrame(ws: WebSocket, raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      this.handlers.onError("Kugel TTS sent a non-JSON frame.");
      return;
    }
    if (frame.session_closed) return;
    const contextId = frame.context_id;
    if (frame.error && CONCURRENCY_LIMIT_ERROR.test(frame.error)) {
      this.deferRefusedContexts(ws, frame.error, contextId);
      return;
    }
    if (frame.error) {
      this.handlers.onError(`Kugel TTS server error: ${frame.error}`);
      if (contextId) this.finishContext(contextId);
      return;
    }
    if (!contextId) return;
    const context = this.contexts.get(contextId);
    if (!context) {
      // Late frame after barge-in: audio is dropped, but word timestamps for
      // a just-cancelled context still matter — they say what was heard.
      const cancelled = this.retired.get(contextId);
      if (cancelled && frame.word_timestamps && this.handlers.onWordTimestamps) {
        const words = this.rebaseWordTimestamps(cancelled, frame);
        if (words.length > 0) this.handlers.onWordTimestamps(cancelled.turnId, words);
      }
      return;
    }
    if (frame.audio) {
      if (context.bytesByChunk.size === 0) {
        // The number that matters: everything before it is ours, everything
        // after it is playout.
        logInfo("voice", `tts first frame @${Math.round(performance.now())}`);
      }
      const chunkId = typeof frame.chunk_id === "number" ? frame.chunk_id : 0;
      context.bytesByChunk.set(
        chunkId,
        (context.bytesByChunk.get(chunkId) ?? 0) + Buffer.byteLength(frame.audio, "base64"),
      );
      this.handlers.onAudio(frame.audio, context.turnId);
    }
    if (frame.word_timestamps && this.handlers.onWordTimestamps) {
      const words = this.rebaseWordTimestamps(context, frame);
      if (words.length > 0) this.handlers.onWordTimestamps(context.turnId, words);
    }
    if (frame.context_closed) {
      this.finishContext(contextId);
      this.handlers.onDone?.(context.turnId);
    }
  }

  /** The key is at its concurrency limit: replay the refused context(s) on a
   * fresh socket after a doubling backoff, so the utterance plays late instead
   * of never. Past the budget the turn fails through `onError`, once. */
  private deferRefusedContexts(ws: WebSocket, error: string, contextId?: string): void {
    // The ingress closes this socket after the refusal; send nothing more on it.
    if (this.ws === ws) this.ws = null;
    ws.close();
    const refused = contextId
      ? [this.contexts.get(contextId)]
      : [...this.contexts.values()];
    for (const context of refused) {
      if (!context || context.awaitingRetry) continue;
      const delayMs = Math.min(
        this.retry.firstDelayMs * 2 ** context.retryAttempts,
        this.retry.budgetMs - context.retryWaitedMs,
      );
      if (delayMs <= 0) {
        this.finishContext(context.contextId);
        this.handlers.onError(
          `Kugel TTS server error: ${error} (still refused after ${context.retryWaitedMs}ms of retries)`,
        );
        continue;
      }
      context.awaitingRetry = true;
      context.retryAttempts += 1;
      context.retryWaitedMs += delayMs;
      logInfo("voice", `tts concurrency limit, retry ${context.retryAttempts} in ${delayMs}ms`);
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        // KEEP-JUSTIFIED: a failed reconnect already reached `onError` in
        // `ensureWs`, and the replay dropped its context.
        this.replay(context).catch(() => undefined);
      }, delayMs);
      this.retryTimers.add(timer);
    }
  }

  /** Re-send a refused context whole: its config, all text so far, and the
   * flush + close when its input already ended. */
  private replay(context: TurnContext): Promise<void> {
    return this.enqueue(async () => {
      // Barge-in or a newer turn removed it while it waited.
      if (this.closed || this.contexts.get(context.contextId) !== context) return;
      let ws: WebSocket;
      try {
        ws = await this.ensureWs();
      } catch (error) {
        this.finishContext(context.contextId);
        throw error;
      }
      context.awaitingRetry = false;
      context.bytesByChunk.clear();
      this.sendJson(ws, this.openFrame(context.contextId, context.text));
      if (context.inputEnded) {
        this.sendJson(ws, { context_id: context.contextId, text: "", flush: true });
        this.sendJson(ws, { close_context: true, context_id: context.contextId });
      }
    });
  }

  /** Chunk word times are relative to that chunk's audio; shift them by the
   * duration of every earlier chunk so they land on the turn's timeline.
   * Safe because the service emits a chunk's timestamps only after all of
   * its audio frames (16-bit mono PCM → bytes/2/rate = seconds). */
  private rebaseWordTimestamps(context: TurnContext, frame: ServerFrame): TtsWordTimestamp[] {
    const chunkId = typeof frame.chunk_id === "number" ? frame.chunk_id : 0;
    let bytesBefore = 0;
    for (const [id, bytes] of context.bytesByChunk) {
      if (id < chunkId) bytesBefore += bytes;
    }
    const offsetSec = bytesBefore / 2 / this.config.sampleRate;
    const words: TtsWordTimestamp[] = [];
    for (const entry of frame.word_timestamps ?? []) {
      if (
        typeof entry.word !== "string" ||
        typeof entry.start_ms !== "number" ||
        typeof entry.end_ms !== "number"
      ) {
        continue;
      }
      words.push({
        word: entry.word,
        startSec: offsetSec + entry.start_ms / 1000,
        endSec: offsetSec + entry.end_ms / 1000,
      });
    }
    return words;
  }

  private finishContext(contextId: string): void {
    this.contexts.delete(contextId);
    if (this.inputContextId === contextId) this.inputContextId = null;
  }
}
