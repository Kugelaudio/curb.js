import { EventEmitter } from "node:events";
import { initializeLogger, type voice } from "@livekit/agents";
import { expect, it, vi } from "vitest";
import { runHostedDirectJoin } from "./bundler/direct-join.js";
import * as management from "./hosted/management-server.js";
import { createLocalVoiceCall } from "./server/voice/local-host/local-call-room.js";
import * as transcription from "./server/voice/local-host/synchronizer.js";

initializeLogger({ pretty: false, level: "warn" });

it("closes the transcription synchronizer when a local voice call disconnects", async () => {
  const call = createLocalVoiceCall("local-leak");
  const fakeSession = Object.assign(new EventEmitter(), {
    input: {} as Record<string, unknown>,
    output: {} as Record<string, unknown>,
    start: async () => {},
  });
  const fakeAgent = {} as voice.Agent;
  await call.room.startSession({
    session: fakeSession as unknown as voice.AgentSession,
    agent: fakeAgent,
    onTypedText: async () => {},
  });

  // Grab the synchronizer's audio output wrapper (holds .synchronizer: TranscriptionSynchronizer)
  const synchAudio = fakeSession.output.audio as { synchronizer?: { closed: boolean; close(): Promise<void> } };
  const synchronizer = synchAudio?.synchronizer;
  expect(synchronizer).toBeDefined();

  try {
    await call.room.disconnect();
    expect(synchronizer?.closed).toBe(true);
  } finally {
    if (synchronizer && !synchronizer.closed) await synchronizer.close();
  }
});

it("disconnects after transcription synchronizer initialization fails", async () => {
  const failure = new Error("could not initialize transcription");
  const create = vi.spyOn(transcription, "createSynchronizer").mockRejectedValueOnce(failure);
  const call = createLocalVoiceCall("test-call");
  const onDisconnected = vi.fn();
  call.room.onDisconnected(onDisconnected);
  try {
    await expect(call.room.startSession({
      session: {} as voice.AgentSession,
      agent: {} as voice.Agent,
      onTypedText: async () => {},
    })).rejects.toBe(failure);
    await expect(call.room.disconnect()).resolves.toBeUndefined();
    expect(onDisconnected).toHaveBeenCalledOnce();
  } finally {
    create.mockRestore();
  }
});

it("stops serving its events address when the call cannot join the room", async () => {
  vi.stubEnv("CURB_MANAGEMENT_ADDR", "127.0.0.1:0");
  vi.stubEnv("CURB_MANAGEMENT_TOKEN", "test-management-token");
  vi.stubEnv("LIVEKIT_API_KEY", undefined);
  vi.stubEnv("LIVEKIT_API_SECRET", undefined);
  const startServer = vi.spyOn(management, "startManagementServer");
  try {
    await expect(
      runHostedDirectJoin({ url: "ws://127.0.0.1:1", token: "fake-token", sessionId: "test-call" }),
    ).rejects.toThrow(/could not join the realtime room/);

    const server = await startServer.mock.results[0]?.value;
    expect(server).toBeTruthy();
    const status = await fetch(`http://${server!.address}/health`).then(
      (response) => response.status,
      () => null,
    );
    expect(status).toBeNull();
  } finally {
    const server = await startServer.mock.results[0]?.value;
    await server?.close();
    startServer.mockRestore();
    vi.unstubAllEnvs();
  }
});
