import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { stt, tts } from "@livekit/agents";
import {
  defaultKugelVoice,
  DEFAULT_VOICE_LANGUAGE,
  type KugelaudioSttOptions,
  type KugelaudioTtsOptions,
  type SttDescriptor,
  type TtsDescriptor,
} from "../../providers.js";
import { AzureSTT } from "./livekit-host/azure-stt-plugin.js";
import { KugelSTT } from "./livekit-host/kugel-stt-plugin.js";
import { KugelTTS } from "./livekit-host/kugel-tts-plugin.js";
import type { CallReporter } from "../../hosted/call-reporter.js";
import { hostKeyPendingFix, kugelaudioSpeechBase, SPEECH_KEYS } from "../../provider-keys.js";

/**
 * Voice provider resolution: a `curb/providers` descriptor (`azure.stt()`,
 * `kugelaudio.tts({ voice: 42 })`, ...) plus the credential from the environment → a
 * LiveKit agents STT/TTS instance.
 *
 * The descriptor comes from the rendered tree (`<Agent stt tts>`, the active `<Skill>`'s
 * override); the environment holds secrets only. azure + kugelaudio (stt and tts) are the framework's
 * own plugins (./livekit-host/); the rest are first-party LiveKit plugin packages,
 * installed per project and resolved from the project when the framework is
 * symlink-installed. An unknown provider or a missing key RAISES, naming the fix.
 */

export type { SttProviderId, TtsProviderId } from "../../providers.js";

/** The speech half of a conversation's provider settings. */
export type VoiceProviderSettings = { stt: SttDescriptor; tts: TtsDescriptor };

export class VoiceProviderError extends Error {}

export const KUGEL_TTS_SAMPLE_RATE = 24000; // Kugel emits PCM16 @24 kHz
const DEFAULT_AZURE_SPEECH_REGION = "eastus";
const DEFAULT_KUGEL_TTS_MODEL = "kugel-3.5";
/** The languages kugel-ear-1 transcribes (Speech to Text API, "Supported languages"). */
const KUGEL_STT_LANGUAGES = new Set(["de", "en", "fr", "it", "es", "pt", "nl", "pl", "ro"]);

type Env = Record<string, string | undefined>;
export type LoadModule = (specifier: string) => Promise<unknown>;

/** The credential the provider reads (`provider-keys.ts`), by the env var name a fix would set. */
function keyEnvFor(descriptor: SttDescriptor | TtsDescriptor) {
  const entry = SPEECH_KEYS[descriptor.provider]?.key;
  if (!entry) {
    throw new VoiceProviderError(
      `Unknown ${descriptor.kind} provider ${JSON.stringify(descriptor.provider)}. Build the ` +
        `${descriptor.kind} prop with a factory from "curb/providers".`,
    );
  }
  return entry;
}

/** The provider's key, or a VoiceProviderError naming the env var to set. */
function requireKey(descriptor: SttDescriptor | TtsDescriptor, env: Env): string {
  const entry = keyEnvFor(descriptor);
  const value = entry.read(env);
  if (value) return value;
  const what = descriptor.kind === "stt" ? "speech-to-text" : "text-to-speech";
  const hosted = entry.name === "KUGELAUDIO_API_KEY" ? hostKeyPendingFix(env) : null;
  throw new VoiceProviderError(
    `The agent's ${descriptor.kind} is ${descriptor.provider} (${what}), which needs ${entry.name}. ` +
      (hosted ?? "Add it to the project's .env (see .env.example) and restart."),
  );
}

/**
 * Missing-key check for the given providers — an agent-readable explanation, or null
 * when voice can run. Voice keys are optional overall (chat works without them), so this
 * only matters when a voice call starts.
 */
export function describeMissingVoiceEnv(
  settings: VoiceProviderSettings,
  env: Env = process.env,
): string | null {
  const missing = (["stt", "tts"] as const).flatMap((slot) => {
    const entry = keyEnvFor(settings[slot]);
    return entry.read(env) ? [] : [`${entry.name} (${slot === "stt" ? "speech-to-text" : "text-to-speech"})`];
  });
  if (missing.length === 0) return null;
  return [
    `Voice is not configured (STT: ${settings.stt.provider}, TTS: ${settings.tts.provider}):`,
    `missing ${missing.join(", ")}.`,
    "Add the key(s) to the project's .env (see .env.example); `npm run dev` reloads when it is saved.",
    "Text chat works without them.",
  ].join(" ");
}

