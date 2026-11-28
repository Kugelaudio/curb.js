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
 * key go first: the agent's own TTS, then KugelAudio's voice for the agent's language, then the
 * line recorded in the package (`recorded-line.ts`), which needs no key at all. Each one that
 * fails before its first audio hands over to the next.
 */

import type { tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { AgentLanguage } from "../../../llm/localized.js";
import { kugelaudio, type S2sDescriptor, type TtsDescriptor } from "../../../providers.js";
import { s2sKey, SPEECH_KEYS } from "../../../provider-keys.js";
import { synthesizedFrames, type TransferAudioSink } from "../livekit-host/transfer-audio.js";
import { buildVoiceTts } from "../providers.js";
import { recordedFrames, recordedLine } from "./recorded-line.js";

/** How long the line may take to synthesize and play, over every voice tried, before the call ends anyway. */
export const UNAVAILABLE_LINE_MS = 10_000;

type Env = Record<string, string | undefined>;

/** The line in one voice: its audio, and what to close once it is over. */
export type Speech = { frames: AsyncGenerator<AudioFrame>; close: () => Promise<void> };

/** A voice the line can be said in. */
export type FallbackVoice = { name: string; speak: (line: string) => Promise<Speech> };

/** A TTS voice. `open` builds its engine; an `owned` one is closed after the line. */
export function ttsVoice(name: string, open: () => Promise<tts.TTS>, owned: boolean): FallbackVoice {
  return {
    name,
    speak: async (line) => {
      const engine = await open();
      return { frames: synthesizedFrames(engine, line), close: async () => void (owned && (await engine.close())) };
    },
  };
}

/** The line recorded in the package for `language`: no key, no network. Only for its own words. */
export function recordedVoice(language: AgentLanguage): FallbackVoice {
  return {
    name: "the recorded line",
    speak: async (line) => {
      const recorded = recordedLine(language);
      if (recorded.line !== line) throw new Error(`it says ${JSON.stringify(recorded.line)}, not this line`);
      return { frames: recordedFrames(recorded.samples), close: async () => {} };
    },
  };
}

/**
 * The voices to try, in order: the agent's TTS (`given`, a host's engine for it, or one built from
 * `descriptor`), KugelAudio's voice for `language` when the agent's is another provider's and
 * `KUGELAUDIO_API_KEY` is set, then the recorded line. A TTS whose key is the model's comes after
 * the recording: it is the likeliest to be refused for the same reason.
 */
export function fallbackVoices(options: {
  s2s: S2sDescriptor;
  descriptor: TtsDescriptor;
  language: AgentLanguage;
  env: Env;
  given?: tts.TTS;
}): FallbackVoice[] {
  const { s2s, descriptor, env, given } = options;
  const voices: Array<{ voice: FallbackVoice; key: string | undefined }> = [
    {
      voice: ttsVoice(`the agent's ${descriptor.provider} TTS`, async () => given ?? (await buildVoiceTts({ descriptor, env })), !given),
      key: SPEECH_KEYS[descriptor.provider]?.key.read(env),
    },
  ];
  const kugelKey = SPEECH_KEYS.kugelaudio.key.read(env);
  if (descriptor.provider !== "kugelaudio" && kugelKey) {
    const kugel = kugelaudio.tts({ language: options.language });
    voices.push({ voice: ttsVoice("the KugelAudio TTS", () => buildVoiceTts({ descriptor: kugel, env }), true), key: kugelKey });
  }
  const modelKey = s2sKey(s2s).read(env);
  const shared = (voice: { key: string | undefined }) => modelKey !== undefined && voice.key === modelKey;
  const own = (list: typeof voices) => list.map(({ voice }) => voice);
  return [...own(voices.filter((voice) => !shared(voice))), recordedVoice(options.language), ...own(voices.filter(shared))];
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
  const spoken: Speech[] = [];

  /** The line in `voice`, its first frame already out: a voice that fails before it is skipped. */
  const start = async (voice: FallbackVoice) => {
    const speech = await voice.speak(options.line);
    spoken.push(speech);
    const { frames } = speech;
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
    played = await sink.waitForPlayout();
    if (!played) options.log("the line to the caller did not play to its end");
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
    await Promise.allSettled(spoken.map((speech) => speech.close()));
  }
}
