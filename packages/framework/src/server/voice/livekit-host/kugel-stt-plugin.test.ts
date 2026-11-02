import { initializeLogger, stt } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import {
  KugelSTT,
  KugelSttError,
  kugelSttConfigFrame,
  kugelSttUrl,
  type KugelSttPluginConfig,
} from "./kugel-stt-plugin.js";

initializeLogger({ pretty: false, level: "silent" });

/** A stand-in for /v1/audio/transcriptions/stream: records what the client sends, and lets a
 * test send server frames or refuse the upgrade. */
class FakeAsrServer {
  private wss!: WebSocketServer;
  port = 0;
  socket: ServerSocket | null = null;
  /** Upgrades completed so far: a retry shows up as a second connection. */
  connections = 0;
  received: Record<string, unknown>[] = [];
  authorization: string | undefined;
  agentHeader: string | undefined;
  refuseWith: number | null = null;

  /** `autoPong: false` plays a half-open connection that never answers a ping. */
  async start(options: { autoPong?: boolean } = {}): Promise<void> {
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      autoPong: options.autoPong ?? true,
      verifyClient: (_info, done) =>
        this.refuseWith === null ? done(true) : done(false, this.refuseWith, "refused"),
    });
    await new Promise<void>((resolve) => this.wss.once("listening", resolve));
    this.port = (this.wss.address() as { port: number }).port;
    this.wss.on("connection", (socket, request) => {
      this.socket = socket;
      this.connections += 1;
      this.authorization = request.headers.authorization;
      this.agentHeader = request.headers["x-kugel-agent"] as string | undefined;
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        this.received.push(frame);
        // As the service does: the last turn is over, close normally.
        if (frame.type === "end_of_speech") socket.close(1000);
      });
    });
  }

  /** Sends to the newest connection, once it has sent its config frame. */
  async send(frame: Record<string, unknown>): Promise<void> {
    await this.until(() => this.socket !== null && this.received.some((f) => f.type === "config"));
    this.socket!.send(JSON.stringify(frame));
  }

  close(code: number): void {
    this.socket?.close(code);
  }

  async until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(predicate()).toBe(true);
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

const final = (text: string, reason = "model_end_of_turn") => ({
  type: "partial",
  partial_text: text,
  is_final: true,
  model: "kugel-ear-1",
  turn_end_reason: reason,
});
const revision = (text: string) => ({
  type: "alternatives",
  partial_text: text,
  revises_final: true,
  language: "de",
  word_alternatives: [],
});

/** 20 ms of 16 kHz silence. */
const frame = () => new AudioFrame(new Int16Array(320), 16000, 1, 320);

