import { initializeLogger } from "@livekit/agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { KugelTtsSession, type KugelTtsConfig } from "./kugel-tts.js";
import { KugelTTS } from "./livekit-host/kugel-tts-plugin.js";

initializeLogger({ pretty: false, level: "silent" });

type Frame = Record<string, unknown>;

/** In-process /ws/tts/multi stand-in: records inbound frames, lets tests
 * push server frames back. */
class MockTtsServer {
  readonly frames: Frame[] = [];
  private wss!: WebSocketServer;
  private socket: ServerSocket | null = null;
  port = 0;
  connections = 0;
  /** Optional scripted reply to each inbound frame; `connection` counts from 1. */
  onFrame: ((socket: ServerSocket, frame: Frame, connection: number) => void) | null = null;

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => this.wss.once("listening", resolve));
    this.port = (this.wss.address() as { port: number }).port;
    this.wss.on("connection", (socket) => {
      this.socket = socket;
      const connection = ++this.connections;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Frame;
        this.frames.push(frame);
        this.onFrame?.(socket, frame, connection);
      });
    });
  }

  send(frame: Frame): void {
    this.socket?.send(JSON.stringify(frame));
  }

  async waitForFrames(count: number, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`Expected ${count} frames, got ${this.frames.length}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

it("settles one-shot output when the provider closes before a context can open", async () => {
  const server = new MockTtsServer();
  await server.start();
  const provider = new KugelTTS({
    apiBase: `http://127.0.0.1:${server.port}`,
    apiKey: "test-key",
    voiceId: 1072,
    modelId: "kugel-3",
    sampleRate: 24000,
    language: "en",
  });
  // The socket handshake and the one-shot task both start asynchronously.
  // Close in the same turn, before either can open a context.
  const output = provider.synthesize("Hello.");
  const closing = provider.close();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("One-shot output did not settle after provider close.")), 1000);
    });
    await Promise.race([closing, deadline]);
    await expect(Promise.race([output.next(), deadline])).resolves.toMatchObject({ done: true });
    expect(server.frames).toEqual([]);
  } finally {
    clearTimeout(timeout);
    output.close();
    await server.stop();
  }
});

