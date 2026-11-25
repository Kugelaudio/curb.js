import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { initializeLogger } from "@livekit/agents";
import { AudioFrame, AudioSource, LocalAudioTrack, type Room } from "@livekit/rtc-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session.js";
import { Agent, AgentSiteRuntime, SystemPrompt } from "./index.js";
import { openai } from "./providers.js";
import { ConnectionController, type AgentHost, type AgentSessionBundle, type VoiceCallHandle, type VoiceHostAdapter } from "./server/connection.js";
import type { ServerMessage } from "./server/protocol.js";
import type { VoiceCallRoom } from "./server/voice/call-room.js";
import { startVoiceAgent } from "./server/voice/livekit-host/host.js";
import { KugelSTT } from "./server/voice/livekit-host/kugel-stt-plugin.js";
import { KugelTTS } from "./server/voice/livekit-host/kugel-tts-plugin.js";
import { createTransferAudio, publishTransferTrack, TRANSFER_AUDIO_SAMPLE_RATE } from "./server/voice/livekit-host/transfer-audio.js";
import { startS2sCall } from "./server/voice/s2s/call.js";

initializeLogger({ pretty: false, level: "warn" });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function makeBundle(s2s = false) {
  const runtime = new AgentSiteRuntime(
    <Agent s2s={s2s ? openai.realtime() : undefined}>
      <SystemPrompt>You help callers.</SystemPrompt>
    </Agent>,
  );
  const session = new AgentSession(runtime, async () => ({ text: "Answer.", toolCalls: [] }));
  return { runtime, session };
}

const agentHost: AgentHost = {
  ids: ["main"],
  initialId: "main",
  create: async () => makeBundle(),
  createRuntime: async () => makeBundle().runtime,
  preview: (id) => ({ id, source: "", preview: {}, skills: [] }),
};

