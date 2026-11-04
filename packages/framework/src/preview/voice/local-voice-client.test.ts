import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceTicket } from "./call-state.js";
import type { CallMedia, CallMediaEvents } from "./local-voice-media.js";
import { LocalVoiceClient, localVoiceSocketUrl, NO_ECHO_CANCELLATION, type LocalCallIO } from "./local-voice-client.js";
import { VoiceClient } from "./voice-client.js";
import { LivekitVoiceClient } from "./livekit-voice-client.js";
import { CallRecordings } from "./call-recordings.js";

const TICKET: VoiceTicket = {
  transport: "local",
  url: "/voice/local?call=local-1&token=t1",
  token: "t1",
  room: "local-1",
  conversationId: "conv-1",
};

/** The dev server's end of the call socket. */
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: Array<ArrayBuffer | Record<string, unknown>> = [];
  closedWith: number | null = null;
  constructor(readonly url: string) {
    super();
  }
  send(data: ArrayBuffer | string): void {
    this.sent.push(typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : data);
  }
  close(code = 1005): void {
    this.closedWith = code;
    this.serverCloses(code);
  }
  accept(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  serverCloses(code: number, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
  say(message: Record<string, unknown> | ArrayBuffer): void {
    const data = message instanceof ArrayBuffer ? message : JSON.stringify(message);
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

type FakeMedia = CallMedia & { played: Int16Array[]; flushes: number; clears: number; closed: boolean };

function fakeTrack(): MediaStreamTrack {
  return { enabled: true } as MediaStreamTrack;
}

/** A call's IO with the browser taken out: what it opened, and the events it was given. */
function fakeIO(options: { echoCancelled?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  let events: CallMediaEvents | null = null;
  let media: FakeMedia | null = null;
  const io: LocalCallIO = {
    openMedia: async (_deviceId, given) => {
      events = given;
      media = {
        microphone: fakeTrack(),
        agentVoice: fakeTrack(),
        echoCancelled: options.echoCancelled ?? true,
        played: [],
        flushes: 0,
        clears: 0,
        closed: false,
        play(pcm) {
          this.played.push(pcm);
        },
        flush() {
          this.flushes += 1;
        },
        clear() {
          this.clears += 1;
        },
        switchMicrophone: async () => fakeTrack(),
        async close() {
          this.closed = true;
        },
      };
      return media;
    },
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.accept());
      return socket as unknown as WebSocket;
    },
    listMicrophones: async () => [],
    pageUrl: () => "http://127.0.0.1:4000/?resume=abc",
  };
  return {
    io,
    sockets,
    events: () => events!,
    media: () => media!,
  };
}

/** Recordings need MediaRecorder; these tests are about the call, so it records nothing. */
function noRecordings(): CallRecordings {
  const recordings = new CallRecordings();
  vi.spyOn(recordings, "start").mockResolvedValue(undefined);
  return recordings;
}

afterEach(() => vi.restoreAllMocks());

describe("localVoiceSocketUrl", () => {
  it("puts the ticket's path on the page's own host, as ws or wss", () => {
    expect(localVoiceSocketUrl(TICKET.url, "http://127.0.0.1:4000/x")).toBe(
      "ws://127.0.0.1:4000/voice/local?call=local-1&token=t1",
    );
    expect(localVoiceSocketUrl(TICKET.url, "https://ws-1.preview.example.com/")).toMatch(/^wss:\/\/ws-1\./);
  });
});

describe("LocalVoiceClient", () => {
  it("says so when the voice plays without echo cancellation, and the call still connects", async () => {
    const client = new LocalVoiceClient(noRecordings(), fakeIO({ echoCancelled: false }).io);
    await client.start(TICKET);
    expect(client.getState().connected).toBe(true);
    expect(client.getState().error).toBe(NO_ECHO_CANCELLATION);
  });

  it("shows no warning on a call with echo cancellation", async () => {
    const client = new LocalVoiceClient(noRecordings(), fakeIO().io);
    await client.start(TICKET);
    expect(client.getState().error).toBeNull();
  });

  async function connected() {
    const fake = fakeIO();
    const client = new LocalVoiceClient(noRecordings(), fake.io);
    await client.start(TICKET);
    return { client, ...fake, socket: fake.sockets[0]! };
  }

  it("joins on the ticket's socket and sends the microphone until muted", async () => {
    const { client, socket, events } = await connected();
    expect(socket.url).toBe("ws://127.0.0.1:4000/voice/local?call=local-1&token=t1");
    expect(socket.binaryType).toBe("arraybuffer");
    expect(client.getState()).toMatchObject({ connected: true, connecting: false, listening: true, error: null });

    const frame = new Int16Array(320).buffer;
    events().microphoneFrame(frame);
    expect(socket.sent).toEqual([frame]);

    await client.setMicMuted(true);
    events().microphoneFrame(frame);
    expect(socket.sent).toHaveLength(1);
  });

  it("plays the agent's voice and tells the server how much of each segment played", async () => {
    const { socket, media, events } = await connected();
    socket.say(new Int16Array([1, 2, 3]).buffer);
    expect(Array.from(media().played[0]!)).toEqual([1, 2, 3]);
    socket.say({ type: "audio_flush" });
    socket.say({ type: "audio_clear" });
    expect([media().flushes, media().clears]).toEqual([1, 1]);

    events().playout({ type: "drained", playedMs: 1200 });
    events().playout({ type: "cleared", playedMs: 300 });
    expect(socket.sent).toEqual([
      { type: "playout_done", playedMs: 1200 },
      { type: "playout_cleared", playedMs: 300 },
    ]);
  });

  it("inks the reply as it is heard and arms pending on the caller's final", async () => {
    const { client, socket } = await connected();
    socket.say({ type: "caller_text", id: "local-1-0", text: "hello", final: false });
    expect(client.getState().callerSpeech.map((segment) => segment.text)).toEqual(["hello"]);
    expect(client.getState().replyPlayback.phase).toBe("idle");
    socket.say({ type: "caller_text", id: "local-1-0", text: "hello there", final: true });
    expect(client.getState()).toMatchObject({ processing: true, replyPlayback: { phase: "pending" } });

    socket.say({ type: "agent_state", state: "speaking" });
    socket.say({ type: "agent_text", text: "Hi, " });
    socket.say({ type: "agent_text", text: "how can I help?" });
    expect(client.getState()).toMatchObject({
      speaking: true,
      processing: false,
      replyPlayback: { phase: "speaking", heard: "Hi, how can I help?" },
    });
    socket.say({ type: "agent_text_end" });
    expect(client.getState().replyPlayback).toEqual({ phase: "spoken" });
    socket.say({ type: "agent_text", text: "Next" });
    expect(client.getState().replyPlayback).toEqual({ phase: "speaking", heard: "Next" });
  });

  it("says so when the server sends a frame it does not understand", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, socket } = await connected();
    socket.say({ type: "nonsense" });
    expect(client.getState().error).toMatch("does not understand");
    expect(errors).toHaveBeenCalled();
    expect(client.getState().connected).toBe(true);
  });

  it("ends quietly when the server hangs up, and says why when it was taken over", async () => {
    const { client, socket, media } = await connected();
    socket.serverCloses(1000, "call ended");
    expect(client.getState()).toMatchObject({ connected: false, listening: false, error: null });
    expect(media().closed).toBe(true);

    await client.start({ ...TICKET, token: "t2" });
    const fake = client as unknown as { call: { socket: FakeSocket } };
    fake.call.socket.serverCloses(4409, "another page took this call");
    expect(client.getState().error).toBe("The voice call ended: another page took this call");
  });

  it("reports a refused socket as a failed join and releases the microphone", async () => {
    const fake = fakeIO();
    fake.io.openSocket = (url) => {
      const socket = new FakeSocket(url);
      queueMicrotask(() => socket.serverCloses(1006));
      return socket as unknown as WebSocket;
    };
    const client = new LocalVoiceClient(noRecordings(), fake.io);
    await client.start(TICKET);
    expect(client.getState()).toMatchObject({ connected: false, connecting: false });
    expect(client.getState().error).toMatch("Could not join the voice session: the dev server refused the call socket (1006");
    expect(fake.media().closed).toBe(true);
  });

  it("closes its socket when the page stops the call", async () => {
    const { client, socket } = await connected();
    client.stop();
    expect(socket.closedWith).toBe(1000);
    expect(client.getState().connected).toBe(false);
  });
});

