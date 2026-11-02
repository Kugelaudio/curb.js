/**
 * LiveKit's transcription synchronizer, for a call without a room.
 *
 * It paces the reply's text to its audio playback, using the word timestamps Kugel TTS
 * reports: the preview's "inked as spoken" cursor and the barge-in cut both depend on it.
 * `RoomIO` builds one for every LiveKit call, so a local call needs the same one to behave
 * like production. `@livekit/agents` (1.9.3) does not export it, and its exports map hides
 * the module, so it is loaded from the package's own `dist/`: the same module instance the
 * package's entry point uses, which `AudioOutput` and `TextOutput` checks rely on.
 * `synchronizer.test.ts` fails if an upgrade moves it.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { voice } from "@livekit/agents";

/** The text side of a synchronizer: what `AgentSession.output.transcription` takes. */
export type TranscriptOutput = NonNullable<voice.AgentSession["output"]["transcription"]>;

/** The duck type of a text sink the synchronizer forwards paced text into. */
export type TranscriptSink = {
  captureText(text: string | voice.TimedString): Promise<void>;
  flush(): void;
  onAttached(): void;
  onDetached(): void;
};

export type Synchronizer = {
  readonly audioOutput: voice.AudioOutput;
  readonly textOutput: TranscriptOutput;
  close(): Promise<void>;
};

type SynchronizerModule = {
  TranscriptionSynchronizer: new (
    audio: voice.AudioOutput,
    text: TranscriptSink,
    options?: unknown,
  ) => Synchronizer;
  defaultTextSyncOptions: unknown;
};

let loaded: Promise<SynchronizerModule> | null = null;

function checked(module: Partial<SynchronizerModule>, from: string): SynchronizerModule {
  if (typeof module.TranscriptionSynchronizer !== "function" || module.defaultTextSyncOptions === undefined) {
    throw new Error(
      `curb: @livekit/agents no longer has TranscriptionSynchronizer at ${from}; local voice calls need it. ` +
        "Pin @livekit/agents to the version curb declares, or update src/server/voice/local-host/synchronizer.ts.",
    );
  }
  return module as SynchronizerModule;
}

/**
 * Hands over the module a built artifact bundled. @livekit/agents is inlined there, so no package
 * is left for the lookup below to find; the generated entry imports the file by path instead.
 */
export function setBundledSynchronizerModule(module: Partial<SynchronizerModule>): void {
  loaded = Promise.resolve(checked(module, "the bundled artifact"));
}

function loadModule(): Promise<SynchronizerModule> {
  loaded ??= (async () => {
    const require = createRequire(import.meta.url);
    // The CommonJS entry sits beside the ESM one in dist/: only its directory is used.
    const distDir = dirname(require.resolve("@livekit/agents"));
    const file = join(distDir, "voice", "transcription", "synchronizer.js");
    return checked((await import(pathToFileURL(file).href)) as Partial<SynchronizerModule>, file);
  })();
  return loaded;
}

/** A synchronizer pacing `text` to `audio`'s playback, with RoomIO's default options. */
export async function createSynchronizer(audio: voice.AudioOutput, text: TranscriptSink): Promise<Synchronizer> {
  const { TranscriptionSynchronizer, defaultTextSyncOptions } = await loadModule();
  return new TranscriptionSynchronizer(audio, text, defaultTextSyncOptions);
}
