import { AudioFrame } from "@livekit/rtc-node";
import { describe, expect, it } from "vitest";
import {
  RINGBACK_FREQUENCY_HZ,
  TRANSFER_AUDIO_SAMPLE_RATE,
  createTransferAudio,
  ringbackFrames,
  type TransferAudioSink,
} from "./transfer-audio.js";

const RATE = TRANSFER_AUDIO_SAMPLE_RATE;

function take<T>(frames: Iterable<T>, count: number): T[] {
  const out: T[] = [];
  for (const frame of frames) {
    out.push(frame);
    if (out.length === count) break;
  }
  return out;
}

const samplesOf = (frames: AudioFrame[]) => frames.flatMap((frame) => [...frame.data]);
const peak = (samples: number[]) => Math.max(...samples.map(Math.abs));

/** A sink that records what reached it; its playout resolves when the test says so. */
function fakeSink() {
  const captured: AudioFrame[] = [];
  const events: string[] = [];
  let played: () => void = () => {};
  let playoutAsked: () => void = () => {};
  /** Resolves when the code under test starts waiting for playout: an event, not a sleep. */
  const waitingForPlayout = new Promise<void>((resolve) => (playoutAsked = resolve));
  const sink: TransferAudioSink = {
    captureFrame: async (frame) => {
      captured.push(frame);
      // Yield like a real source does, so a loop of captures interleaves with the test.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    waitForPlayout: () => {
      events.push("waitForPlayout");
      const playout = new Promise<void>((resolve) => (played = resolve));
      playoutAsked();
      return playout;
    },
    clearQueue: () => events.push("clearQueue"),
    close: async () => void events.push("close"),
  };
  return { sink, captured, events, waitingForPlayout, play: () => played() };
}

function speech(count: number): AudioFrame[] {
  return Array.from({ length: count }, () => new AudioFrame(new Int16Array(960).fill(1000), RATE, 1, 960));
}

async function* frames(list: AudioFrame[]) {
  yield* list;
}

function setup() {
  const fake = fakeSink();
  let published = 0;
  const audio = createTransferAudio({
    publish: async () => {
      published += 1;
      return fake.sink;
    },
    synthesize: () => frames(speech(3)),
    log: () => {},
  });
  return { ...fake, audio, published: () => published };
}

describe("ringbackFrames", () => {
  it("rings the European way: 425 Hz, 1 s on, 4 s off, at about -20 dBFS", () => {
    const cadence = take(ringbackFrames(), 10 * (RATE / 960)); // two whole cycles of 20 ms frames
    const firstCycle = cadence.slice(0, cadence.length / 2);
    const on = samplesOf(firstCycle.slice(0, 50));
    const off = samplesOf(firstCycle.slice(50));
    expect(firstCycle.every((frame) => frame.sampleRate === RATE && frame.channels === 1)).toBe(true);
    expect(off.every((sample) => sample === 0)).toBe(true);
    // -20 dBFS: a tenth of full scale.
    expect(peak(on) / 32767).toBeGreaterThan(0.09);
    expect(peak(on) / 32767).toBeLessThanOrEqual(0.1);
    let crossings = 0;
    for (let i = 1; i < on.length; i += 1) if ((on[i - 1]! < 0) !== (on[i]! < 0)) crossings += 1;
    expect(Math.abs(crossings / 2 - RINGBACK_FREQUENCY_HZ)).toBeLessThanOrEqual(2);
    // The second cycle starts the tone again.
    expect(peak(samplesOf(cadence.slice(250, 300)))).toBeGreaterThan(0);
  });
});

describe("transfer audio", () => {
  it("says the announcement and resolves only once it has played", async () => {
    const { audio, captured, events, waitingForPlayout, play, published } = setup();
    let done = false;
    const announced = audio.announce("One moment, I am connecting you.").then(() => (done = true));
    await waitingForPlayout;
    expect(captured).toHaveLength(3);
    expect(events).toEqual(["waitForPlayout"]);
    // Every pending callback has run; the announcement still waits on its playout.
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    play();
    await announced;
    expect(done).toBe(true);
    expect(published()).toBe(1);
  });

  it("rings until stopped, and the stop silences what is already queued", async () => {
    const { audio, captured, events } = setup();
    const stop = audio.ringback();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured.length).toBeGreaterThan(0);
    expect(peak(samplesOf(captured))).toBeGreaterThan(0);
    stop();
    expect(events).toContain("clearQueue");
    const after = captured.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured.length).toBeLessThanOrEqual(after + 1);
  });

  it("stops the ringback on stop() (hand off) and on close() (call end)", async () => {
    for (const end of ["stop", "close"] as const) {
      const { audio, captured, events } = setup();
      audio.ringback();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await (end === "stop" ? audio.stop() : audio.close());
      const after = captured.length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(captured.length).toBeLessThanOrEqual(after + 1);
      expect(events).toContain("clearQueue");
      if (end === "close") {
        expect(events).toContain("close");
        // After the call ended nothing plays again.
        audio.ringback();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(captured.length).toBeLessThanOrEqual(after + 1);
      }
    }
  });

  it("publishes its track once, on prepare or first use", async () => {
    const { audio, published } = setup();
    await audio.prepare();
    await audio.prepare();
    audio.ringback()();
    expect(published()).toBe(1);
  });
});