describe("KugelTtsSession wire protocol", () => {
  let server: MockTtsServer;
  let session: KugelTtsSession;
  let audio: Array<{ b64: string; turnId: number }>;
  let errors: string[];
  let done: number[];

  beforeEach(async () => {
    server = new MockTtsServer();
    await server.start();
    audio = [];
    errors = [];
    done = [];
    session = new KugelTtsSession(
      {
        apiBase: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
        voiceId: 1072,
        modelId: "kugel-3",
        sampleRate: 24000,
        language: "en",
      },
      {
        onAudio: (b64, turnId) => audio.push({ b64, turnId }),
        onError: (message) => errors.push(message),
        onDone: (turnId) => done.push(turnId),
      },
    );
  });

  afterEach(async () => {
    await session.close();
    await server.stop();
  });

  it("opens a context with full voice config on the first delta, then bare deltas", async () => {
    await session.streamInput(1, "Hello ");
    await session.streamInput(1, "world.");
    await server.waitForFrames(2);

    const [first, second] = server.frames;
    expect(first).toMatchObject({
      text: "Hello ",
      model_id: "kugel-3",
      sample_rate: 24000,
      normalize: true,
      language: "en",
      voice_settings: { voice_id: 1072 },
    });
    expect(typeof first.context_id).toBe("string");
    expect(second).toEqual({ context_id: first.context_id, text: "world." });
  });

  it("endInput flushes the sentence buffer then closes the context gracefully", async () => {
    await session.streamInput(1, "Hi.");
    await session.endInput(1);
    await server.waitForFrames(3);

    const contextId = server.frames[0].context_id;
    expect(server.frames[1]).toEqual({ context_id: contextId, text: "", flush: true });
    expect(server.frames[2]).toEqual({ close_context: true, context_id: contextId });
  });

  it("routes audio frames by context and stamps the turn id; drops late frames after flush", async () => {
    await session.streamInput(3, "Hi.");
    await server.waitForFrames(1);
    const contextId = server.frames[0].context_id as string;

    server.send({ context_id: contextId, audio: "QUJD" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audio).toEqual([{ b64: "QUJD", turnId: 3 }]);

    // Barge-in: close_context immediate goes out, further frames are dropped.
    await session.flush();
    await server.waitForFrames(2);
    expect(server.frames[1]).toEqual({
      close_context: true,
      context_id: contextId,
      immediate: true,
    });
    server.send({ context_id: contextId, audio: "REVG" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audio).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("a new turn leaves an earlier turn draining audio", async () => {
    await session.streamInput(1, "First reply.");
    await session.endInput(1);
    await server.waitForFrames(3);
    const firstContext = server.frames[0].context_id;

    await session.streamInput(2, "Second reply.");
    await server.waitForFrames(4);
    expect(server.frames[3]).toMatchObject({ text: "Second reply." });
    expect(server.frames[3].context_id).not.toBe(firstContext);

    server.send({ context_id: firstContext, audio: "QUJD" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audio).toEqual([{ b64: "QUJD", turnId: 1 }]);
  });

  it("surfaces server error frames instead of swallowing them", async () => {
    await session.streamInput(1, "Hi.");
    await server.waitForFrames(1);
    server.send({ context_id: server.frames[0].context_id, error: "voice 9999 not found" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual(["Kugel TTS server error: voice 9999 not found"]);
  });

  it("closes a failed context while another turn keeps receiving audio", async () => {
    await session.streamInput(1, "First turn.");
    await session.streamInput(2, "Second turn.");
    await server.waitForFrames(2);
    const [failed, other] = server.frames;
    server.send({ context_id: failed.context_id, error: "Voice unavailable" });
    server.send({ context_id: other.context_id, audio: "QUJD" });

    await server.waitForFrames(3);
    expect(server.frames[2]).toEqual({ close_context: true, context_id: failed.context_id, immediate: true });
    await session.endInput(2);
    await server.waitForFrames(5);
    expect(server.frames[4]).toEqual({ close_context: true, context_id: other.context_id });
    server.send({ context_id: other.context_id, context_closed: true });
    await vi.waitFor(() => expect(done).toEqual([2]));
    expect(audio).toEqual([{ b64: "QUJD", turnId: 2 }]);
    expect(errors).toEqual(["Kugel TTS server error: Voice unavailable"]);
  });

  it("rebases chunk-relative word timestamps onto the turn timeline", async () => {
    const received: Array<{ turnId: number; words: unknown }> = [];
    let audioFrames = 0;
    const withWords = new KugelTtsSession(
      {
        apiBase: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
        voiceId: 1072,
        modelId: "kugel-3",
        sampleRate: 24000,
        language: "en",
      },
      {
        onAudio: () => {
          audioFrames += 1;
        },
        onError: (message) => errors.push(message),
        onWordTimestamps: (turnId, words) => received.push({ turnId, words }),
      },
    );

    await withWords.streamInput(7, "Good to hear. Now then.");
    await server.waitForFrames(1);
    const first = server.frames[0];
    expect(first).toMatchObject({ word_timestamps: true });
    const contextId = first.context_id as string;

    // Chunk 0: exactly 1s of PCM16 @ 24k, then its (chunk-relative) words.
    server.send({ context_id: contextId, audio: Buffer.alloc(48000).toString("base64"), chunk_id: 0 });
    server.send({
      context_id: contextId,
      chunk_id: 0,
      word_timestamps: [{ word: "Good", start_ms: 60, end_ms: 240, char_start: 0, char_end: 4, score: 1 }],
    });
    // Chunk 1: its words must be shifted by chunk 0's full second.
    server.send({ context_id: contextId, audio: Buffer.alloc(24000).toString("base64"), chunk_id: 1 });
    server.send({
      context_id: contextId,
      chunk_id: 1,
      word_timestamps: [{ word: "Now", start_ms: 100, end_ms: 300, char_start: 14, char_end: 17, score: 1 }],
    });

    const deadline = Date.now() + 2000;
    while (received.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(received).toEqual([
      { turnId: 7, words: [{ word: "Good", startSec: 0.06, endSec: 0.24 }] },
      { turnId: 7, words: [{ word: "Now", startSec: 1.1, endSec: 1.3 }] },
    ]);

    // Barge-in: timestamps landing AFTER the flush still deliver — a cut
    // turn is exactly when the caller needs its word times — while audio for
    // the cancelled context stays dropped.
    const framesBefore = audioFrames;
    await withWords.flush();
    server.send({ context_id: contextId, audio: Buffer.alloc(24000).toString("base64"), chunk_id: 2 });
    server.send({
      context_id: contextId,
      chunk_id: 1,
      word_timestamps: [{ word: "then.", start_ms: 400, end_ms: 600, char_start: 18, char_end: 23, score: 1 }],
    });
    const lateDeadline = Date.now() + 2000;
    while (received.length < 3 && Date.now() < lateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(received[2]).toEqual({
      turnId: 7,
      words: [{ word: "then.", startSec: 1.4, endSec: 1.6 }],
    });
    expect(audioFrames).toBe(framesBefore);
    await withWords.close();
  });
});

describe("KugelTtsSession dictionary selection", () => {
  let server: MockTtsServer;

  beforeEach(async () => {
    server = new MockTtsServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  const open = (extra: Partial<KugelTtsConfig>) =>
    new KugelTtsSession(
      {
        apiBase: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
        voiceId: 1840,
        modelId: "kugel-3",
        sampleRate: 24000,
        language: "de",
        ...extra,
      },
      { onAudio: () => {}, onError: () => {} },
    );

  it("carries the selection and its project on the context's first message", async () => {
    const session = open({ projectId: 42, dictionaryIds: [7] });
    await session.streamInput(1, "Hallo.");
    await server.waitForFrames(1);

    expect(server.frames[0]).toMatchObject({ project_id: 42, dictionary_ids: [7] });
    await session.close();
  });

});

describe("KugelTtsSession concurrency limit", () => {
  let server: MockTtsServer;
  let audio: Array<{ b64: string; turnId: number }>;
  let errors: string[];
  let errorTurns: number[];
  let done: number[];

  /** The ingress's answer when the key already runs its maximum of
   * generations: a session-scoped error frame, then close 4029. */
  const refuse = (socket: ServerSocket, error = "Concurrent generation limit reached (1)") => {
    socket.send(JSON.stringify({ error, error_code: "RATE_LIMITED", code: 429 }));
    socket.close(4029, error);
  };

  const open = (retry = { firstDelayMs: 10, budgetMs: 5000 }) =>
    new KugelTtsSession(
      {
        apiBase: `http://127.0.0.1:${server.port}`,
        apiKey: "test-key",
        voiceId: 1072,
        modelId: "kugel-3",
        sampleRate: 24000,
        language: "en",
      },
      {
        onAudio: (b64, turnId) => audio.push({ b64, turnId }),
        onError: (message, turnId) => {
          errors.push(message);
          errorTurns.push(turnId);
        },
        onDone: (turnId) => done.push(turnId),
      },
      retry,
    );

  const waitFor = async (condition: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  beforeEach(async () => {
    server = new MockTtsServer();
    await server.start();
    audio = [];
    errors = [];
    errorTurns = [];
    done = [];
  });

  afterEach(async () => {
    await server.stop();
  });

  it("replays a refused context after backoff, so the utterance plays late instead of never", async () => {
    // Refuse the first two admissions, then serve: the third socket must get
    // the whole turn (config, every delta, flush, close) and its audio plays.
    const served: Frame[] = [];
    server.onFrame = (socket, frame, connection) => {
      if (connection <= 2) {
        if (frame.voice_settings) refuse(socket);
        return;
      }
      served.push(frame);
      if (frame.close_context) {
        socket.send(JSON.stringify({ context_id: frame.context_id, audio: "QUJD" }));
        socket.send(JSON.stringify({ context_id: frame.context_id, context_closed: true }));
      }
    };
    const session = open();

    await session.streamInput(1, "Hello ");
    await waitFor(() => server.connections >= 2);
    // Deltas during the backoff collect and go out with the replay.
    await session.streamInput(1, "world.");
    await session.endInput(1);
    await waitFor(() => done.length === 1);

    expect(server.connections).toBe(3);
    expect(served[0]).toMatchObject({ voice_settings: { voice_id: 1072 }, model_id: "kugel-3" });
    const contextId = served[0].context_id;
    expect(served.map((frame) => frame.text ?? "").join("")).toBe("Hello world.");
    expect(served.at(-2)).toEqual({ context_id: contextId, text: "", flush: true });
    expect(served.at(-1)).toEqual({ close_context: true, context_id: contextId });
    expect(audio).toEqual([{ b64: "QUJD", turnId: 1 }]);
    expect(done).toEqual([1]);
    expect(errors).toEqual([]);
    await session.close();
  });

  it("replays the refused turn without repeating audio from a turn already speaking", async () => {
    const started: unknown[] = [];
    server.onFrame = (socket, frame, connection) => {
      if (frame.voice_settings) {
        started.push(frame.text);
        if (connection === 1 && frame.text === "First turn.") {
          socket.send(JSON.stringify({ context_id: frame.context_id, audio: "QUJD" }));
        } else if (connection === 1) {
          refuse(socket);
        }
      }
      if (connection > 1 && frame.close_context) {
        socket.send(JSON.stringify({ context_id: frame.context_id, context_closed: true }));
      }
    };
    const session = open();
    try {
      await session.streamInput(1, "First turn.");
      await session.endInput(1);
      await waitFor(() => audio.length === 1);
      await session.streamInput(2, "Second turn.");
      await session.endInput(2);
      await waitFor(() => done.includes(2));

      expect(started).toEqual(["First turn.", "Second turn.", "Second turn."]);
      expect(done).toEqual([2]);
      expect(audio).toEqual([{ b64: "QUJD", turnId: 1 }]);
      expect(errors).toEqual([expect.stringContaining("already delivered audio")]);
      expect(errorTurns).toEqual([1]);
    } finally {
      await session.close();
    }
  });

  it("past the budget, fails the turn through the error path exactly once", async () => {
    server.onFrame = (socket, frame) => {
      if (frame.voice_settings) refuse(socket);
    };
    // Waits 10 + 20 + 20 ms (capped at the 50 ms budget), then gives up.
    const session = open({ firstDelayMs: 10, budgetMs: 50 });

    await session.streamInput(1, "Hello.");
    await session.endInput(1);
    await waitFor(() => errors.length > 0);
    // Room for a stray "connection closed" or a further retry to show up.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(server.connections).toBe(4);
    expect(errors).toEqual([
      "Kugel TTS server error: Concurrent generation limit reached (1) (still refused after 50ms of retries)",
    ]);
    expect(audio).toEqual([]);
    await session.close();
  });

  it("does not retry other rate limits", async () => {
    server.onFrame = (socket, frame) => {
      if (frame.voice_settings) refuse(socket, "Requests per minute limit reached (60)");
    };
    const session = open();

    await session.streamInput(1, "Hello.");
    await waitFor(() => errors.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(server.connections).toBe(1);
    expect(errors[0]).toBe("Kugel TTS server error: Requests per minute limit reached (60)");
    await session.close();
  });

  it("barge-in during the backoff cancels the replay", async () => {
    server.onFrame = (socket, frame, connection) => {
      if (connection === 1 && frame.voice_settings) refuse(socket);
    };
    const session = open({ firstDelayMs: 50, budgetMs: 5000 });

    await session.streamInput(1, "Hello.");
    await waitFor(() => server.connections === 1 && server.frames.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await session.flush();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(server.connections).toBe(1);
    expect(errors).toEqual([]);
    await session.close();
  });
});
