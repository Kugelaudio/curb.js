import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { initializeLogger, voice } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket, WebSocketServer } from "ws";
import { LOCAL_VOICE_INPUT_SAMPLE_RATE, LOCAL_VOICE_OUTPUT_SAMPLE_RATE } from "../../../local-voice-wire.js";
import { createLocalVoiceCall, LocalVoiceCalls, PageAudioInput, PageAudioOutput } from "./local-call-room.js";
import { createSynchronizer } from "./synchronizer.js";

/** 20 ms of silence at the agent's output rate. */
function outputFrame(): AudioFrame {
  const samples = LOCAL_VOICE_OUTPUT_SAMPLE_RATE / 50;
  return new AudioFrame(new Int16Array(samples), LOCAL_VOICE_OUTPUT_SAMPLE_RATE, 1, samples);
}

function finished(output: PageAudioOutput): Promise<{ playbackPosition: number; interrupted: boolean }> {
  return new Promise((resolve) => output.once(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, resolve));
}

/** The page's end of the socket: what the agent sent it, and a way to answer. */
class FakePage extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Buffer | Record<string, unknown>> = [];
  closedWith: number | null = null;
  send(data: Buffer | string): void {
    this.sent.push(typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : data);
  }
  close(code: number): void {
    this.closedWith = code;
    this.readyState = 3;
    this.emit("close");
  }
  say(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

// The voice host initializes the agents logger at import; these tests construct sinks alone.
initializeLogger({ pretty: false, level: "warn" });

afterEach(() => vi.restoreAllMocks());

/** What the server logged at error level, colour codes and all. */
function captureErrors(): ReturnType<typeof vi.spyOn> {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("PageAudioOutput", () => {
  it("sends the voice as PCM and finishes a segment when the page says it played", async () => {
    const sent: unknown[] = [];
    const output = new PageAudioOutput((message) => sent.push(message));
    await output.captureFrame(outputFrame());
    await output.captureFrame(outputFrame());
    expect(sent).toHaveLength(2);
    expect(Buffer.isBuffer(sent[0])).toBe(true);
    expect((sent[0] as Buffer).byteLength).toBe((LOCAL_VOICE_OUTPUT_SAMPLE_RATE / 50) * 2);

    const done = finished(output);
    output.flush();
    expect(sent.at(-1)).toEqual({ type: "audio_flush" });
    output.report({ type: "playout_done", playedMs: 40 });
    await expect(done).resolves.toEqual({ playbackPosition: 0.04, interrupted: false });
  });

  it("cuts a barge-in at what the page reports played, not at what was pushed", async () => {
    const sent: unknown[] = [];
    const output = new PageAudioOutput((message) => sent.push(message));
    for (let i = 0; i < 10; i += 1) await output.captureFrame(outputFrame());

    const done = finished(output);
    output.clearBuffer();
    expect(sent.at(-1)).toEqual({ type: "audio_clear" });
    // The flush after a clear does not open a second wait on the same segment.
    output.flush();
    expect(sent.filter((message) => (message as { type?: string }).type === "audio_flush")).toHaveLength(0);
    output.report({ type: "playout_cleared", playedMs: 60 });
    await expect(done).resolves.toEqual({ playbackPosition: 0.06, interrupted: true });
  });

  it("falls back to the clock, loudly, when the page leaves mid-segment", async () => {
    const errors = captureErrors();
    const output = new PageAudioOutput(() => undefined);
    await output.captureFrame(outputFrame());
    const done = finished(output);
    output.flush();
    output.pageLeft();
    const event = await done;
    expect(event.playbackPosition).toBeLessThanOrEqual(0.02);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("the page left"));
  });

  it("refuses audio at a rate the page does not play", async () => {
    const output = new PageAudioOutput(() => undefined);
    const wrong = new AudioFrame(new Int16Array(480), 48_000, 1, 480);
    await expect(output.captureFrame(wrong)).rejects.toThrow("24000 Hz mono");
  });
});

describe("PageAudioInput", () => {
  it("turns the page's PCM frames into 16 kHz audio frames for the session", async () => {
    const input = new PageAudioInput();
    const reader = input.stream.getReader();
    input.push(Buffer.from(new Int16Array([1, -2, 3, -4]).buffer));
    const { value } = await reader.read();
    expect(value?.sampleRate).toBe(LOCAL_VOICE_INPUT_SAMPLE_RATE);
    expect(Array.from(value?.data ?? [])).toEqual([1, -2, 3, -4]);
    expect(() => input.push(Buffer.alloc(3))).toThrow("not 16-bit PCM");
    reader.releaseLock();
    await input.close();
  });
});

describe("createLocalVoiceCall", () => {
  it("has the page as its one participant while its socket is attached", () => {
    captureErrors();
    const call = createLocalVoiceCall("local-test");
    const joined = vi.fn();
    const left = vi.fn();
    call.room.onParticipantConnected(joined);
    call.room.onParticipantDisconnected(left);
    expect([...call.room.participants()]).toEqual([]);

    const page = new FakePage();
    call.attach(page as unknown as WebSocket);
    expect([...call.room.participants()]).toEqual([{ identity: "browser" }]);
    expect(joined).toHaveBeenCalledTimes(1);

    page.close(1000);
    expect([...call.room.participants()]).toEqual([]);
    expect(left).toHaveBeenCalledTimes(1);
  });

  it("refuses a phone line's transfer track, which a local call cannot have", async () => {
    await expect(createLocalVoiceCall().room.publishTransferTrack()).rejects.toThrow("no phone line");
  });

  it("logs a malformed frame from the page instead of ending the call", () => {
    const errors = captureErrors();
    const call = createLocalVoiceCall("local-bad");
    const page = new FakePage();
    call.attach(page as unknown as WebSocket);
    page.say({ type: "nonsense" });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Unknown local voice message"));
    expect(page.closedWith).toBeNull();
  });
});

describe("LocalVoiceCalls.upgrade", () => {
  it("hands a socket only to the call whose token it carries", () => {
    const calls = new LocalVoiceCalls();
    const call = calls.open();
    const handleUpgrade = vi.fn();
    const wss = { handleUpgrade } as unknown as WebSocketServer;
    const socket = { end: vi.fn() } as unknown as Duplex & { end: ReturnType<typeof vi.fn> };
    const request = (query: string) => ({ url: `/voice/local?${query}` }) as IncomingMessage;

    calls.upgrade(wss, request(`call=${call.id}&token=wrong`), socket, Buffer.alloc(0));
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(socket.end).toHaveBeenCalledWith(expect.stringContaining("404"));

    calls.upgrade(wss, request(`call=${call.id}&token=${call.token}`), socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(1);

    calls.close(call.id);
    calls.upgrade(wss, request(`call=${call.id}&token=${call.token}`), socket, Buffer.alloc(0));
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe("createSynchronizer", () => {
  it("loads LiveKit's transcription synchronizer from the installed @livekit/agents", async () => {
    const output = new PageAudioOutput(() => undefined);
    const text = { captureText: vi.fn(async () => undefined), flush: vi.fn(), onAttached: vi.fn(), onDetached: vi.fn() };
    const synchronizer = await createSynchronizer(output, text);
    expect(synchronizer.audioOutput).toBeInstanceOf(voice.AudioOutput);
    expect(synchronizer.textOutput).toBeDefined();
    await synchronizer.close();
  });
});
