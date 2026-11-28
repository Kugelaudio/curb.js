/**
 * What the caller of a phone call hears while it is transferred (`blocks/transfer-call/`): the
 * agent's announcement, played to its end before anything is dialed, then a ringback tone
 * until the outcome is known, or, while a warm transfer asks the person first, a hold tone.
 *
 * Both play on an audio track of their own, published by the agent beside its voice as a second
 * microphone, so a participant recording of the agent carries them (`publishTransferTrack`). The
 * agent's voice cannot carry them: the transfer tool runs inside the agent's turn, and LiveKit
 * plays one speech at a time, so a line queued with `session.say` would wait for the very turn
 * that waits for it.
 *
 * Not `BackgroundAudioPlayer` from `@livekit/agents` (1.9.3): its rtc-node `AudioMixer` stops
 * for good once its last stream has run out (`ending` is set when the stream count reaches
 * zero), so a finished announcement or a stopped ringback can leave every later sound on that
 * player silent. One `AudioSource` playing one stream at a time needs no mixer, and its
 * `waitForPlayout` says when the announcement has really played.
 */

import {
  AudioFrame,
  AudioResampler,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  type Room,
} from "@livekit/rtc-node";
import { tts } from "@livekit/agents";
import type { TransferAudio } from "../../../blocks/transfer-call/index.js";
import { logError } from "../../log.js";
import { KugelTTS } from "./kugel-tts-plugin.js";

export const TRANSFER_AUDIO_SAMPLE_RATE = 48_000;
/** The European ringback: 425 Hz, 1 s on, 4 s off (ITU-T E.180 / ETSI ES 201 970). */
export const RINGBACK_FREQUENCY_HZ = 425;
const RINGBACK_ON_MS = 1000;
const RINGBACK_OFF_MS = 4000;
/** -20 dBFS: a tenth of full scale, clearly audible without being loud. */
const RINGBACK_LEVEL = 0.1;
const FRAME_MS = 20;
const FRAME_SAMPLES = (TRANSFER_AUDIO_SAMPLE_RATE * FRAME_MS) / 1000;
/** A 5 ms fade at each end of a tone burst, so it starts and stops without a click. */
const RAMP_SAMPLES = (TRANSFER_AUDIO_SAMPLE_RATE * 5) / 1000;
const TRACK_NAME = "transfer_audio";

/** The ringback as 20 ms mono frames at {@link TRANSFER_AUDIO_SAMPLE_RATE}, without end. */
export function* ringbackFrames(): Generator<AudioFrame> {
  const onFrames = RINGBACK_ON_MS / FRAME_MS;
  const cycleFrames = (RINGBACK_ON_MS + RINGBACK_OFF_MS) / FRAME_MS;
  const toneSamples = onFrames * FRAME_SAMPLES;
  const tone = new Int16Array(toneSamples);
  for (let i = 0; i < toneSamples; i += 1) {
    const ramp = Math.min(1, i / RAMP_SAMPLES, (toneSamples - 1 - i) / RAMP_SAMPLES);
    const phase = (2 * Math.PI * RINGBACK_FREQUENCY_HZ * i) / TRANSFER_AUDIO_SAMPLE_RATE;
    tone[i] = Math.trunc(32767 * RINGBACK_LEVEL * ramp * Math.sin(phase));
  }
  for (;;) {
    for (let frame = 0; frame < cycleFrames; frame += 1) {
      const data =
        frame < onFrames ? tone.slice(frame * FRAME_SAMPLES, (frame + 1) * FRAME_SAMPLES) : new Int16Array(FRAME_SAMPLES);
      yield new AudioFrame(data, TRANSFER_AUDIO_SAMPLE_RATE, 1, FRAME_SAMPLES);
    }
  }
}

/** The hold tone: two soft notes, a falling third, every 4 s. Not a ringback: the caller is
 * waiting for the agent, not for a phone to be answered. */
