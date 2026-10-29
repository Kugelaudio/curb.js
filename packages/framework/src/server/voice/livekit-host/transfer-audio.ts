/**
 * What the caller of a phone call hears while it is transferred (`../../../transfer.tsx`): the
 * agent's announcement, played to its end before anything is dialed, then a ringback tone
 * until the outcome is known.
 *
 * Both play on an audio track of their own, published by the agent beside its voice. The
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
  type Room,
} from "@livekit/rtc-node";
import type { tts } from "@livekit/agents";
import type { TransferAudio } from "../../../transfer.js";

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

/** Where the transfer audio goes. rtc-node's `AudioSource` fits. */
export type TransferAudioSink = {
  /** Queue one frame; resolves once the queue has room for the next. */
  captureFrame(frame: AudioFrame): Promise<void>;
  /** Resolves once everything queued has played. */
  waitForPlayout(): Promise<void>;
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
    published ??= options.publish().then((ready) => (sink = ready));
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
    ringback: () => {
      const playback = start();
      void play(playback, ringbackFrames()).catch((error: unknown) => {
        // KEEP-JUSTIFIED: a ringback that cannot play must not fail the transfer it
        // accompanies; the caller waits in silence, and the cause is in the log.
        options.log(`ringback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return () => stopPlayback(playback);
    },
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
  await participant.publishTrack(LocalAudioTrack.createAudioTrack(TRACK_NAME, source), new TrackPublishOptions());
  return source;
}

/** `text` spoken by `engine`, resampled to {@link TRANSFER_AUDIO_SAMPLE_RATE}. */
export async function* synthesizedFrames(engine: tts.TTS, text: string): AsyncGenerator<AudioFrame> {
  const stream = engine.synthesize(text);
  let resampler: AudioResampler | undefined;
  try {
    for await (const audio of stream) {
      const frame = audio.frame;
      if (frame.sampleRate === TRANSFER_AUDIO_SAMPLE_RATE) {
        yield frame;
        continue;
      }
      resampler ??= new AudioResampler(frame.sampleRate, TRANSFER_AUDIO_SAMPLE_RATE, frame.channels);
      yield* resampler.push(frame);
    }
    if (resampler) yield* resampler.flush();
  } finally {
    stream.close();
  }
}
