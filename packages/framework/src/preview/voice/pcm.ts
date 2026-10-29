/**
 * The audio arithmetic of a local call (`local-voice-client.ts`): microphone samples to the
 * 16-bit frames the agent hears, and the agent's voice queued for playout with a count of
 * what actually played.
 *
 * Everything here runs inside the call's audio worklet (`local-voice-worklet.ts` sends this
 * source there as text), so it may use nothing but these declarations and the language: no
 * imports, no module state.
 */

/** Float samples in [-1, 1] as 16-bit PCM, clipped at full scale. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

/** 16-bit PCM as float samples in [-1, 1). */
export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i]! / 0x8000;
  return out;
}

/**
 * Streaming linear-interpolation resampler for mono audio, continuous across calls.
 *
 * Linear is enough for a microphone headed to speech recognition. Going down in rate, each
 * output sample is the mean of the input it stands for (a box filter), so content above the
 * new Nyquist frequency is damped instead of folding back into the speech band.
 */
export class LinearResampler {
  private readonly step: number;
  /** The next output's position in `[previous, ...input]`: 1 is the input's first sample. */
  private position = 1;
  private previous = 0;

  constructor(fromRate: number, toRate: number) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error(`cannot resample ${fromRate} Hz to ${toRate} Hz`);
    this.step = fromRate / toRate;
  }

  push(input: Float32Array): Float32Array {
    if (this.step === 1) return input.slice();
    const last = input.length;
    if (last === 0) return new Float32Array(0);
    const at = (index: number): number => (index === 0 ? this.previous : input[index - 1]!);
    const out: number[] = [];
    while (this.position <= last) {
      const base = Math.floor(this.position);
      const fraction = this.position - base;
      let value = fraction === 0 ? at(base) : at(base) + (at(base + 1) - at(base)) * fraction;
      if (this.step > 1) {
        const from = Math.max(0, Math.ceil(this.position - this.step / 2));
        const to = Math.min(last, Math.floor(this.position + this.step / 2));
        let sum = 0;
        for (let index = from; index <= to; index += 1) sum += at(index);
        value = sum / (to - from + 1);
      }
      out.push(value);
      this.position += this.step;
    }
    this.position -= last;
    this.previous = input[last - 1]!;
    return Float32Array.from(out);
  }
}

/** Microphone samples at the device's rate, as whole 16-bit frames at the agent's. */
export class CaptureFramer {
  private readonly resampler: LinearResampler;
  private frame: Int16Array;
  private filled = 0;

  constructor(
    inputRate: number,
    outputRate: number,
    private readonly frameSamples: number,
  ) {
    this.resampler = new LinearResampler(inputRate, outputRate);
    this.frame = new Int16Array(frameSamples);
  }

  /** The frames these samples completed, oldest first. */
  push(samples: Float32Array): Int16Array[] {
    const pcm = floatToInt16(this.resampler.push(samples));
    const done: Int16Array[] = [];
    let read = 0;
    while (read < pcm.length) {
      const take = Math.min(this.frameSamples - this.filled, pcm.length - read);
      this.frame.set(pcm.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === this.frameSamples) {
        done.push(this.frame);
        this.frame = new Int16Array(this.frameSamples);
        this.filled = 0;
      }
    }
    return done;
  }
}

/** A segment of the agent's voice finished: played to its end, or cut by a barge-in. */
export type PlayoutEvent = { type: "drained" | "cleared"; playedMs: number };

/**
 * The agent's voice waiting to play, one segment at a time, counting what has played.
 *
 * A segment opens with its first audio and ends once: `drained` when a flushed segment has
 * played to its end, `cleared` when it is cut. A clear with no open segment (it drained just
 * before) reports nothing, because the server is already settled on that segment.
 */
export class PlayoutQueue {
  private chunks: Float32Array[] = [];
  private offset = 0;
  private played = 0;
  private open = false;
  private flushed = false;

  constructor(private readonly sampleRate: number) {}

  enqueue(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chunks.push(samples);
    this.open = true;
  }

  /** No more audio is coming for this segment. */
  flush(): void {
    if (this.open) this.flushed = true;
  }

  /** Drop what has not played. */
  clear(): PlayoutEvent | null {
    if (!this.open) return null;
    const event: PlayoutEvent = { type: "cleared", playedMs: this.playedMs() };
    this.reset();
    return event;
  }

  /** Fill `out` with the next samples (silence when there are none). */
  render(out: Float32Array): PlayoutEvent | null {
    let written = 0;
    while (written < out.length && this.chunks.length > 0) {
      const chunk = this.chunks[0]!;
      const take = Math.min(out.length - written, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      if (this.offset === chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    out.fill(0, written);
    this.played += written;
    if (!this.flushed || this.chunks.length > 0) return null;
    const event: PlayoutEvent = { type: "drained", playedMs: this.playedMs() };
    this.reset();
    return event;
  }

  private playedMs(): number {
    return (this.played / this.sampleRate) * 1000;
  }

  private reset(): void {
    this.chunks = [];
    this.offset = 0;
    this.played = 0;
    this.open = false;
    this.flushed = false;
  }
}
