import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { initializeLogger, voice } from "@livekit/agents";
import { AudioFrame, ParticipantKind, RpcError } from "@livekit/rtc-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  isRelayUrl,
  parseRelayRoomMessage,
  RELAY_CALLER_SAMPLE_RATE,
  RELAY_STREAM,
  RELAY_TRANSFER_SAMPLE_RATE,
  RELAY_VOICE_SAMPLE_RATE,
  relaySocketUrl,
  type RelayRoomMessage,
} from "../../../relay-wire.js";
import { TRANSFER_TARGET_IDENTITY_PREFIX } from "../livekit-host/transfer-handoff.js";
import { openRelayCall, type RelayCall } from "./relay-call-room.js";

initializeLogger({ pretty: false, level: "warn" });

const CALLER = { identity: "caller", kind: ParticipantKind.STANDARD };
const PHONE = { identity: "phone", kind: ParticipantKind.SIP, attributes: { "sip.phoneNumber": "+4900" } };

/** A relay on a real loopback socket: what the call sent it, and a way to answer. */
class FakeRelay {
  readonly received: Array<Record<string, unknown>> = [];
  readonly audio: Buffer[] = [];
  socket: WebSocket | null = null;
  request: IncomingMessage | null = null;
  private readonly waiters: Array<() => void> = [];
  private readonly server = createServer();
  private readonly wss = new WebSocketServer({ server: this.server });

