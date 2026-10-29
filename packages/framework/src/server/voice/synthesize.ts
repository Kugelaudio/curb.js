import type { TtsDescriptor } from "../../providers.js";
import { buildVoiceTts, VoiceProviderError } from "./providers.js";
import { pcmToWav } from "./wav.js";

const SYNTHESIS_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 4_000;

/**
 * One-shot text → WAV through the given TTS provider (the same LiveKit
 * plugin instances the voice session uses). Powers the preview's per-message
 * Play/WAV buttons. Throws VoiceProviderError with an agent-readable message
 * on misconfiguration.
 */
export async function synthesizeWav(
  text: string,
  descriptor: TtsDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const trimmed = text.trim();
  if (!trimmed) throw new VoiceProviderError("Nothing to synthesize: the message is empty.");
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new VoiceProviderError(
      `Message too long to synthesize (${trimmed.length} chars, limit ${MAX_TEXT_LENGTH}).`,
    );
  }

  const tts = await buildVoiceTts({ descriptor, env });

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new VoiceProviderError("TTS timed out after 30s.")),
      SYNTHESIS_TIMEOUT_MS,
    );
    timer.unref?.();
  });

  const collect = (async () => {
    const chunks: Buffer[] = [];
    const stream = tts.synthesize(trimmed);
    for await (const audio of stream) {
      const frame = audio.frame;
      chunks.push(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length * 2));
    }
    return Buffer.concat(chunks);
  })();

  try {
    const pcm = await Promise.race([collect, timeout]);
    return pcmToWav(pcm, tts.sampleRate);
  } finally {
    await tts.close().catch(() => {
      // KEEP-JUSTIFIED: synthesis already finished or failed; closing a dead
      // socket has no caller left to inform.
    });
  }
}