describe("kugel stt plugin", () => {
  let server: FakeAsrServer;
  let config: KugelSttPluginConfig;

  beforeEach(async () => {
    server = new FakeAsrServer();
    await server.start();
    config = { apiBase: `http://127.0.0.1:${server.port}`, apiKey: "test-key", language: ["de"] };
  });
  afterEach(async () => {
    await server.stop();
  });

  /** Opens a stream, feeds it audio, and collects its events until it closes. */
  function open(overrides: Partial<KugelSttPluginConfig> = {}, maxRetry = 0) {
    const plugin = new KugelSTT({ ...config, ...overrides });
    const errors: Error[] = [];
    plugin.on("error", (event: { error: Error }) => errors.push(event.error));
    // No retries unless a test asks: a retryable failure would otherwise reconnect for seconds.
    const stream = plugin.stream({ connOptions: { maxRetry, retryIntervalMs: 0, timeoutMs: 1000 } });
    const events: stt.SpeechEvent[] = [];
    const done = (async () => {
      for await (const event of stream) events.push(event);
    })();
    const feeder = setInterval(() => {
      // KEEP-JUSTIFIED: pushing into a stream the test already closed is not under test.
      try {
        stream.pushFrame(frame());
      } catch {}
    }, 20);
    const close = async () => {
      clearInterval(feeder);
      stream.endInput();
      await done;
    };
    return { stream, events, errors, done, close, stop: () => clearInterval(feeder) };
  }

  it("builds the stream URL and a config frame with only what is set", () => {
    expect(kugelSttUrl("https://api.kugelaudio.com/")).toBe("wss://api.kugelaudio.com/v1/audio/transcriptions/stream");
    expect(kugelSttUrl("http://127.0.0.1:8000")).toBe("ws://127.0.0.1:8000/v1/audio/transcriptions/stream");
    expect(kugelSttConfigFrame({ apiBase: "x", apiKey: "k" })).toEqual({
      type: "config",
      sample_rate: 16000,
      model: "kugel-ear-1",
    });
    expect(
      kugelSttConfigFrame({
        apiBase: "x",
        apiKey: "k",
        language: ["de", "en"],
        turnDetection: "kugelturn",
        turnDetectionLevel: "conservative",
        boostedPhrases: ["Beispiel GmbH"],
        dictionaryIds: [],
        projectId: 42,
      }),
    ).toEqual({
      type: "config",
      sample_rate: 16000,
      model: "kugel-ear-1",
      language: ["de", "en"],
      turn_detection: "kugelturn",
      turn_detection_level: "conservative",
      boosted_phrases: ["Beispiel GmbH"],
      dictionary_ids: [],
      project_id: 42,
    });
    expect(() => new KugelSTT({ apiBase: "x", apiKey: "k", turnDetection: "vad", turnDetectionLevel: "responsive" })).toThrow(
      KugelSttError,
    );
  });

  it("names the agent on the connection when the platform gave it a token", async () => {
    vi.stubEnv("KUGELAUDIO_AGENT_TOKEN", "agent-token");
    const call = open();
    await server.until(() => server.received.length >= 1);
    expect(server.agentHeader).toBe("agent-token");
    await call.close();
    vi.unstubAllEnvs();
  });

  it("sends no agent header without a token", async () => {
    const call = open();
    await server.until(() => server.received.length >= 1);
    expect(server.agentHeader).toBeUndefined();
    await call.close();
  });

  it("authenticates, sends the config, then base64 PCM16 audio chunks", async () => {
    const call = open();
    await server.until(() => server.received.length >= 3);
    expect(server.authorization).toBe("Bearer test-key");
    expect(server.received[0]).toEqual({ type: "config", sample_rate: 16000, model: "kugel-ear-1", language: "de" });
    const chunk = server.received[1] as { type: string; audio_b64: string };
    expect(chunk.type).toBe("audio_chunk");
    expect(Buffer.from(chunk.audio_b64, "base64").length).toBe(1600); // 50 ms at 16 kHz
    await call.close();
    expect(server.received.at(-1)).toEqual({ type: "end_of_speech" });
  });

  it("ends a stream that carried no audio without sending end_of_speech", async () => {
    // A call no caller joined: the stream ends before any audio. end_of_speech on an empty
    // stream is a protocol error (1008), seen every ~40 s from an automated check.
    const plugin = new KugelSTT(config);
    const stream = plugin.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 } });
    const done = (async () => {
      for await (const _event of stream) {
        // no events expected
      }
    })();
    await server.until(() => server.received.some((f) => f.type === "config"));
    stream.endInput();
    await done;
    expect(server.received.map((f) => f.type)).toEqual(["config"]);
  });

  it("takes the revision as the turn's text and reports partials as interim", async () => {
    const call = open();
    await server.until(() => server.received.length >= 1);
    await server.send({ type: "partial", partial_text: "Meine Mail", is_final: false });
    await server.send(final("ist max mustermann"));
    await server.send(revision("Meine E-Mail ist max.mustermann@example.de."));
    await server.until(() => call.events.some((e) => e.type === stt.SpeechEventType.END_OF_SPEECH));
    await call.close();
    expect(call.events.map((e) => [e.type, e.alternatives?.[0]?.text])).toEqual([
      [stt.SpeechEventType.START_OF_SPEECH, undefined],
      [stt.SpeechEventType.INTERIM_TRANSCRIPT, "Meine Mail"],
      [stt.SpeechEventType.FINAL_TRANSCRIPT, "Meine E-Mail ist max.mustermann@example.de."],
      [stt.SpeechEventType.END_OF_SPEECH, undefined],
    ]);
  });

  it("drops an empty turn together with the words its revision invents", async () => {
    const call = open();
    await server.until(() => server.received.length >= 1);
    await server.send(final("", "silence_timeout"));
    await server.send(revision("Okay."));
    await server.send(final("Ja"));
    await server.send(revision("Ja."));
    await server.until(() => call.events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT));
    await call.close();
    expect(call.events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT).map((e) => e.alternatives?.[0]?.text)).toEqual([
      "Ja.",
    ]);
  });

  it("lets the fast final stand when no revision arrives in time", async () => {
    const call = open({ revisionWaitMs: 50 });
    await server.until(() => server.received.length >= 1);
    await server.send(final("Hallo"));
    await server.until(() => call.events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT));
    await call.close();
    expect(call.events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)?.alternatives?.[0]?.text).toBe("Hallo");
  });

  it("fails the stream when the connection is refused", async () => {
    server.refuseWith = 403;
    const call = open();
    await call.done;
    call.stop();
    expect(call.errors.map((e) => e.message)).toEqual([expect.stringMatching(/refused the connection: HTTP 403/)]);
  });

  it("fails the stream on an error frame", async () => {
    const call = open();
    await server.until(() => server.received.length >= 1);
    await server.send({ error: "Unsupported language", error_code: "VALIDATION_ERROR", code: 422 });
    await call.done;
    call.stop();
    expect(call.errors.map((e) => e.message)).toEqual([expect.stringMatching(/refused the stream: Unsupported language/)]);
  });

  it("fails the stream on a turn_end_reason the protocol does not define", async () => {
    const call = open();
    await server.until(() => server.received.length >= 1);
    await server.send(final("Hallo", "made_up"));
    await call.done;
    call.stop();
    expect(call.errors.map((e) => e.message)).toEqual([expect.stringMatching(/unknown turn_end_reason "made_up"/)]);
  });

  it("retries after a server-side error frame and its 1011 close, then hears the next turn", async () => {
    const call = open({}, 1);
    await server.send({ error: "ASR stream failed", error_code: "INTERNAL_ERROR", code: 500 });
    server.close(1011);
    await server.until(() => server.connections === 2);
    await server.until(() => server.received.filter((f) => f.type === "config").length === 2);
    await server.send(final("Hallo"));
    await server.send(revision("Hallo."));
    await server.until(() => call.events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT));
    await call.close();
    expect(call.errors).toEqual([]);
    expect(call.events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)?.alternatives?.[0]?.text).toBe("Hallo.");
  });

  it("keeps a final that arrived right before a restart close, and reconnects", async () => {
    const call = open({}, 1);
    await server.send(final("Meine Nummer ist 0171"));
    server.close(1012);
    await server.until(() => call.events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT));
    await server.until(() => server.connections === 2);
    await call.close();
    expect(call.errors).toEqual([]);
    expect(call.events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)?.alternatives?.[0]?.text).toBe(
      "Meine Nummer ist 0171",
    );
  });

  it("does not retry a refused request (a 4xx error frame)", async () => {
    const call = open({}, 1);
    await server.send({ error: "Unsupported language", error_code: "VALIDATION_ERROR", code: 422 });
    await call.done;
    call.stop();
    expect(server.connections).toBe(1);
    expect(call.errors).toHaveLength(1);
  });

  it("drops a turn whose revision is empty", async () => {
    const call = open();
    await server.send(final("äh"));
    await server.send(revision(""));
    await server.send(final("Ja"));
    await server.send(revision("Ja."));
    await server.until(() => call.events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT));
    await call.close();
    expect(call.events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT).map((e) => e.alternatives?.[0]?.text)).toEqual([
      "Ja.",
    ]);
  });

  it("fails an attempt whose upgrade never completes instead of waiting forever", async () => {
    // Accepts TCP, never answers the HTTP upgrade: a stalled proxy or an overloaded ingress.
    const stalled = createServer(() => {});
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const port = (stalled.address() as { port: number }).port;
    const call = open({ apiBase: `http://127.0.0.1:${port}` });
    const started = Date.now();
    await call.done;
    call.stop();
    stalled.closeAllConnections();
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(call.errors.map((e) => e.message)).toEqual([expect.stringMatching(/connection failed/)]);
  });

  it("reconnects when the server stops answering pings", async () => {
    await server.stop();
    server = new FakeAsrServer();
    await server.start({ autoPong: false });
    const call = open({ apiBase: `http://127.0.0.1:${server.port}`, pingIntervalMs: 50 }, 1);
    await server.until(() => server.connections === 2);
    await call.close();
  });
});
