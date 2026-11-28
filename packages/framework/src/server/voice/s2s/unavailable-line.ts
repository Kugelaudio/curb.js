/**
 * What the caller of a `<Agent s2s>` call hears when its model cannot take the call: the fixed
 * line a refused Curb turn ends on (`fallbackReplies(language).refused`), in the agent's own TTS
 * voice, before the call ends.
 *
 * The model is the call's only voice, so a model that refused to start (no key, no payment, no
 * permission) or keeps dropping the call cannot say it. It plays on the track the transfer
 * announcement uses (`transfer-audio.ts`), beside the model's. LiveKit's speech-to-speech
 * plugins keep no status or body of a refused connection, so every failed start gets this
 * line: "try again later" is right for an outage as well as for a refusal.
 */

import type { AudioFrame } from "@livekit/rtc-node";
import type { TransferAudioSink } from "../livekit-host/transfer-audio.js";

/** How long the line may take to synthesize and play before the call ends anyway. */
export const UNAVAILABLE_LINE_MS = 10_000;

export type UnavailableLineOptions = {
  line: string;
  /** Publish the agent's own audio track. */
  publish: () => Promise<TransferAudioSink>;
  /** `text` in the agent's voice. */
  synthesize: (text: string) => AsyncIterable<AudioFrame>;
  log: (message: string) => void;
  timeoutMs?: number;
};

/** Say `line` to the caller. Never throws: a line that cannot play is logged, and the call ends. */
export async function sayUnavailableLine(options: UnavailableLineOptions): Promise<void> {
  let sink: TransferAudioSink | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const play = async () => {
    const published = await options.publish();
    // Published after the deadline: the call is over, nothing plays on it.
    if (stopped) return void (await published.close().catch(() => {}));
    sink = published;
    for await (const frame of options.synthesize(options.line)) {
      if (stopped) return;
      await sink.captureFrame(frame);
    }
    if (!stopped) await sink.waitForPlayout();
  };
  try {
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), options.timeoutMs ?? UNAVAILABLE_LINE_MS)));
    const playing = play();
    // KEEP-JUSTIFIED: after the deadline nobody waits for it; its failure is only logged.
    playing.catch(() => {});
    if ((await Promise.race([playing, late])) === "late") options.log("the line to the caller took too long, ending the call");
  } catch (error) {
    options.log(`could not tell the caller the call cannot go on: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    stopped = true;
    clearTimeout(timer);
    sink?.clearQueue();
    await sink?.close().catch(() => {});
  }
}