  constructor(private readonly onConnect: (relay: FakeRelay) => void = (relay) => relay.join()) {
    this.wss.on("connection", (socket, request) => {
      this.socket = socket;
      this.request = request;
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) this.audio.push(data as Buffer);
        else this.received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        for (const wake of this.waiters.splice(0)) wake();
      });
      this.onConnect(this);
    });
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `curb-relay+ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/calls/s1`;
  }
  join(participants: unknown[] = []): void {
    this.say({ type: "joined", room: "room-1", participants });
  }
  say(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }
  /** Wait until `check` holds on what has arrived. */
  async until(check: () => boolean): Promise<void> {
    while (!check()) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  message(type: string): Promise<Record<string, unknown>> {
    return this.until(() => this.received.some((m) => m.type === type)).then(
      () => this.received.find((m) => m.type === type) as Record<string, unknown>,
    );
  }
  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Enough of an `AgentSession` for the seam: its sinks, its events, and the start. */
class FakeSession extends EventEmitter {
  input: { audio?: voice.AudioInput } = {};
  output: { audio?: voice.AudioOutput; transcription?: unknown } = {};
  _expressiveEverActive = false;
  start = vi.fn(async () => undefined);
}
const startSession = async (call: RelayCall, onTypedText = vi.fn(async () => undefined)) => {
  const session = new FakeSession();
  await call.room.startSession({
    session: session as unknown as voice.AgentSession,
    agent: {} as voice.Agent,
    onTypedText,
  });
  return { session, onTypedText };
};

let relay: FakeRelay;
let call: RelayCall | null = null;
const open = async (options?: Parameters<typeof openRelayCall>[2]) => {
  call = await openRelayCall(await relay.listen(), "secret-token", options);
  return call;
};

beforeEach(() => {
  relay = new FakeRelay();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await call?.disconnect();
  call = null;
  await relay.close();
  vi.restoreAllMocks();
});

describe("relay URLs", () => {
  it("selects the route by scheme and strips it for the socket", () => {
    expect(isRelayUrl("curb-relay+wss://relay/x")).toBe(true);
    expect(isRelayUrl("wss://livekit/x")).toBe(false);
    expect(relaySocketUrl("curb-relay+wss://relay/x")).toBe("wss://relay/x");
    expect(() => relaySocketUrl("wss://livekit/x")).toThrow(/not a media relay URL/);
  });
  it("refuses a message it does not know", () => {
    expect(() => parseRelayRoomMessage('{"type":"nonsense"}')).toThrow(/Unknown media relay message/);
    expect(() => parseRelayRoomMessage('{"type":"playout_done","playedMs":-1}')).toThrow(/Unknown/);
  });
});

describe("openRelayCall", () => {
  it("sends the token as a bearer header, never in the URL", async () => {
    await open();
    expect(relay.request?.headers.authorization).toBe("Bearer secret-token");
    expect(relay.request?.url).toBe("/calls/s1");
  });

  it("names the call and lists who is there from the relay's join", async () => {
    relay = new FakeRelay((r) => r.join([PHONE]));
    const opened = await open();
    expect(opened.name).toBe("room-1");
    expect(opened.room.name).toBe("room-1");
    expect([...opened.room.participants()]).toEqual([PHONE]);
  });

  it("does not lose a frame sent right behind the join", async () => {
    relay = new FakeRelay((r) => {
      r.join();
      r.say({ type: "participant_connected", participant: CALLER });
    });
    const opened = await open();
    await vi.waitFor(() => expect([...opened.room.participants()]).toEqual([CALLER]));
  });

  it("rejects with the relay's reason when it cannot join", async () => {
    relay = new FakeRelay((r) => r.say({ type: "room_lost", reason: "token refused" }));
    await expect(open()).rejects.toThrow(/could not join the room: token refused/);
  });

  it("rejects when the relay closes first, and when it never answers", async () => {
    relay = new FakeRelay((r) => r.socket?.close(4401));
    await expect(open()).rejects.toThrow(/closed the socket \(4401\)/);
    await relay.close();
    relay = new FakeRelay(() => undefined);
    await expect(open({ joinTimeoutMs: 20 })).rejects.toThrow(/did not join the room within 20 ms/);
  });
});

describe("participants and loss", () => {
  it("reports who joins, changes and leaves", async () => {
    const opened = await open();
    const joined: unknown[] = [];
    const left: unknown[] = [];
    opened.room.onParticipantConnected((p) => joined.push(p));
    opened.room.onParticipantDisconnected((p) => left.push(p));
    relay.say({ type: "participant_connected", participant: CALLER });
    await vi.waitFor(() => expect(joined).toEqual([CALLER]));
    relay.say({ type: "participant_updated", participant: { ...CALLER, attributes: { a: "b" } } });
    await vi.waitFor(() => expect([...opened.room.participants()]).toEqual([{ ...CALLER, attributes: { a: "b" } }]));
    relay.say({ type: "participant_disconnected", identity: "caller" });
    await vi.waitFor(() => expect(left).toEqual([{ ...CALLER, attributes: { a: "b" } }]));
    expect([...opened.room.participants()]).toEqual([]);
  });

  it("reports a lost room once, with its reason", async () => {
    const opened = await open();
    const lost: string[] = [];
    opened.room.onDisconnected((reason) => lost.push(reason));
    relay.say({ type: "room_lost", reason: "server shut down" });
    await vi.waitFor(() => expect(lost).toEqual(["server shut down"]));
    relay.socket?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lost).toEqual(["server shut down"]);
  });

  it("reports a relay that crashed as a lost call, not a silent one", async () => {
    const opened = await open();
    const lost: string[] = [];
    opened.room.onDisconnected((reason) => lost.push(reason));
    relay.socket?.terminate();
    await vi.waitFor(() => expect(lost).toEqual([expect.stringContaining("socket closed")]));
  });

  it("ends the call when the relay stops answering heartbeats", async () => {
    relay = new FakeRelay((r) => {
      r.join();
      // A node that vanished: nothing closes and nothing answers.
      r.socket?.pause();
    });
    const opened = await open({ heartbeatMs: 5 });
    const lost: string[] = [];
    opened.room.onDisconnected((reason) => lost.push(reason));
    await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: 2000 });
  });

  it("leaves the room on disconnect and reports it once", async () => {
    const opened = await open();
    const lost: string[] = [];
    opened.room.onDisconnected((reason) => lost.push(reason));
    await opened.disconnect();
    await opened.disconnect();
    await relay.message("leave");
    expect(lost).toEqual(["call ended"]);
  });
});

