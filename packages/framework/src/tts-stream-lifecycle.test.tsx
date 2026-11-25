import { once } from "node:events";
import { createServer } from "node:http";
import { APIError, initializeLogger } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { KugelTtsSession } from "./server/voice/kugel-tts.js";
import { KugelTTS } from "./server/voice/livekit-host/kugel-tts-plugin.js";

initializeLogger({ pretty: false, level: "warn" });

describe("TTS stream lifecycle", () => {
  it.each(["stream", "synthesize"] as const)("reports a LiveKit APIError from %s", async (method) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ error: "Voice 99999 not found" }));
      });
    });

    const tts = new KugelTTS({
      apiBase: `http://127.0.0.1:${port}`,
      apiKey: "test-key",
      voiceId: 99999,
      modelId: "kugel-3.5",
      sampleRate: 24000,
      language: "en",
    });

    const onError = vi.fn();
    tts.on("error", onError);
    try {
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
      {
        apiBase: `http://127.0.0.1:${port}`,
        apiKey: "test-key",
        voiceId: 1072,
        modelId: "kugel-3.5",
        sampleRate: 24000,
        language: "en",
      },
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
  it("closes a socket that opens after the session is closed", async () => {
    let releaseUpgrade!: () => void;
    const upgradePaused = new Promise<void>((r) => {
      releaseUpgrade = r;
    });
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const opened: ServerSocket[] = [];
    let serverSocketClosed = false;

    server.on("upgrade", (req, socket, head) => {
      void upgradePaused.then(() => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          opened.push(ws);
          ws.on("close", () => {
            serverSocketClosed = true;
          });
        });
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const session = new KugelTtsSession(
      {
        apiBase: `http://127.0.0.1:${port}`,
        apiKey: "test-key",
        voiceId: 1072,
        modelId: "kugel-3.5",
        sampleRate: 24000,
        language: "en",
      },
      { onAudio: () => {}, onError: () => {} },
    );

    try {
      const upgrading = once(server, "upgrade");
      const connectPromise = session.connect();
      await upgrading;
      // Close session BEFORE WS upgrade completes
      await session.close();
      // Now let the upgrade finish
      releaseUpgrade();
      await connectPromise;
      await new Promise((r) => setTimeout(r, 50));

      const serverSocket = opened[0];
      expect({
        serverSocketOpened: serverSocket !== undefined,
        serverSocketClosed,
        serverSocketReadyState: serverSocket?.readyState,
      }).toEqual({
        serverSocketOpened: true,
        serverSocketClosed: true,
        serverSocketReadyState: 3, // CLOSED
      });
    } finally {
      for (const socket of opened) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