/** Lazy import that also resolves from the project's node_modules — with a
 * file:-symlinked framework, Node resolves the framework's own imports from
 * the curb checkout, not the project that actually installed the
 * plugin. */
export async function importVoicePlugin(
  specifier: string,
  env: Env = process.env,
): Promise<unknown> {
  try {
    return await import(specifier);
  } catch (firstError) {
    const projectDir = env.AGENT_PROJECT_DIR?.trim();
    if (projectDir) {
      try {
        const projectRequire = createRequire(join(projectDir, "package.json"));
        return await import(pathToFileURL(projectRequire.resolve(specifier)).href);
      } catch {
        // KEEP-JUSTIFIED: fall through to the single readable error below —
        // both resolution attempts failing means the package is not installed.
      }
    }
    throw new VoiceProviderError(
      [
        `The selected voice provider needs the plugin package "${specifier}", which is not installed.`,
        `Install it in your project: npm install ${specifier}`,
        `(original error: ${firstError instanceof Error ? firstError.message : String(firstError)})`,
      ].join(" "),
    );
  }
}

/** The plugin package each non-built-in provider is constructed from. */
const PLUGINS: Record<string, string> = {
  deepgram: "@livekit/agents-plugin-deepgram",
  elevenlabs: "@livekit/agents-plugin-elevenlabs",
  cartesia: "@livekit/agents-plugin-cartesia",
  openai: "@livekit/agents-plugin-openai",
};

/**
 * Import the given providers' plugin packages and check their shape, ahead of any call.
 *
 * A warm runner does this before it says `ready`, so the import is not paid on the call
 * path (the later `import()` is a module-cache hit) and a missing or incompatible plugin
 * fails the runner instead of the first caller. Opens no connection: construction, which
 * is where a plugin may dial its vendor, still happens per call.
 */
export async function preloadVoicePlugins(
  settings: VoiceProviderSettings,
  options: { env?: Env; loadModule?: LoadModule } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const load = options.loadModule ?? ((specifier) => importVoicePlugin(specifier, env));
  const wanted = new Map<string, string[]>();
  for (const descriptor of [settings.stt, settings.tts]) {
    const specifier = PLUGINS[descriptor.provider];
    if (!specifier) continue;
    wanted.set(specifier, [...(wanted.get(specifier) ?? []), descriptor.kind.toUpperCase()]);
  }
  await Promise.all(
    [...wanted].map(async ([specifier, classNames]) => {
      const module = await load(specifier);
      for (const name of classNames) pluginClass(module, name, specifier);
    }),
  );
}

function pluginClass<T>(module: unknown, name: string, specifier: string): T {
  const candidate = (module as Record<string, unknown>)[name];
  if (typeof candidate !== "function") {
    throw new VoiceProviderError(
      `"${specifier}" does not export the expected ${name} class — its installed version is ` +
        "likely incompatible with this framework version.",
    );
  }
  return candidate as T;
}

async function pluginConstructor<T>(
  load: LoadModule,
  provider: string,
  name: "STT" | "TTS",
): Promise<new (opts: object) => T> {
  const specifier = PLUGINS[provider]!;
  return pluginClass<new (opts: object) => T>(await load(specifier), name, specifier);
}

/** Two-letter code for plugins that want a single language, e.g. "en,de" → "en". */
const firstLanguage = (language: string | undefined) =>
  (language ?? DEFAULT_VOICE_LANGUAGE).split(",")[0]!.trim() || DEFAULT_VOICE_LANGUAGE;

