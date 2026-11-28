/**
 * Records the unavailable line in every agent language (`src/server/voice/s2s/recorded-line.ts`)
 * with KugelAudio's default voice for it, and writes `src/server/voice/s2s/recorded-lines.ts`.
 * Run it again whenever a `refused` line in `src/llm/localized.ts` changes (a test says so):
 *
 *   KUGELAUDIO_API_KEY=... node --import tsx scripts/render-recorded-lines.ts
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeLogger } from "@livekit/agents";
import { AudioFrame, AudioResampler } from "@livekit/rtc-node";
import { AGENT_LANGUAGES, fallbackReplies } from "../src/llm/localized.js";
import { kugelaudio } from "../src/providers.js";
import { synthesizedFrames } from "../src/server/voice/livekit-host/transfer-audio.js";
import { buildVoiceTts } from "../src/server/voice/providers.js";
import { RECORDED_LINE_SAMPLE_RATE } from "../src/server/voice/s2s/recorded-line.js";

/** One 16-bit sample as a G.711 mu-law byte. */
function linearToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let value = Math.min(Math.abs(sample), 32635) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  return ~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 0x0f)) & 0xff;
}

/** `samples` without the near-silence at either end, keeping 100 ms of it on each side. */
function trimmed(samples: Int16Array): Int16Array {
  const loud = (sample: number) => Math.abs(sample) > 300;
  const pad = RECORDED_LINE_SAMPLE_RATE / 10;
  const first = samples.findIndex(loud);
  const last = samples.findLastIndex(loud);
  if (first < 0) throw new Error("the voice produced only silence");
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad));
}

async function record(language: (typeof AGENT_LANGUAGES)[number], line: string): Promise<Int16Array> {
  const engine = await buildVoiceTts({ descriptor: kugelaudio.tts({ language }) });
  const resampler = new AudioResampler(48_000, RECORDED_LINE_SAMPLE_RATE, 1);
  const parts: Int16Array[] = [];
  const keep = (frames: AudioFrame[]) => frames.forEach((frame) => parts.push(frame.data));
  try {
    for await (const frame of synthesizedFrames(engine, line)) keep(resampler.push(frame));
    keep(resampler.flush());
  } finally {
    await engine.close();
  }
  const samples = new Int16Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((offset, part) => (samples.set(part, offset), offset + part.length), 0);
  return trimmed(samples);
}

initializeLogger({ pretty: false, level: "warn" });
const entries: string[] = [];
for (const language of AGENT_LANGUAGES) {
  const line = fallbackReplies(language).refused;
  const samples = await record(language, line);
  const mulaw = Buffer.from(Uint8Array.from(samples, linearToMulaw)).toString("base64");
  entries.push(`  ${language}: {\n    line: ${JSON.stringify(line)},\n    mulaw:\n      "${mulaw}",\n  },`);
  console.log(`${language}: ${(samples.length / RECORDED_LINE_SAMPLE_RATE).toFixed(1)} s`);
}
const target = join(dirname(fileURLToPath(import.meta.url)), "../src/server/voice/s2s/recorded-lines.ts");
writeFileSync(
  target,
  [
    "// Written by scripts/render-recorded-lines.ts; run it again instead of editing this file.",
    "// The unavailable line in each agent language as base64 G.711 mu-law at 16 kHz (recorded-line.ts).",
    "",
    'import type { AgentLanguage } from "../../../llm/localized.js";',
    "",
    "export const RECORDED_LINES: Readonly<Record<AgentLanguage, { line: string; mulaw: string }>> = {",
    ...entries,
    "};",
    "",
  ].join("\n"),
);
// The TTS client keeps its socket pool open after close; nothing else is left to do.
process.exit(0);
