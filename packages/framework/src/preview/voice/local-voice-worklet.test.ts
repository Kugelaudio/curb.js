import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CAPTURE_PROCESSOR, localVoiceWorkletSource, PLAYOUT_PROCESSOR } from "./local-voice-worklet.js";

type Port = { posted: unknown[]; onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void };
type Processor = { port: Port; process(inputs: Float32Array[][], outputs?: Float32Array[][]): boolean };

/**
 * The worklet's source run in a context holding only what an AudioWorkletGlobalScope has.
 * A reference to anything outside the source (an import, a bundler helper) fails here.
 */
function loadWorklet(rate: number): Map<string, new (options?: unknown) => Processor> {
  const registered = new Map<string, new (options?: unknown) => Processor>();
  class AudioWorkletProcessor {
    readonly port: Port = {
      posted: [],
      onmessage: null,
      postMessage(data) {
        this.posted.push(data);
      },
    };
  }
  runInNewContext(localVoiceWorkletSource(), {
    AudioWorkletProcessor,
    registerProcessor: (name: string, processor: new () => Processor) => registered.set(name, processor),
    sampleRate: rate,
  });
  return registered;
}

describe("localVoiceWorkletSource", () => {
  it("registers both processors from its own text alone", () => {
    expect([...loadWorklet(48_000).keys()]).toEqual([CAPTURE_PROCESSOR, PLAYOUT_PROCESSOR]);
  });

  it("captures the microphone as 20 ms frames of 16 kHz PCM", () => {
    const Capture = loadWorklet(48_000).get(CAPTURE_PROCESSOR)!;
    const capture = new Capture({ processorOptions: { outputRate: 16_000, frameSamples: 320 } });
    for (let quantum = 0; quantum < 8; quantum += 1) capture.process([[new Float32Array(128).fill(0.5)]]);
    // 8 x 128 samples at 48 kHz = 341 at 16 kHz: one whole frame so far.
    expect(capture.port.posted).toHaveLength(1);
    expect(new Int16Array(capture.port.posted[0] as ArrayBuffer)).toHaveLength(320);
  });

  it("plays the agent's voice and reports the segment's end to the page", () => {
    const Playout = loadWorklet(24_000).get(PLAYOUT_PROCESSOR)!;
    const playout = new Playout();
    const command = (data: unknown) => playout.port.onmessage?.({ data });
    command({ type: "audio", samples: new Float32Array(200).fill(0.1) });
    command({ type: "flush" });
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    playout.process([], [[left, right]]);
    expect(right[0]).toBeCloseTo(0.1);
    playout.process([], [[left, right]]);
    expect(playout.port.posted).toEqual([{ type: "drained", playedMs: (200 / 24_000) * 1000 }]);

    command({ type: "audio", samples: new Float32Array(1_000) });
    playout.process([], [[left]]);
    command({ type: "clear" });
    expect(playout.port.posted.at(-1)).toEqual({ type: "cleared", playedMs: (128 / 24_000) * 1000 });
  });
});