/** Only the options that are set, so a plugin keeps its own default for the rest. */
const set = (entries: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

/**
 * kugelaudio.stt({ language: "de,fr" }) as the stream's language list. Checked here because the
 * service refuses an unknown code only once the call's stream opens, where the caller hears
 * nothing and the reason lands in a container log.
 */
function kugelSttLanguages(options: KugelaudioSttOptions): string[] | undefined {
  if (options.language === undefined) return undefined;
  const codes = options.language.split(",").map((code) => code.trim()).filter(Boolean);
  const unknown = codes.filter((code) => !KUGEL_STT_LANGUAGES.has(code));
  if (codes.length === 0 || unknown.length > 0) {
    throw new VoiceProviderError(
      `kugelaudio.stt({ language: ${JSON.stringify(options.language)} }) names ` +
        `${unknown.length ? `unsupported language(s) ${unknown.join(", ")}` : "no language"}. ` +
        `Use two-letter codes from: ${[...KUGEL_STT_LANGUAGES].join(", ")}, e.g. "de" or "de,en".`,
    );
  }
  return codes;
}

export async function buildVoiceStt(options: {
  descriptor: SttDescriptor;
  env?: Env;
  loadModule?: LoadModule;
  /** THIS CALL'S reporter, so the caller half of the transcript is attributed to the
   * conversation it belongs to rather than to whatever call the process started with. */
  reporter?: CallReporter;
}): Promise<stt.STT> {
  const env = options.env ?? process.env;
  const load = options.loadModule ?? ((specifier) => importVoicePlugin(specifier, env));
  const descriptor = options.descriptor;
  const apiKey = requireKey(descriptor, env);

  switch (descriptor.provider) {
    case "kugelaudio": {
      const language = kugelSttLanguages(descriptor.options);
      return new KugelSTT({
        apiBase: kugelaudioSpeechBase(env),
        apiKey,
        proxyUrl: env.HTTPS_PROXY?.trim() || env.https_proxy?.trim(),
        ...set({
          language,
          turnDetection: descriptor.options.turnDetection,
          turnDetectionLevel: descriptor.options.turnDetectionLevel,
          boostedPhrases: descriptor.options.boostedPhrases,
          dictionaryIds: descriptor.options.dictionaryIds,
          projectId: descriptor.options.projectId,
          reporter: options.reporter,
        }),
      });
    }
    case "azure":
      return new AzureSTT({
        key: apiKey,
        region:
          descriptor.options.region?.trim() ||
          env.AZURE_SPEECH_REGION?.trim() ||
          DEFAULT_AZURE_SPEECH_REGION,
        language: descriptor.options.language ?? DEFAULT_VOICE_LANGUAGE,
        proxyUrl: env.HTTPS_PROXY?.trim() || env.https_proxy?.trim(),
        segmentationSilenceTimeoutMs: descriptor.options.segmentationMs ?? 300,
        ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
      });
    case "deepgram": {
      const STT = await pluginConstructor<stt.STT>(load, "deepgram", "STT");
      return new STT({
        apiKey,
        language: firstLanguage(descriptor.options.language),
        ...set({ model: descriptor.options.model }),
      });
    }
    case "elevenlabs": {
      const STT = await pluginConstructor<stt.STT>(load, "elevenlabs", "STT");
      return new STT({ apiKey, ...set({ modelId: descriptor.options.model }) });
    }
    case "openai": {
      const STT = await pluginConstructor<stt.STT>(load, "openai", "STT");
      return new STT({
        apiKey,
        language: firstLanguage(descriptor.options.language),
        ...set({ model: descriptor.options.model }),
      });
    }
  }
}

/** Pronunciation dictionaries for the Kugel TTS path.
 *
 * The project/selection pairing is enforced HERE, not left to the service. The
 * service does reject the combination, but it does so on the first spoken turn
 * of a live call: the caller hears silence and the reason lands in a container
 * log. Failing at session construction puts it in front of whoever authored it.
 */
function kugelDictionarySelection(
  options: KugelaudioTtsOptions,
): { projectId?: number; dictionaryIds?: number[] } {
  const { projectId, dictionaryIds } = options;
  if (dictionaryIds?.length && projectId === undefined) {
    throw new VoiceProviderError(
      `This agent selects pronunciation dictionaries (${dictionaryIds.join(", ")}) but sets no ` +
        "projectId. Dictionaries belong to a KugelAudio project and the service refuses a " +
        "selection without one. Add it next to the ids in kugelaudio.tts({ projectId }) " +
        "— it is the number in your dashboard URL, /dashboard/<org>/<project>/dictionaries.",
    );
  }
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    ...(dictionaryIds?.length ? { dictionaryIds } : {}),
  };
}

