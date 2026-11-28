/**
 * What the caller of a `<Agent s2s>` call hears when its model cannot take the call: the fixed
 * line a refused Curb turn ends on (`fallbackReplies(language).refused`), spoken by a TTS voice,
 * before the call ends.
 *
 * The model is the call's only voice, so a model that refused to start (no key, no payment, no
 * permission) or keeps dropping the call cannot say it. It plays on the agent's own track
 * (`publishTransferTrack`, the page's audio on a local call), beside the model's. LiveKit's
 * speech-to-speech plugins keep no status or body of a refused connection, so every failed start
 * gets this line: "try again later" is right for an outage as well as for a refusal.
 *
 * The voice must not depend on what was refused. A TTS that reads the same key as the model
 * (`openai.tts()` beside `openai.live()`) may be refused for the same reason, so voices on another
 * key go first: the agent's own TTS, then KugelAudio's voice for the agent's language. Each one
 * that fails before its first audio hands over to the next.
 */

import type { tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { kugelaudio, type S2sDescriptor, type TtsDescriptor } from "../../../providers.js";
import { s2sKey, SPEECH_KEYS } from "../../../provider-keys.js";
import { synthesizedFrames, type TransferAudioSink } from "../livekit-host/transfer-audio.js";
import { buildVoiceTts } from "../providers.js";

/** How long the line may take to synthesize and play, over every voice tried, before the call ends anyway. */
export const UNAVAILABLE_LINE_MS = 10_000;

type Env = Record<string, string | undefined>;

/** A TTS voice the line can be said in. `open` builds its engine; `owned` engines are closed after. */
export type FallbackVoice = { name: string; open: () => Promise<tts.TTS>; owned: boolean };

/**
 * The voices to try, in order: the agent's TTS (`given`, a host's engine for it, or one built from
 * `descriptor`), and KugelAudio's voice for `language` when the agent's is another provider's and
 * `KUGELAUDIO_API_KEY` is set. A voice whose key is the model's goes last.
 */
export function fallbackVoices(options: {
  s2s: S2sDescriptor;
  descriptor: TtsDescriptor;
  language: string;
  env: Env;
  given?: tts.TTS;
}): FallbackVoice[] {
  const { s2s, descriptor, env, given } = options;
  const voices: Array<FallbackVoice & { key: string | undefined }> = [
    {
      name: `the agent's ${descriptor.provider} TTS`,
      open: async () => given ?? (await buildVoiceTts({ descriptor, env })),
      owned: !given,
      key: SPEECH_KEYS[descriptor.provider]?.key.read(env),
    },
  ];
  const kugelKey = SPEECH_KEYS.kugelaudio.key.read(env);
  if (descriptor.provider !== "kugelaudio" && kugelKey) {
    const kugel = kugelaudio.tts({ language: options.language });
    voices.push({ name: "the KugelAudio TTS", open: () => buildVoiceTts({ descriptor: kugel, env }), owned: true, key: kugelKey });
  }
  const modelKey = s2sKey(s2s).read(env);
  const shared = (voice: { key: string | undefined }) => modelKey !== undefined && voice.key === modelKey;
  return [...voices.filter((voice) => !shared(voice)), ...voices.filter(shared)].map(({ name, open, owned }) => ({ name, open, owned }));
}

export type UnavailableLineOptions = {
  line: string;
  voices: FallbackVoice[];
  /** Publish the agent's own audio track. */
  publish: () => Promise<TransferAudioSink>;
  log: (message: string) => void;
  timeoutMs?: number;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Say `line` to the caller in the first voice that can. Resolves true once it has played to its
 * end, false otherwise (each failure is logged). Never throws.
 */
export async function sayUnavailableLine(options: UnavailableLineOptions): Promise<boolean> {
  let sink: TransferAudioSink | undefined;
  let stopped = false;
  let played = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const engines: tts.TTS[] = [];

  /** The line in `voice`, its first frame already out: a voice that fails before it is skipped. */
  const start = async (voice: FallbackVoice) => {
    const engine = await voice.open();
    if (voice.owned) engines.push(engine);
    const frames = synthesizedFrames(engine, options.line);
    const first = await frames.next();
    if (first.done) throw new Error("it produced no audio");
    return { first: first.value, frames };
  };
  const play = async (first: AudioFrame, frames: AsyncGenerator<AudioFrame>) => {
    const published = await options.publish();
    // Published after the deadline: the call is over, nothing plays on it.
    if (stopped) return void (await published.close().catch(() => {}));
    sink = published;
    await sink.captureFrame(first);
    for await (const frame of frames) {
      if (stopped) return;
      await sink.captureFrame(frame);
    }
    if (stopped) return;
    await sink.waitForPlayout();
    played = true;
  };
  const say = async (): Promise<boolean> => {
    for (const voice of options.voices) {
      if (stopped) return false;
      let started: Awaited<ReturnType<typeof start>>;
      try {
        started = await start(voice);
      } catch (error) {
        options.log(`${voice.name} could not tell the caller the call cannot go on: ${message(error)}`);
        continue;
      }
      await play(started.first, started.frames);
      return played;
    }
    options.log("no voice could tell the caller the call cannot go on");
    return false;
  };

  try {
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), options.timeoutMs ?? UNAVAILABLE_LINE_MS)));
    const saying = say();
    // KEEP-JUSTIFIED: after the deadline nobody waits for it; its failure is only logged.
    saying.catch(() => {});
    const outcome = await Promise.race([saying, late]);
    if (outcome === "late") options.log("the line to the caller took too long, ending the call");
    return outcome === true;
  } catch (error) {
    options.log(`could not tell the caller the call cannot go on: ${message(error)}`);
    return false;
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (!played) sink?.clearQueue();
    await sink?.close().catch(() => {});
    await Promise.allSettled(engines.map((engine) => engine.close()));
  }
}