describe("the session's audio", () => {
  it("hears nobody until the session runs, then the first caller, never a transfer target", async () => {
    relay = new FakeRelay((r) => r.join([{ identity: `${TRANSFER_TARGET_IDENTITY_PREFIX}1`, kind: ParticipantKind.SIP }, CALLER]));
    const opened = await open();
    expect(relay.received.filter((m) => m.type === "listen")).toEqual([]);
    await startSession(opened);
    expect(await relay.message("listen")).toEqual({ type: "listen", identity: "caller" });
  });

  it("links a caller who returns under a new identity", async () => {
    relay = new FakeRelay((r) => r.join([CALLER]));
    const opened = await open();
    await startSession(opened);
    await relay.until(() => relay.received.some((m) => m.type === "listen" && m.identity === "caller"));
    relay.say({ type: "participant_disconnected", identity: "caller" });
    relay.say({ type: "participant_connected", participant: { identity: "caller-2", kind: ParticipantKind.STANDARD } });
    await relay.until(() => relay.received.some((m) => m.type === "listen" && m.identity === "caller-2"));
  });

  it("feeds the caller's PCM to the session's input", async () => {
    const opened = await open();
    const { session } = await startSession(opened);
    const reader = session.input.audio?.stream.getReader();
    const samples = new Int16Array(160).fill(7);
    relay.socket?.send(Buffer.concat([Buffer.of(RELAY_STREAM.main), Buffer.from(samples.buffer)]), { binary: true });
    const { value } = (await reader?.read()) as { value: AudioFrame };
    expect(value.sampleRate).toBe(RELAY_CALLER_SAMPLE_RATE);
    expect(value.data[0]).toBe(7);
    reader?.releaseLock();
  });

  it("logs a frame on an unknown stream and keeps the call", async () => {
    const opened = await open();
    const lost: string[] = [];
    opened.room.onDisconnected((reason) => lost.push(reason));
    await startSession(opened);
    relay.socket?.send(Buffer.of(9, 0, 0), { binary: true });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(lost).toEqual([]);
  });

  it("sends the voice tagged, starts the session, and forwards flush, clear and playout", async () => {
    const opened = await open();
    const { session } = await startSession(opened);
    expect(session.start).toHaveBeenCalledOnce();
    const output = session.output.audio as voice.AudioOutput;
    const samples = RELAY_VOICE_SAMPLE_RATE / 50;
    await output.captureFrame(new AudioFrame(new Int16Array(samples), RELAY_VOICE_SAMPLE_RATE, 1, samples));
    await relay.until(() => relay.audio.length === 1);
    expect(relay.audio[0]?.[0]).toBe(RELAY_STREAM.main);
    expect(relay.audio[0]?.byteLength).toBe(1 + samples * 2);

    const finished = new Promise<{ interrupted: boolean }>((resolve) =>
      output.once(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, resolve),
    );
    output.flush();
    // The synchronizer holds its flush until the text side is done, so the interrupt path is
    // what reaches the relay here at once.
    output.clearBuffer();
    await relay.message("audio_clear");
    relay.say({ type: "playout_cleared", playedMs: 5 });
    await expect(finished).resolves.toMatchObject({ interrupted: true });
  });

  it("forwards the caller's words and the agent's state", async () => {
    const { session } = await startSession(await open());
    session.emit(voice.AgentSessionEventTypes.UserInputTranscribed, { transcript: "hallo", isFinal: true });
    session.emit(voice.AgentSessionEventTypes.AgentStateChanged, { newState: "thinking" });
    expect(await relay.message("caller_text")).toEqual({ type: "caller_text", id: "room-1-0", text: "hallo", final: true });
    expect(await relay.message("agent_state")).toEqual({ type: "agent_state", state: "thinking" });
  });

  it("answers typed text as a caller turn", async () => {
    const { session, onTypedText } = await startSession(await open());
    relay.say({ type: "typed_text", text: "hi there" });
    await vi.waitFor(() => expect(onTypedText).toHaveBeenCalledWith(session, "hi there"));
  });
});

