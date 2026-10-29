import type { CallReporter } from "../../../hosted/call-reporter.js";

/** The per-message timings agents-js attaches to committed conversation items, in seconds. */
export type VoiceLatencyMetrics = {
  endOfTurnDelay?: number;
  transcriptionDelay?: number;
  llmNodeTtft?: number;
  ttsNodeTtfb?: number;
  playbackLatency?: number;
  e2eLatency?: number;
};

const STAGES = [
  ["endOfTurnDelay", "turn_detection"],
  ["transcriptionDelay", "stt"],
  ["llmNodeTtft", "model"],
  ["ttsNodeTtfb", "tts"],
  ["playbackLatency", "first_audio"],
  ["e2eLatency", "end_to_end"],
] as const satisfies ReadonlyArray<readonly [keyof VoiceLatencyMetrics, string]>;

/**
 * Publish one measured event per stage.
 *
 * The runtime reports seconds; the hosted journal and platform timeline use integer
 * milliseconds. Missing means unmeasured and stays missing. An invalid number is a runtime
 * defect, not a zero-latency stage, so it is rejected for the host to log explicitly.
 */
export function reportVoiceLatencies(
  reporter: CallReporter | undefined,
  metrics: VoiceLatencyMetrics,
): void {
  if (!reporter) return;
  for (const [field, metric] of STAGES) {
    const seconds = metrics[field];
    if (seconds === undefined) continue;
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`voice latency ${field} must be a finite non-negative number`);
    }
    reporter.event("latency", { metric }, Math.round(seconds * 1000));
  }
}