function voiceHandle(token = "voice-token"): VoiceCallHandle {
  return {
    transport: "local",
    url: "ws://localhost/local",
    token,
    room: "room-1",
    sendText: async () => {},
    interrupt: () => {},
    setBundle: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

const isLive = (message: ServerMessage) => message.type === "voice_session" && message.live;

describe("voice on a conversation connection", () => {
  it("closes a cancelled startup and answers a retry while startup is pending", async () => {
    const first = deferred<VoiceCallHandle>();
    const cancelled = voiceHandle();
    const next = voiceHandle("next-token");
    const start = vi.fn<VoiceHostAdapter["start"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(next);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      ...makeBundle(),
      voiceHost: { start },
      agentHost,
    });
    controller.start();

    const starting = controller.handle({ type: "voice_start" });
    await controller.handle({ type: "voice_stop" });
    await controller.handle({ type: "voice_start" });
    const retryResponse = sent.at(-1);
    first.resolve(cancelled);
    await starting;

    expect(cancelled.close).toHaveBeenCalledOnce();
    expect(sent.filter(isLive)).toEqual([]);
    expect(retryResponse).toMatchObject({
      type: "error",
      scope: "voice",
      message: expect.stringMatching(/try again/i),
    });
    await controller.handle({ type: "voice_start" });
    expect(sent.filter(isLive)).toEqual([expect.objectContaining({ token: next.token })]);
  });

  it("answers a retry while a previously live call is closing", async () => {
    const closing = deferred<void>();
    const previous = { ...voiceHandle(), close: vi.fn(() => closing.promise) };
    const next = voiceHandle("next-token");
    const start = vi.fn<VoiceHostAdapter["start"]>()
      .mockResolvedValueOnce(previous)
      .mockResolvedValue(next);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      ...makeBundle(),
      voiceHost: { start },
      agentHost,
    });
    controller.start();
    await controller.handle({ type: "voice_start" });
    expect(sent.filter(isLive)).toHaveLength(1);

    const stopping = controller.handle({ type: "voice_stop" });
    await controller.handle({ type: "voice_start" });
    const response = sent.at(-1);
    const startsDuringClose = start.mock.calls.length;
    closing.resolve();
    await stopping;

    expect(startsDuringClose).toBe(1);
    expect(response).toMatchObject({ type: "error", scope: "voice", message: expect.stringMatching(/try again/i) });
    await controller.handle({ type: "voice_start" });
    expect(sent.filter(isLive).at(-1)).toMatchObject({ token: next.token });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "live"] as const)("closes a %s voice start made during a conversation switch", async (state) => {
    const loaded = deferred<ReturnType<typeof makeBundle>>();
    const started = deferred<VoiceCallHandle>();
    const handle = voiceHandle();
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      ...makeBundle(),
      agentHost: { ...agentHost, create: () => loaded.promise },
      voiceHost: { start: () => started.promise },
      history: {
        list: () => [{ id: 1, agentId: "main", startedAt: 1, messageCount: 1 }],
        messages: () => [{ role: "user", content: "An earlier message", at: 1 }],
        systemPrompt: () => null,
      },
    });
    controller.start();
    const switching = controller.handle({ type: "select_conversation", id: "stored-1" });
    const starting = controller.handle({ type: "voice_start" });
    if (state === "live") {
      started.resolve(handle);
      await starting;
      expect(sent.filter(isLive)).toHaveLength(1);
    }

    loaded.resolve(makeBundle());
    await switching;
    started.resolve(handle);
    await starting;

    expect(handle.close).toHaveBeenCalledOnce();
    expect(sent.filter(isLive)).toHaveLength(state === "live" ? 1 : 0);
    expect(sent).toContainEqual({ type: "voice_session", live: false });
    expect(sent).toContainEqual(expect.objectContaining({ type: "conversations", active: "stored-1" }));
  });

  it("keeps the original conversation and voice call if a turn starts during a switch", async () => {
    const loaded = deferred<AgentSessionBundle>();
    const reply = deferred<{ text: string; toolCalls: [] }>();
    const { runtime } = makeBundle();
    const session = new AgentSession(runtime, () => reply.promise);
    const handle = { ...voiceHandle(), sendText: async (text: string) => { await session.runTurn(text); } };
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: { ...agentHost, create: () => loaded.promise },
      voiceHost: { start: async () => handle },
      history: {
        list: () => [{ id: 1, agentId: "main", startedAt: 1, messageCount: 1 }],
        messages: () => [{ role: "user", content: "An earlier message", at: 1 }],
        systemPrompt: () => null,
      },
    });
    const active = () => sent.filter((message) => message.type === "conversations").at(-1)?.active;
    controller.start();
    const original = active();
    await controller.handle({ type: "voice_start" });
    const switching = controller.handle({ type: "select_conversation", id: "stored-1" });
    const turning = controller.handle({ type: "user_text", text: "A turn while the next conversation loads" });
    try {
      await vi.waitFor(() => expect(session.isRunning).toBe(true));
      loaded.resolve(makeBundle());
      await switching;
      expect(sent.at(-1)).toMatchObject({ type: "error", scope: "protocol" });
      expect(active()).toBe(original);
      expect(handle.close).not.toHaveBeenCalled();
      expect(sent).not.toContainEqual({ type: "voice_session", live: false });
    } finally {
      reply.resolve({ text: "Answer.", toolCalls: [] });
      await turning;
    }
  });

  it("keeps a newer selection and its live call when an older conversation load finishes", async () => {
    const loaded = deferred<AgentSessionBundle>();
    const create = vi.fn<AgentHost["create"]>().mockResolvedValueOnce(makeBundle()).mockReturnValueOnce(loaded.promise);
    const handle = voiceHandle();
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      ...makeBundle(),
      agentHost: { ...agentHost, create },
      voiceHost: { start: async () => handle },
      history: {
        list: () => [{ id: 1, agentId: "main", startedAt: 1, messageCount: 1 }],
        messages: () => [{ role: "user", content: "An earlier message", at: 1 }],
        systemPrompt: () => null,
      },
    });
    const active = () => sent.filter((message) => message.type === "conversations").at(-1)!.active;
    controller.start();
    const first = active();
    await controller.handle({ type: "reset" });
    expect(active()).not.toBe(first);

    const older = controller.handle({ type: "select_conversation", id: "stored-1" });
    await controller.handle({ type: "select_conversation", id: first });
    await controller.handle({ type: "voice_start" });
    expect(active()).toBe(first);
    expect(sent.filter(isLive)).toHaveLength(1);

    loaded.resolve(makeBundle());
    await older;
    expect(active()).toBe(first);
    expect(handle.close).not.toHaveBeenCalled();
    expect(sent).not.toContainEqual({ type: "voice_session", live: false });
  });

  it("binds a delayed voice start to the rebuilt session before sending its ticket", async () => {
    const rebuilt = makeBundle();
    const started = deferred<VoiceCallHandle>();
    const handle = voiceHandle();
    const bundlesAtTicket: Array<AgentSessionBundle | undefined> = [];
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => {
      if (isLive(message)) bundlesAtTicket.push(vi.mocked(handle.setBundle).mock.lastCall?.[0]);
      sent.push(message);
    }, {
      ...makeBundle(),
      agentHost: { ...agentHost, create: async () => rebuilt },
      voiceHost: { start: () => started.promise },
    });
    controller.start();
    await controller.handle({ type: "user_text", text: "first question" });
    const starting = controller.handle({ type: "voice_start" });
    await controller.handle({ type: "rewind", index: 0, rerun: false });
    started.resolve(handle);
    await starting;

    expect(sent.filter(isLive)).toHaveLength(1);
    expect(bundlesAtTicket[0]?.session === rebuilt.session).toBe(true);
  });

  it("keeps the rewound transcript and sidebar count after switching conversations", async () => {
    const sent: ServerMessage[] = [];
    const conversationList = () => sent.filter((message) => message.type === "conversations").at(-1)!;
    const controller = new ConnectionController((message) => sent.push(message), { ...makeBundle(), agentHost });
    controller.start();
    const first = conversationList().active;

    await controller.handle({ type: "user_text", text: "first question" });
    await controller.handle({ type: "user_text", text: "second question" });
    await controller.handle({ type: "rewind", index: 0, rerun: false });
    expect(conversationList().conversations.find((item) => item.id === first)?.messageCount).toBe(0);

    await controller.handle({ type: "reset" });
    expect(conversationList().active).not.toBe(first);
    sent.length = 0;
    await controller.handle({ type: "select_conversation", id: first });

    expect(sent).toContainEqual({ type: "messages", messages: [] });
  });
});