export const HOLD_FREQUENCIES_HZ = [659.25, 523.25] as const;
const HOLD_NOTE_MS = 240;
const HOLD_GAP_MS = 60;
const HOLD_CYCLE_MS = 4000;
/** -26 dBFS: softer than the ringback, for a wait that can last a minute. */
const HOLD_LEVEL = 0.05;

function toneSamples(frequency: number, ms: number, level: number): Int16Array {
  const count = (TRANSFER_AUDIO_SAMPLE_RATE * ms) / 1000;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    const ramp = Math.min(1, i / RAMP_SAMPLES, (count - 1 - i) / RAMP_SAMPLES);
    const phase = (2 * Math.PI * frequency * i) / TRANSFER_AUDIO_SAMPLE_RATE;
    samples[i] = Math.trunc(32767 * level * ramp * Math.sin(phase));
  }
  return samples;
}

/** The hold tone as 20 ms mono frames at {@link TRANSFER_AUDIO_SAMPLE_RATE}, without end. */
export function* holdFrames(): Generator<AudioFrame> {
  const cycle = new Int16Array((TRANSFER_AUDIO_SAMPLE_RATE * HOLD_CYCLE_MS) / 1000);
  let at = 0;
  for (const frequency of HOLD_FREQUENCIES_HZ) {
    const note = toneSamples(frequency, HOLD_NOTE_MS, HOLD_LEVEL);
    cycle.set(note, at);
    at += note.length + (TRANSFER_AUDIO_SAMPLE_RATE * HOLD_GAP_MS) / 1000;
  }
  for (;;) {
    for (let start = 0; start < cycle.length; start += FRAME_SAMPLES) {
      yield new AudioFrame(cycle.slice(start, start + FRAME_SAMPLES), TRANSFER_AUDIO_SAMPLE_RATE, 1, FRAME_SAMPLES);
    }
  }
}

/** Where the transfer audio goes. rtc-node's `AudioSource` fits. */
export type TransferAudioSink = {
  /** Queue one frame; resolves once the queue has room for the next. */
  captureFrame(frame: AudioFrame): Promise<void>;
  /** Resolves once everything queued has played or stopped: true only when it all played to its
   * end, false when it was cleared or the call went away first. */
  waitForPlayout(): Promise<boolean>;
  /** Drop what is queued, at once. */
  clearQueue(): void;
  close(): Promise<void>;
};

export type TransferAudioOptions = {
  /** Publish the track, once. */
  publish: () => Promise<TransferAudioSink>;
  /** `text` in the call's current voice, as frames at {@link TRANSFER_AUDIO_SAMPLE_RATE}. */
  synthesize: (text: string) => AsyncIterable<AudioFrame>;
  log: (message: string) => void;
};

/** The voice host's side: what a transfer uses, plus the host's own controls. */
export type CallTransferAudio = TransferAudio & {
  /** Publish the track ahead of need, so the caller's side has subscribed before it plays. */
  prepare(): Promise<void>;
  /** Play the hold tone until the returned function is called, or something else plays. */
  hold(): () => void;
  /** Stop whatever plays (the transfer target joined). */
  stop(): void;
  /** The call ended: stop, and play nothing again. */
  close(): Promise<void>;
};

type Playback = { stopped: boolean };