describe("VoiceClient", () => {
  it("hands each call to its transport's client and shows that client's state", async () => {
    const recordings = new CallRecordings();
    const livekit = new LivekitVoiceClient(recordings);
    const local = new LocalVoiceClient(recordings, fakeIO().io);
    const startLivekit = vi.spyOn(livekit, "start").mockResolvedValue(undefined);
    const startLocal = vi.spyOn(local, "start").mockResolvedValue(undefined);
    const stopLocal = vi.spyOn(local, "stop");
    const client = new VoiceClient({ livekit, local });

    await client.start(TICKET);
    expect(startLocal).toHaveBeenCalledWith(TICKET);
    expect(client.getState()).toBe(local.getState());

    const room = { ...TICKET, transport: "livekit" as const, url: "wss://lk.example.com", token: "lk" };
    await client.start(room);
    expect(stopLocal).toHaveBeenCalled();
    expect(startLivekit).toHaveBeenCalledWith(room);
    expect(client.getState()).toBe(livekit.getState());
  });

  it("sets a mute chosen before the call on both clients, whichever takes it", async () => {
    const recordings = new CallRecordings();
    const livekit = new LivekitVoiceClient(recordings);
    const local = new LocalVoiceClient(recordings, fakeIO().io);
    const client = new VoiceClient({ livekit, local });
    await client.setMicMuted(true);
    expect([livekit.getState().micMuted, local.getState().micMuted]).toEqual([true, true]);
  });
});
