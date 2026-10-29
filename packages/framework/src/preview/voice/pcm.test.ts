import { describe, expect, it } from "vitest";
import { CaptureFramer, floatToInt16, int16ToFloat, LinearResampler, PlayoutQueue } from "./pcm.js";

/** `seconds` of a sine at `hz`, sampled at `rate`. */
function sine(hz: number, rate: number, seconds: number): Float32Array {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
}

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}

describe("floatToInt16 / int16ToFloat", () => {
  it("round-trips speech-range samples and clips past full scale", () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 0.5, -0.5, 1.5, -1.5])))).toEqual([0, 16383, -16384, 32767, -32768]);
    expect(Array.from(int16ToFloat(Int16Array.from([0, -32768, 16384])))).toEqual([0, -1, 0.5]);
  });
});

describe("LinearResampler", () => {
  it("keeps the rate's sample count across chunks of any size", () => {
    const resampler = new LinearResampler(48_000, 16_000);
    const input = sine(440, 48_000, 1);
    let produced = 0;
    for (let start = 0; start < input.length; start += 128) produced += resampler.push(input.subarray(start, start + 128)).length;
    expect(produced).toBe(16_000);

    const up = new LinearResampler(16_000, 24_000);
    // The last output waits for the next chunk's first sample to interpolate toward.
    expect(up.push(sine(440, 16_000, 0.5)).length).toBe(11_999);
  });

  it("keeps a speech-band tone and damps one above the new Nyquist", () => {
    const kept = new LinearResampler(48_000, 16_000).push(sine(1_000, 48_000, 0.2));
    expect(rms(kept)).toBeGreaterThan(0.3);
    const damped = new LinearResampler(48_000, 16_000).push(sine(15_000, 48_000, 0.2));
    expect(rms(damped)).toBeLessThan(0.15);
  });

  it("refuses a rate that is not positive", () => {
    expect(() => new LinearResampler(48_000, 0)).toThrow("cannot resample 48000 Hz to 0 Hz");
  });
});

describe("CaptureFramer", () => {
  it("emits whole frames at the output rate and holds the remainder", () => {
    const framer = new CaptureFramer(48_000, 16_000, 320);
    expect(framer.push(new Float32Array(900))).toHaveLength(0); // 300 samples at 16 kHz
    const frames = framer.push(new Float32Array(1_100)); // 300 + 366 = 666
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.length === 320)).toBe(true);
    expect(frames[0]).not.toBe(frames[1]);
  });
});

describe("PlayoutQueue", () => {
  const RATE = 24_000;

  it("drains a flushed segment and says how long it played", () => {
    const queue = new PlayoutQueue(RATE);
    queue.enqueue(new Float32Array(240).fill(0.25));
    queue.flush();
    const out = new Float32Array(128);
    expect(queue.render(out)).toBeNull();
    expect(out[0]).toBe(0.25);
    expect(queue.render(out)).toEqual({ type: "drained", playedMs: 10 });
    expect(out[127]).toBe(0); // the tail past the segment is silence
    expect(queue.render(out)).toBeNull();
  });

  it("does not drain a segment that has not been flushed, however long it is quiet", () => {
    const queue = new PlayoutQueue(RATE);
    queue.enqueue(new Float32Array(64));
    expect(queue.render(new Float32Array(128))).toBeNull();
    expect(queue.render(new Float32Array(128))).toBeNull();
    queue.flush();
    expect(queue.render(new Float32Array(128))).toEqual({ type: "drained", playedMs: (64 / RATE) * 1000 });
  });

  it("cuts a segment at what played, and reports nothing for a clear after it drained", () => {
    const queue = new PlayoutQueue(RATE);
    queue.enqueue(new Float32Array(2_400));
    queue.render(new Float32Array(480));
    expect(queue.clear()).toEqual({ type: "cleared", playedMs: 20 });
    const out = new Float32Array(128).fill(1);
    expect(queue.render(out)).toBeNull();
    expect(out.every((value) => value === 0)).toBe(true);
    expect(queue.clear()).toBeNull();
  });
});