export function createTransferAudio(options: TransferAudioOptions): CallTransferAudio {
  let published: Promise<TransferAudioSink> | null = null;
  let sink: TransferAudioSink | null = null;
  let current: Playback | null = null;
  let closed = false;

  const ensureSink = () => {
    published ??= options.publish().then((ready) => (sink = ready)).catch((error: unknown) => {
      published = null;
      throw error;
    });
    return published;
  };

  const stopPlayback = (playback: Playback) => {
    if (playback.stopped) return;
    playback.stopped = true;
    if (current !== playback) return;
    current = null;
    sink?.clearQueue();
  };

  /** One stream at a time: a new one stops the one before it. */
  const start = (): Playback => {
    if (current) stopPlayback(current);
    const playback: Playback = { stopped: closed };
    if (!closed) current = playback;
    return playback;
  };

  const play = async (playback: Playback, frames: AsyncIterable<AudioFrame> | Iterable<AudioFrame>) => {
    if (playback.stopped) return;
    const target = await ensureSink();
    for await (const frame of frames) {
      if (playback.stopped) return;
      await target.captureFrame(frame);
    }
  };

  /** A tone without end, until stopped. */
  const loop = (what: string, frames: Iterable<AudioFrame>) => {
    const playback = start();
    void play(playback, frames).catch((error: unknown) => {
      // KEEP-JUSTIFIED: a tone that cannot play must not fail the transfer it accompanies;
      // the caller waits in silence, and the cause is in the log.
      options.log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => stopPlayback(playback);
  };

  return {
    prepare: async () => {
      if (closed) return;
      await ensureSink();
    },
    announce: async (text) => {
      const playback = start();
      try {
        await play(playback, options.synthesize(text));
        if (!playback.stopped) await sink?.waitForPlayout();
      } finally {
        if (current === playback) current = null;
      }
    },
    ringback: () => loop("ringback", ringbackFrames()),
    hold: () => loop("hold tone", holdFrames()),
    stop: () => {
      if (current) stopPlayback(current);
    },
    close: async () => {
      closed = true;
      if (current) stopPlayback(current);
      if (!published) return;
      const ready = await published.catch(() => null);
      await ready?.close();
    },
  };
}

/** Publish the transfer audio track on the agent's side of `room`. */
export async function publishTransferTrack(room: Room): Promise<TransferAudioSink> {
  const participant = room.localParticipant;
  if (!participant) throw new Error("the agent is not in the room, so the transfer audio track cannot be published");
  const source = new AudioSource(TRANSFER_AUDIO_SAMPLE_RATE, 1);
  // A microphone, like the agent's voice: LiveKit's participant egress records a participant's
  // camera and microphone tracks and mixes their audio, so a recording of the agent then holds
  // the announcement and ringback too. Published without a source, it would be left out.
  let track: LocalAudioTrack | undefined;
  try {
    track = LocalAudioTrack.createAudioTrack(TRACK_NAME, source);
    await participant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  } catch (error) {
    const cleanup = await Promise.allSettled([track?.close(false), source.close()]);
    for (const result of cleanup) {
      if (result.status === "rejected") logError("voice", `closing unpublished transfer audio: ${String(result.reason)}`);
    }
    throw error;
  }
  return roomTrack(source, () => room.isConnected);
}

/** `source` as the room's track: its playout counts as complete only with no clear since the wait
 * began and the agent still in the room (a cleared `AudioSource` releases its waiter at once). */
export function roomTrack(source: Pick<AudioSource, "captureFrame" | "waitForPlayout" | "clearQueue" | "close">, connected: () => boolean): TransferAudioSink {
  let clears = 0;
  return {
    captureFrame: (frame) => source.captureFrame(frame),
    waitForPlayout: async () => {
      const before = clears;
      await source.waitForPlayout();
      return clears === before && connected();
    },
    clearQueue: () => {
      clears += 1;
      source.clearQueue();
    },
    close: () => source.close(),
  };
}

/** `text` spoken by `engine`, resampled to {@link TRANSFER_AUDIO_SAMPLE_RATE}. */
export async function* synthesizedFrames(engine: tts.TTS, text: string): AsyncGenerator<AudioFrame> {
  const stream = engine instanceof KugelTTS ? engine.synthesizeForPlayback(text) : engine.synthesize(text);
  let resampler: AudioResampler | undefined;
  try {
    for await (const audio of stream) {
      if (audio === tts.SynthesizeStream.END_OF_STREAM) break;
      const frame = audio.frame;
      if (frame.sampleRate === TRANSFER_AUDIO_SAMPLE_RATE) {
        yield frame;
        continue;
      }
      resampler ??= new AudioResampler(frame.sampleRate, TRANSFER_AUDIO_SAMPLE_RATE, frame.channels);
      yield* resampler.push(frame);
    }
    if (stream.error) throw stream.error;
    if (resampler) yield* resampler.flush();
  } finally {
    stream.close();
  }
}
