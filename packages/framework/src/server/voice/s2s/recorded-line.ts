/**
 * The recorded unavailable line: `fallbackReplies(language).refused` in each agent language,
 * spoken once ahead of time and shipped in the package (`recorded-lines.ts`), so a call whose
 * every TTS shares the refused key still tells the caller. It needs no key and dials nothing.
 *
 * Stored as G.711 mu-law at 16 kHz: about 100 KB a line, decoded by one line of arithmetic.
 * (At 8 kHz, KugelAudio STT misheard the Portuguese line.) `scripts/render-recorded-lines.ts`
 * records them.
 */

import { AudioFrame, AudioResampler } from "@livekit/rtc-node";
import type { AgentLanguage } from "../../../llm/localized.js";
import { TRANSFER_AUDIO_SAMPLE_RATE } from "../livekit-host/transfer-audio.js";
import { RECORDED_LINES } from "./recorded-lines.js";

export const RECORDED_LINE_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = RECORDED_LINE_SAMPLE_RATE / 50;

/** One G.711 mu-law byte as a 16-bit sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const magnitude = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 0x07)) - 0x84;
  return u & 0x80 ? -magnitude : magnitude;
}

/** The recorded line in `language`, and the words it says. */
export function recordedLine(language: AgentLanguage): { line: string; samples: Int16Array } {
  const { line, mulaw } = RECORDED_LINES[language];
  const bytes = Buffer.from(mulaw, "base64");
  const samples = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) samples[i] = mulawToLinear(bytes[i]!);
  return { line, samples };
}

/** `samples` as 20 ms frames at {@link TRANSFER_AUDIO_SAMPLE_RATE}, the rate every call track takes. */
export async function* recordedFrames(samples: Int16Array): AsyncGenerator<AudioFrame> {
  const resampler = new AudioResampler(RECORDED_LINE_SAMPLE_RATE, TRANSFER_AUDIO_SAMPLE_RATE, 1);
  for (let start = 0; start < samples.length; start += FRAME_SAMPLES) {
    const data = samples.slice(start, start + FRAME_SAMPLES);
    yield* resampler.push(new AudioFrame(data, RECORDED_LINE_SAMPLE_RATE, 1, data.length));
  }
  yield* resampler.flush();
}
