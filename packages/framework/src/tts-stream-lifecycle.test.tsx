import { once } from "node:events";
import { createServer } from "node:http";
import { APIError, initializeLogger } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { KugelTtsSession } from "./server/voice/kugel-tts.js";
import { KugelTTS } from "./server/voice/livekit-host/kugel-tts-plugin.js";
import { createTransferAudio, synthesizedFrames } from "./server/voice/livekit-host/transfer-audio.js";

initializeLogger({ pretty: false, level: "warn" });

function config(port: number) {
  return {
    apiBase: `http://127.0.0.1:${port}`,
    apiKey: "test-key",
    voiceId: 1072,
    modelId: "kugel-3.5",
    sampleRate: 24000,
    language: "en",
  };
}

describe("TTS stream lifecycle", () => {
  it.each(["stream", "synthesize", "transfer announcement"] as const)("reports a LiveKit APIError from %s", async (method) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ error: "Voice 99999 not found" }));
      });
    });

    const tts = new KugelTTS({ ...config(port), voiceId: 99999 });

    const onError = vi.fn();
    tts.on("error", onError);
    try {
      if (method === "transfer announcement") {
        const sink = {
          captureFrame: vi.fn(async () => {}),
          waitForPlayout: vi.fn(async () => {}),
          clearQueue: vi.fn(),
          close: vi.fn(async () => {}),
        };
        const transfer = createTransferAudio({
          publish: async () => sink,
          synthesize: (text) => synthesizedFrames(tts, text),
          log: () => {},
        });
        try {
          await expect(transfer.announce("Please hold.")).rejects.toThrow(APIError);
          expect(sink.captureFrame).not.toHaveBeenCalled();
          expect(sink.waitForPlayout).not.toHaveBeenCalled();
        } finally {
          await transfer.close();
        }
        return;
      }

      const streaming = method === "stream" ? tts.stream() : undefined;
      streaming?.pushText("Hello caller.");
      streaming?.endInput();
      const stream = streaming ?? tts.synthesize("Hello caller.");

      const events = [];
      for await (const event of stream) events.push(event);
      expect(events).toEqual([]);
      expect(stream.error).toBeInstanceOf(APIError);
      expect(stream.error?.message).toContain("Voice 99999 not found");
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        error: stream.error,
        recoverable: false,
      }));
    } finally {
      await tts.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("routes overlapping input and completion to the right turn", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;
    const inbound: Array<Record<string, unknown>> = [];
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        inbound.push(frame);
        if (typeof frame.text === "string" && frame.text.length > 0) {
          socket.send(JSON.stringify({ context_id: frame.context_id, audio: "QUJD" }));
        }
        if (frame.close_context) {
          socket.send(JSON.stringify({ context_id: frame.context_id, context_closed: true }));
        }
      });
    });

    const audioByTurn: Record<number, number> = {};
    const doneTurns: number[] = [];
    const session = new KugelTtsSession(
      config(port),
      {
        onAudio: (_b64, turnId) => {
          audioByTurn[turnId] = (audioByTurn[turnId] ?? 0) + 1;
        },
        onError: () => {},
        onDone: (turnId) => doneTurns.push(turnId),
      },
    );

    try {
      await session.streamInput(1, "Turn one. ");
      await session.streamInput(2, "Turn two.");
      await session.endInput(1);
      await session.endInput(2);

      await new Promise((r) => setTimeout(r, 100));

      const distinctContexts = new Set(inbound.map((f) => f.context_id));
      expect({
        distinctContexts: distinctContexts.size,
        audioByTurn,
        doneTurns,
      }).toEqual({
        distinctContexts: 2,
        audioByTurn: { 1: 1, 2: 1 },
        doneTurns: [1, 2],
      });
    } finally {
      await session.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("does not send text when one-shot synthesis is closed immediately", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    const texts: string[] = [];
    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.text) texts.push(frame.text);
        if (frame.close_context) {
          socket.send(JSON.stringify({ context_id: frame.context_id, context_closed: true }));
        }
      });
    });
    const engine = new KugelTTS(config((wss.address() as { port: number }).port));
    try {
      engine.synthesize("Skip this.").close();
      for await (const _ of engine.synthesize("Play this.")) {
        // Drain the second request so the server has seen all input.
      }
      expect(texts).toEqual(["Play this."]);
    } finally {
      await engine.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it.each([
    {
      name: "preserves a turn waiting to replay when another turn's upgrade fails",
      failReplay: false,
    },
    {
      name: "reports a failed replay upgrade only for the replayed turn",
      failReplay: true,
    },
  ])("$name", async ({ failReplay }) => {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    let upgrades = 0;
    let refusalClosed!: () => void;
    const refused = new Promise<void>((resolve) => (refusalClosed = resolve));

    server.on("upgrade", (req, socket, head) => {
      const attempt = ++upgrades;
      if (attempt === 2) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data) => {
          const frame = JSON.parse(data.toString());
          if (attempt === 1 && frame.voice_settings) {
            ws.once("close", refusalClosed);
            ws.send(JSON.stringify({ error: "Concurrent generation limit reached (1)" }));
            ws.close(4029);
          } else if (attempt > 2 && frame.close_context) {
            ws.send(JSON.stringify({ context_id: frame.context_id, audio: "QUJD" }));
            ws.send(JSON.stringify({ context_id: frame.context_id, context_closed: true }));
          }
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const onError = vi.fn();
    const onAudio = vi.fn();
    const onDone = vi.fn();
    const session = new KugelTtsSession(
      config((server.address() as { port: number }).port),
      { onError, onAudio, onDone },
      { firstDelayMs: failReplay ? 10 : 300, budgetMs: 1000 },
    );
    try {
      await session.streamInput(1, "First turn.");
      await session.endInput(1);
      await refused;
      if (failReplay) {
        await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("Unexpected server response: 503"),
          1,
        ));
        expect(onDone).not.toHaveBeenCalled();
        return;
      }
      await expect(session.streamInput(2, "Second turn.")).rejects.toThrow("Unexpected server response: 503");
      await vi.waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith(1));
      expect(onAudio).toHaveBeenCalledExactlyOnceWith("QUJD", 1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await session.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["prewarm", "queued synthesis"] as const)("cancels a pending upgrade during %s", async (operation) => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const onError = vi.fn();
    const session = new KugelTtsSession(
      config((server.address() as { port: number }).port),
      { onAudio: vi.fn(), onError },
    );
    const upgrading = once(server, "upgrade");
    const pending = operation === "prewarm" ? session.connect() : session.streamInput(1, "Queued text.");
    // Shutdown can reject a prewarm that is still waiting for the socket.
    void pending.catch(() => {});
    const [, socket] = await upgrading;
    let peerDisconnected = false;
    socket.on("end", () => (peerDisconnected = true));
    socket.resume();
    try {
      let sessionClosed = false;
      const closing = session.close().then(() => (sessionClosed = true));
      await vi.waitFor(() => {
        expect(sessionClosed).toBe(true);
        expect(peerDisconnected).toBe(true);
      });
      await closing;
      await Promise.allSettled([pending]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await session.close();
    }
  });
});
