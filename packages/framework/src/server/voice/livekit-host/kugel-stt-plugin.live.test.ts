// Live check of Kugel Ear speech-to-text against the real service: a German sentence is
// synthesized with Kugel TTS (24 kHz, so the plugin's resampling runs too), streamed through
// KugelSTT at real-time pace, and must come back as one turn with the dictated email address.
//
//   KUGEL_STT_LIVE=1 KUGELAUDIO_API_KEY=... npx vitest run src/server/voice/livekit-host/kugel-stt-plugin.live.test.ts
//
// Skipped without KUGEL_STT_LIVE=1 (CI has no key and must not reach the network).
import { initializeLogger, stt } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { describe, expect, it } from "vitest";
import { kugelaudio } from "../../../providers.js";
import { synthesizeWav } from "../synthesize.js";
import { KugelSTT } from "./kugel-stt-plugin.js";

initializeLogger({ pretty: false, level: "silent" });

const live = process.env.KUGEL_STT_LIVE === "1" && Boolean(process.env.KUGELAUDIO_API_KEY?.trim());

/** PCM16 samples of a canonical 44-byte-header WAV, which is what synthesizeWav writes. */
function wavSamples(wav: Buffer): { samples: Int16Array; rate: number } {
  const rate = wav.readUInt32LE(24);
  const data = wav.subarray(44);
  return { samples: new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2), rate };
}

describe.skipIf(!live)("kugel stt plugin, live", () => {
  it("transcribes a German turn with an email address and ends it on its own", async () => {
    const wav = await synthesizeWav(
      "Meine E-Mail-Adresse ist max punkt mustermann at schmid minus maschinenbau punkt de.",
      kugelaudio.tts({ voice: 1887, language: "de" }),
    );
    const { samples, rate } = wavSamples(wav);
    const plugin = new KugelSTT({
      apiBase: process.env.KUGELAUDIO_API_BASE?.trim() || "https://api.kugelaudio.com",
      apiKey: process.env.KUGELAUDIO_API_KEY!.trim(),
      language: ["de"],
      boostedPhrases: ["Schmid Maschinenbau"],
    });
    const errors: Error[] = [];
    plugin.on("error", (event: { error: Error }) => errors.push(event.error));
    const stream = plugin.stream();
    const finals: { text: string; at: number }[] = [];
    const reading = (async () => {
      for await (const event of stream) {
        if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
          finals.push({ text: event.alternatives?.[0]?.text ?? "", at: performance.now() });
        }
      }
    })();

    // Real-time pace in 20 ms frames, then 3 s of silence: KugelTurn must end the turn by itself.
    const frameSamples = rate / 50;
    const silence = new Int16Array(rate * 3);
    const audio = new Int16Array(samples.length + silence.length);
    audio.set(samples);
    let speechEndedAt = 0;
    for (let offset = 0; offset + frameSamples <= audio.length; offset += frameSamples) {
      stream.pushFrame(new AudioFrame(audio.slice(offset, offset + frameSamples), rate, 1, frameSamples));
      if (offset < samples.length && offset + frameSamples >= samples.length) speechEndedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (finals.length > 0) break;
    }
    stream.endInput();
    await reading;

    expect(errors).toEqual([]);
    expect(finals).toHaveLength(1);
    const text = finals[0]!.text.toLowerCase();
    // The turn's text is the revision, which writes a dictated address as an address (the
    // fast final read "Maxmustermann et Schmid minus Maschinenbau. De" on 2026-10-23). The
    // spelling of the name is recognition quality, not this plugin's contract.
    expect(text).toMatch(/[a-z]+\.[a-z]+@[a-z-]+\.de/);
    // Reported, not asserted: how long after the speech the turn's text was decided.
    console.log(`kugel stt live: ${JSON.stringify(finals[0]!.text)} after ${Math.round(finals[0]!.at - speechEndedAt)} ms`);
  }, 60_000);
});
