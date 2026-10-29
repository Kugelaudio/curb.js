import { describe, expect, it } from "vitest";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import { reportVoiceLatencies } from "./latency.js";

function recordingReporter() {
  const events: Array<{ name: string; payload: Record<string, unknown>; durationMs?: number }> = [];
  const reporter: CallReporter = {
    turn() {},
    event(name, payload, durationMs) {
      events.push({ name, payload, durationMs });
    },
    async finish() {},
    undelivered: 0,
  };
  return { reporter, events };
}

describe("reportVoiceLatencies", () => {
  it("publishes the measured STT, model, TTS and end-to-end stages in milliseconds", () => {
    const { reporter, events } = recordingReporter();

    reportVoiceLatencies(reporter, {
      endOfTurnDelay: 0.18,
      transcriptionDelay: 0.32,
      llmNodeTtft: 0.7414,
      ttsNodeTtfb: 0.2056,
      playbackLatency: 0.08,
      e2eLatency: 1.527,
    });

    expect(events).toEqual([
      { name: "latency", payload: { metric: "turn_detection" }, durationMs: 180 },
      { name: "latency", payload: { metric: "stt" }, durationMs: 320 },
      { name: "latency", payload: { metric: "model" }, durationMs: 741 },
      { name: "latency", payload: { metric: "tts" }, durationMs: 206 },
      { name: "latency", payload: { metric: "first_audio" }, durationMs: 80 },
      { name: "latency", payload: { metric: "end_to_end" }, durationMs: 1527 },
    ]);
  });

  it("omits unavailable measurements instead of reporting invented zeroes", () => {
    const { reporter, events } = recordingReporter();
    reportVoiceLatencies(reporter, { llmNodeTtft: 0.4 });
    expect(events).toEqual([
      { name: "latency", payload: { metric: "model" }, durationMs: 400 },
    ]);
  });

  it("refuses malformed provider measurements rather than poisoning the timeline", () => {
    const { reporter } = recordingReporter();
    expect(() => reportVoiceLatencies(reporter, { ttsNodeTtfb: Number.NaN })).toThrow(
      /ttsNodeTtfb/,
    );
    expect(() => reportVoiceLatencies(reporter, { transcriptionDelay: -1 })).toThrow(
      /transcriptionDelay/,
    );
  });
});