it("releases a failed transfer track and reuses the sink published for a later announcement", async () => {
  const failure = new Error("transient room publish error");
  const publishTrack = vi.fn<(track: LocalAudioTrack) => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  const room = { localParticipant: { publishTrack } } as unknown as Room;
  const trackClose = vi.spyOn(LocalAudioTrack.prototype, "close");
  const sourceClose = vi.spyOn(AudioSource.prototype, "close");
  const capture = vi.spyOn(AudioSource.prototype, "captureFrame").mockResolvedValue(undefined);
  const frame = new AudioFrame(new Int16Array(960), TRANSFER_AUDIO_SAMPLE_RATE, 1, 960);
  const audio = createTransferAudio({
    publish: () => publishTransferTrack(room),
    synthesize: async function* () { yield frame; },
    log: () => {},
  });

  try {
    await expect(audio.prepare()).rejects.toBe(failure);
    await audio.announce("Connecting you now.");
    await audio.announce("Please hold.");
    expect(trackClose.mock.instances).toEqual([publishTrack.mock.calls[0]?.[0]]);
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(publishTrack).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls).toEqual([[frame], [frame]]);
    expect(capture.mock.instances[0]).toBe(capture.mock.instances[1]);
  } finally {
    if (trackClose.mock.calls.length === 0) await publishTrack.mock.calls[0]?.[0].close();
    await audio.close();
  }
});

