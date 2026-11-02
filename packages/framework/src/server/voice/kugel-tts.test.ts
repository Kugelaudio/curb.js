import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { KugelTtsSession, type KugelTtsConfig } from "./kugel-tts.js";

type Frame = Record<string, unknown>;

/** In-process /ws/tts/multi stand-in: records inbound frames, lets tests
 * push server frames back. */
class MockTtsServer {
  readonly frames: Frame[] = [];
  private wss!: WebSocketServer;
  private socket: ServerSocket | null = null;
  port = 0;
  connections = 0;
  /** The agent header of each connection, in order. */
  agentHeaders: (string | undefined)[] = [];
  /** Optional scripted reply to each inbound frame; `connection` counts from 1. */
  onFrame: ((socket: ServerSocket, frame: Frame, connection: number) => void) | null = null;

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => this.wss.once("listening", resolve));
    this.port = (this.wss.address() as { port: number }).port;
    this.wss.on("connection", (socket, request) => {
      this.socket = socket;
      this.agentHeaders.push(request.headers["x-kugel-agent"] as string | undefined);
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

describe("KugelTtsSession wire protocol", () => {
  let server: MockTtsServer;
  let session: KugelTtsSession;
  let audio: Array<{ b64: string; turnId: number }>;
  let errors: string[];

  beforeEach(async () => {
    server = new MockTtsServer();
    await server.start();
    audio = [];
    errors = [];
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
      },
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await session.close();
    await server.stop();
  });

  it("names the agent on the connection when the platform gave it a token", async () => {
    vi.stubEnv("KUGELAUDIO_AGENT_TOKEN", "agent-token");
    await session.streamInput(1, "Hello.");
    await server.waitForFrames(1);
    expect(server.agentHeaders).toEqual(["agent-token"]);
  });

  it("sends no agent header without a token", async () => {
    await session.streamInput(1, "Hello.");
    await server.waitForFrames(1);
    expect(server.agentHeaders).toEqual([undefined]);
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
    await session.endInput();
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

  it("a new turn supersedes a context still draining audio", async () => {
    await session.streamInput(1, "First reply.");
    await session.endInput();
    await server.waitForFrames(3);
    const firstContext = server.frames[0].context_id;

    // Input closed but audio still draining (no context_closed yet) — the
    // next turn must cancel it before opening its own context.
    await session.streamInput(2, "Second reply.");
    await server.waitForFrames(5);
    expect(server.frames[3]).toEqual({
      close_context: true,
      context_id: firstContext,
      immediate: true,
    });
    expect(server.frames[4]).toMatchObject({ text: "Second reply." });
    expect(server.frames[4].context_id).not.toBe(firstContext);
  });

  it("surfaces server error frames instead of swallowing them", async () => {
    await session.streamInput(1, "Hi.");
    await server.waitForFrames(1);
    server.send({ context_id: server.frames[0].context_id, error: "voice 9999 not found" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual(["Kugel TTS server error: voice 9999 not found"]);
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
        onError: (message) => errors.push(message),
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
    await session.endInput();
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

  it("past the budget, fails the turn through the error path exactly once", async () => {
    server.onFrame = (socket, frame) => {
      if (frame.voice_settings) refuse(socket);
    };
    // Waits 10 + 20 + 20 ms (capped at the 50 ms budget), then gives up.
    const session = open({ firstDelayMs: 10, budgetMs: 50 });

    await session.streamInput(1, "Hello.");
    await session.endInput();
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