describe("publishTransferTrack", () => {
  const openSink = async () => {
    const opened = await open();
    const sink = opened.room.publishTransferTrack();
    await relay.message("transfer_open");
    return sink;
  };
  const frame = (ms: number) => {
    const samples = (RELAY_TRANSFER_SAMPLE_RATE * ms) / 1000;
    return new AudioFrame(new Int16Array(samples), RELAY_TRANSFER_SAMPLE_RATE, 1, samples);
  };

  it("rejects with the relay's reason when it cannot publish", async () => {
    const sink = openSink();
    await relay.message("transfer_open").catch(() => undefined);
    relay.say({ type: "transfer_failed", message: "no permission" });
    await expect(sink).rejects.toThrow(/no permission/);
  });

  it("sends audio on its own stream, waits for playout, clears and closes", async () => {
    const pending = openSink();
    await relay.until(() => relay.received.some((m) => m.type === "transfer_open"));
    relay.say({ type: "transfer_ready" });
    const sink = await pending;
    await sink.captureFrame(frame(20));
    await relay.until(() => relay.audio.length === 1);
    expect(relay.audio[0]?.[0]).toBe(RELAY_STREAM.transfer);

    let played = false;
    const playout = sink.waitForPlayout().then(() => (played = true));
    const wait = await relay.message("transfer_wait");
    expect(played).toBe(false);
    relay.say({ type: "transfer_played", id: wait.id as number });
    await playout;

    sink.clearQueue();
    await relay.message("transfer_clear");
    await sink.close();
    await relay.message("transfer_close");
  });

  it("paces an endless stream to real time past its lead", async () => {
    const pending = openSink();
    await relay.until(() => relay.received.some((m) => m.type === "transfer_open"));
    relay.say({ type: "transfer_ready" });
    const sink = await pending;
    const started = Date.now();
    for (let i = 0; i < 15; i += 1) await sink.captureFrame(frame(20));
    // 300 ms of audio with a 200 ms lead: about 100 ms of waiting, however fast the loop runs.
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("refuses a frame at the wrong rate rather than playing it at the wrong speed", async () => {
    const pending = openSink();
    await relay.until(() => relay.received.some((m) => m.type === "transfer_open"));
    relay.say({ type: "transfer_ready" });
    const sink = await pending;
    await expect(sink.captureFrame(new AudioFrame(new Int16Array(240), 24_000, 1, 240))).rejects.toThrow(/48000 Hz mono/);
  });

  it("does not hang a transfer on a relay that died", async () => {
    const pending = openSink();
    await relay.until(() => relay.received.some((m) => m.type === "transfer_open"));
    relay.say({ type: "transfer_ready" });
    const sink = await pending;
    const playout = sink.waitForPlayout();
    await relay.message("transfer_wait");
    relay.socket?.terminate();
    await expect(playout).resolves.toBeUndefined();
  });
});

describe("messaging", () => {
  const request = (id: number, method: string): RelayRoomMessage => ({
    type: "rpc_request", id, method, payload: "{}", callerIdentity: "caller", responseTimeoutMs: 1000,
  });

  it("registers RPC methods with the relay and answers them", async () => {
    const opened = await open();
    const handler = vi.fn(async () => "answer");
    opened.messaging.localParticipant?.registerRpcMethod("curb.message", handler);
    await relay.message("rpc_register");
    relay.say(request(1, "curb.message"));
    expect(await relay.message("rpc_response")).toEqual({ type: "rpc_response", id: 1, payload: "answer" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ method: "curb.message", payload: "{}", callerIdentity: "caller" }));
    opened.messaging.localParticipant?.unregisterRpcMethod("curb.message");
    expect(await relay.message("rpc_unregister")).toEqual({ type: "rpc_unregister", method: "curb.message" });
  });

  it("carries an RpcError's code, and hides any other error's text", async () => {
    const opened = await open();
    opened.messaging.localParticipant?.registerRpcMethod("refused", async () => {
      throw new RpcError(1600, "invalid_payload", "details");
    });
    opened.messaging.localParticipant?.registerRpcMethod("broken", async () => {
      throw new Error("internal detail");
    });
    relay.say(request(1, "refused"));
    relay.say(request(2, "broken"));
    await relay.until(() => relay.received.filter((m) => m.type === "rpc_response").length === 2);
    const responses = relay.received.filter((m) => m.type === "rpc_response");
    expect(responses.find((m) => m.id === 1)?.error).toEqual({ code: 1600, message: "invalid_payload", data: "details" });
    const hidden = responses.find((m) => m.id === 2)?.error as { message: string };
    expect(hidden.message).not.toContain("internal detail");
  });

  it("refuses a method nobody registered", async () => {
    await open();
    relay.say(request(3, "never"));
    const response = await relay.message("rpc_response");
    expect((response.error as { code: number }).code).toBe(RpcError.builtIn("UNSUPPORTED_METHOD").code);
  });

  it("sends text on a topic and reports the relay's answer", async () => {
    const opened = await open();
    const sent = opened.messaging.localParticipant?.sendText("hello", { topic: "curb.message" });
    const message = await relay.message("send_text");
    expect(message).toMatchObject({ topic: "curb.message", text: "hello" });
    relay.say({ type: "send_text_result", id: message.id as number });
    await expect(sent).resolves.toBeUndefined();

    const failing = opened.messaging.localParticipant?.sendText("again", { topic: "t" });
    await relay.until(() => relay.received.filter((m) => m.type === "send_text").length === 2);
    const second = relay.received.filter((m) => m.type === "send_text")[1] as Record<string, unknown>;
    relay.say({ type: "send_text_result", id: second.id as number, error: "room full" });
    await expect(failing).rejects.toThrow("room full");
  });

  it("says who could receive a message from the room's participants", async () => {
    relay = new FakeRelay((r) => r.join([PHONE]));
    const opened = await open();
    expect([...opened.messaging.remoteParticipants.values()]).toEqual([{ kind: ParticipantKind.SIP }]);
  });
});