function emptyRoom(startSession: VoiceCallRoom["startSession"] = async () => {}): VoiceCallRoom {
  return {
    name: "test-room",
    participants: () => [],
    onParticipantConnected: () => {},
    onParticipantDisconnected: () => {},
    onDisconnected: () => {},
    startSession,
    disconnect: async () => {},
    publishTransferTrack: async () => { throw new Error("unused"); },
  };
}

function callOptions(room: VoiceCallRoom, s2s = false) {
  return {
    room,
    roomName: room.name,
    bundle: makeBundle(s2s),
    client: { bind: () => {}, detach: () => {} },
  };
}

function suppliedProviders(bundle: ReturnType<typeof makeBundle>) {
  const sttClose = vi.fn(async () => {});
  const ttsClose = vi.fn(async () => {});
  return {
    sttClose,
    ttsClose,
    providers: {
      stt: { label: "fake-stt", capabilities: { streaming: true, interimResults: true }, close: sttClose } as never,
      tts: { label: "fake-tts", capabilities: { streaming: true }, sampleRate: 24000, numChannels: 1, close: ttsClose } as never,
      descriptors: bundle.runtime.settings.current(),
    },
  };
}

const fakeVad = { label: "fake-vad" } as never;

it("startVoiceAgent.close() cancels an armed caller watchdog timer", async () => {
  vi.useFakeTimers();
  const options = callOptions(emptyRoom());
  const { providers } = suppliedProviders(options.bundle);
  const handle = await startVoiceAgent({ ...options, providers, vad: fakeVad });

  expect(vi.getTimerCount()).toBe(1);
  await handle.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("startS2sCall.close() cancels an armed caller watchdog timer", async () => {
  vi.useFakeTimers();
  const handle = await startS2sCall({
    ...callOptions(emptyRoom(), true),
    env: { OPENAI_API_KEY: "sk-test-unused" },
  });

  expect(vi.getTimerCount()).toBe(1);
  await handle.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("closes both self-built providers and aborts TTS prewarm when room startup fails", async () => {
  const server = createServer();
  const upgrade = deferred<Duplex>();
  let peer: Duplex | undefined;
  server.on("upgrade", (_request, socket) => {
    peer = socket;
    socket.resume();
    upgrade.resolve(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const failure = new Error("room startup failed");
  const sttClose = vi.spyOn(KugelSTT.prototype, "close");
  const ttsClose = vi.spyOn(KugelTTS.prototype, "close");
  const room = emptyRoom(async () => { await upgrade.promise; throw failure; });

  try {
    await expect(startVoiceAgent({
      ...callOptions(room),
      vad: fakeVad,
      env: { KUGELAUDIO_API_KEY: "test-key", KUGELAUDIO_API_BASE: `http://127.0.0.1:${address.port}` },
    })).rejects.toBe(failure);

    expect(sttClose).toHaveBeenCalledOnce();
    expect(ttsClose).toHaveBeenCalledOnce();
    const socket = await upgrade.promise;
    await vi.waitFor(() => expect(socket.readableEnded).toBe(true), { timeout: 1000 });
  } finally {
    peer?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("leaves supplied providers with their owner when room startup fails", async () => {
  const failure = new Error("room startup failed");
  const options = callOptions(emptyRoom(async () => { throw failure; }));
  const { providers, sttClose, ttsClose } = suppliedProviders(options.bundle);

  await expect(startVoiceAgent({ ...options, providers, vad: fakeVad })).rejects.toBe(failure);
  expect(sttClose).not.toHaveBeenCalled();
  expect(ttsClose).not.toHaveBeenCalled();
});
