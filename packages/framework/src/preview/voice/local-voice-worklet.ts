/**
 * The audio worklet of a local call: the microphone's capture processor and the agent's
 * playout processor, both thin shells around `pcm.ts`.
 *
 * The worklet gets this as SOURCE TEXT (`localVoiceWorkletSource`, loaded from a Blob URL):
 * a worklet module is fetched on its own, outside the page's bundle, and a Blob needs no
 * second entry point in the preview's Vite config. So `registerLocalVoiceProcessors` and the
 * `pcm.ts` declarations it uses must stay self-contained; `local-voice-worklet.test.ts` runs
 * the source in an empty context to hold them to that.
 */

import { CaptureFramer, floatToInt16, LinearResampler, PlayoutQueue } from "./pcm.js";

export const CAPTURE_PROCESSOR = "curb-local-capture";
export const PLAYOUT_PROCESSOR = "curb-local-playout";

/** What the capture processor is told when it is created. */
export type CaptureOptions = { outputRate: number; frameSamples: number };

/** The page to the playout processor. */
export type PlayoutCommand = { type: "audio"; samples: Float32Array } | { type: "flush" } | { type: "clear" };

// The AudioWorkletGlobalScope's names, which the DOM library does not declare.
type WorkletProcessor = { readonly port: MessagePort };
declare const AudioWorkletProcessor: { new (): WorkletProcessor; prototype: WorkletProcessor };
declare const registerProcessor: (name: string, processor: new (options: AudioWorkletNodeOptions) => unknown) => void;
declare const sampleRate: number;

/** The `pcm.ts` classes the processors use, handed in: an import would not survive as text. */
export type WorkletLibrary = { CaptureFramer: typeof CaptureFramer; PlayoutQueue: typeof PlayoutQueue };

/** Runs INSIDE the worklet, from source text: see the module comment. */
export function registerLocalVoiceProcessors(lib: WorkletLibrary, captureName: string, playoutName: string): void {
  /** Posts each finished microphone frame's buffer (16-bit PCM) to the page. */
  class CaptureProcessor extends AudioWorkletProcessor {
    private readonly framer: InstanceType<WorkletLibrary["CaptureFramer"]>;

    constructor(options: AudioWorkletNodeOptions) {
      super();
      const { outputRate, frameSamples } = options.processorOptions as CaptureOptions;
      this.framer = new lib.CaptureFramer(sampleRate, outputRate, frameSamples);
    }

    process(inputs: Float32Array[][]): boolean {
      const samples = inputs[0]?.[0];
      if (samples) {
        for (const frame of this.framer.push(samples)) this.port.postMessage(frame.buffer, [frame.buffer]);
      }
      return true;
    }
  }

  /** Plays the agent's voice and posts each segment's end (`PlayoutEvent`) to the page. */
  class PlayoutProcessor extends AudioWorkletProcessor {
    private readonly queue = new lib.PlayoutQueue(sampleRate);

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent<PlayoutCommand>) => {
        const command = event.data;
        if (command.type === "audio") this.queue.enqueue(command.samples);
        else if (command.type === "flush") this.queue.flush();
        else {
          const cleared = this.queue.clear();
          if (cleared) this.port.postMessage(cleared);
        }
      };
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const out = outputs[0]?.[0];
      if (!out) return true;
      const event = this.queue.render(out);
      for (let channel = 1; channel < outputs[0]!.length; channel += 1) outputs[0]![channel]!.set(out);
      if (event) this.port.postMessage(event);
      return true;
    }
  }

  registerProcessor(captureName, CaptureProcessor);
  registerProcessor(playoutName, PlayoutProcessor);
}

/** The worklet module, as text: `pcm.ts`'s declarations, then the processors. Each is bound to
 * its runtime name, because a bundler emits `var X = class { ... }`, whose text is anonymous. */
export function localVoiceWorkletSource(): string {
  const declarations = [floatToInt16, LinearResampler, CaptureFramer, PlayoutQueue].map(
    (declaration) => `const ${declaration.name} = ${String(declaration)};`,
  );
  const lib = `{ CaptureFramer: ${CaptureFramer.name}, PlayoutQueue: ${PlayoutQueue.name} }`;
  const register = `(${String(registerLocalVoiceProcessors)})(${lib}, ${JSON.stringify(CAPTURE_PROCESSOR)}, ${JSON.stringify(PLAYOUT_PROCESSOR)});`;
  return [...declarations, register].join("\n");
}
