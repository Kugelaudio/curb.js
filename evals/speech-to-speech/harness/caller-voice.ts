/**
 * The simulated caller's voice: a caller line as 16-bit mono PCM at 16 kHz, the rate a local
 * call's microphone sends. Spoken by KugelAudio TTS (`KUGELAUDIO_API_KEY`), in a voice of the
 * line's language, so the model under test hears speech, not text.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const CALLER_SAMPLE_RATE = 16_000;

/** A voice per language; any KugelAudio voice id works (`npx curb voices`). */
const CALLER_VOICES: Readonly<Record<string, number>> = { de: 1887, en: 1072 };

const cache = new Map<string, Promise<Buffer>>();

/** How a person reads a number out on the phone: an order, card, customer or phone number digit by
 * digit ("4 8 2 1 3"), a year as a year. TTS alone reads "48213" as "forty-eight thousand ...". */
export function spokenDigits(text: string): string {
  return text.replace(/\d[\d ]*\d|\d/g, (run) => {
    const digits = run.replace(/ /g, "");
    const year = /^(19|20)\d\d$/.test(digits);
    return digits.length < 4 || year ? run : digits.split("").join(" ");
  });
}

export function callerSpeech(text: string, language: string, digits = true): Promise<Buffer> {
  const key = `${language}|${digits}|${text}`;
  let speech = cache.get(key);
  if (!speech) {
    speech = synthesize(digits ? spokenDigits(text) : text, language);
    cache.set(key, speech);
    speech.catch(() => cache.delete(key));
  }
  return speech;
}

async function synthesize(text: string, language: string): Promise<Buffer> {
  const apiKey = process.env.KUGELAUDIO_API_KEY;
  if (!apiKey) throw new Error("The caller's voice needs KUGELAUDIO_API_KEY.");
  const base = (process.env.KUGELAUDIO_API_BASE ?? "https://api.kugelaudio.com").replace(/^http/, "ws").replace(/\/$/, "");
  const socket = new WebSocket(`${base}/ws/tts/multi?api_key=${encodeURIComponent(apiKey)}`);
  const contextId = randomUUID().replaceAll("-", "").slice(0, 12);
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`caller TTS timed out for "${text.slice(0, 40)}"`)), 30_000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          context_id: contextId,
          text,
          model_id: "kugel-3.5",
          sample_rate: CALLER_SAMPLE_RATE,
          language,
          normalize: true,
          voice_settings: { voice_id: CALLER_VOICES[language] ?? CALLER_VOICES.en },
        }),
      );
      socket.send(JSON.stringify({ context_id: contextId, text: "", flush: true }));
      socket.send(JSON.stringify({ close_context: true, context_id: contextId }));
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { audio?: string; context_closed?: boolean; error?: string };
      if (frame.error) return fail(new Error(`caller TTS: ${frame.error}`));
      if (frame.audio) chunks.push(Buffer.from(frame.audio, "base64"));
      if (frame.context_closed) {
        clearTimeout(timer);
        socket.close();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.on("error", (error) => fail(error));
  });
}