export async function buildVoiceTts(options: {
  descriptor: TtsDescriptor;
  env?: Env;
  loadModule?: LoadModule;
}): Promise<tts.TTS> {
  const env = options.env ?? process.env;
  const load = options.loadModule ?? ((specifier) => importVoicePlugin(specifier, env));
  const descriptor = options.descriptor;
  const apiKey = requireKey(descriptor, env);

  switch (descriptor.provider) {
    case "kugelaudio":
      return new KugelTTS({
        apiBase: kugelaudioSpeechBase(env),
        apiKey,
        voiceId: descriptor.options.voice ?? defaultKugelVoice(descriptor.options.language),
        modelId: descriptor.options.model ?? DEFAULT_KUGEL_TTS_MODEL,
        sampleRate: KUGEL_TTS_SAMPLE_RATE,
        language: descriptor.options.language ?? DEFAULT_VOICE_LANGUAGE,
        proxyUrl: env.HTTPS_PROXY?.trim() || env.https_proxy?.trim(),
        ...kugelDictionarySelection(descriptor.options),
      });
    case "cartesia": {
      const TTS = await pluginConstructor<tts.TTS>(load, "cartesia", "TTS");
      return new TTS({
        apiKey,
        language: firstLanguage(descriptor.options.language),
        ...set({ model: descriptor.options.model, voice: descriptor.options.voice }),
      });
    }
    case "elevenlabs": {
      const TTS = await pluginConstructor<tts.TTS>(load, "elevenlabs", "TTS");
      return new TTS({
        apiKey,
        ...set({ voiceId: descriptor.options.voice, model: descriptor.options.model }),
      });
    }
    case "openai": {
      const TTS = await pluginConstructor<tts.TTS>(load, "openai", "TTS");
      return new TTS({
        apiKey,
        voice: descriptor.options.voice ?? "alloy",
        ...set({ model: descriptor.options.model }),
      });
    }
  }
}

/** The speech providers one call talks through, and the descriptors they were built from
 * (what a later swap compares against). */
export type VoiceProviders = {
  stt: stt.STT;
  tts: tts.TTS;
  descriptors: VoiceProviderSettings;
};

/**
 * Build one call's STT and TTS from the conversation's provider settings.
 *
 * Construction may dial the vendor (Kugel TTS opens its socket in its constructor), which
 * is why a warm runner calls this per call, alongside room.connect, and never at warmup.
 * Both keys are checked before either provider is built, so a missing one opens nothing.
 */
export async function buildVoiceProviders(options: {
  settings: VoiceProviderSettings;
  env?: NodeJS.ProcessEnv;
  reporter?: CallReporter;
  loadModule?: LoadModule;
}): Promise<VoiceProviders> {
  const env = options.env ?? process.env;
  const missing = describeMissingVoiceEnv(options.settings, env);
  if (missing) throw new VoiceProviderError(missing);
  const descriptors = { stt: options.settings.stt, tts: options.settings.tts };
  const stt = await buildVoiceStt({
    descriptor: descriptors.stt,
    env,
    ...(options.loadModule ? { loadModule: options.loadModule } : {}),
    ...(options.reporter === undefined ? {} : { reporter: options.reporter }),
  });
  try {
    const tts = await buildVoiceTts({
      descriptor: descriptors.tts,
      env,
      ...(options.loadModule ? { loadModule: options.loadModule } : {}),
    });
    return { stt, tts, descriptors };
  } catch (error) {
    // KEEP-JUSTIFIED: the STT may already hold a vendor connection, so close it; a failure
    // closing it would only mask the TTS error, which is the one the caller must see.
    await Promise.resolve(stt.close?.()).catch(() => {});
    throw error;
  }
}
