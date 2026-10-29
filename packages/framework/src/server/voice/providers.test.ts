import { initializeLogger } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { azure, cartesia, deepgram, elevenlabs, kugelaudio, openai, type TtsDescriptor } from "../../providers.js";
import { SessionSettings } from "../../session-settings.js";
import {
  buildVoiceProviders,
  buildVoiceStt,
  buildVoiceTts,
  describeMissingVoiceEnv,
  preloadVoicePlugins,
  VoiceProviderError,
} from "./providers.js";
import { applyAzureSpeechProxy, AzureSTT } from "./livekit-host/azure-stt-plugin.js";
import { KugelSTT } from "./livekit-host/kugel-stt-plugin.js";

// The LiveKit TTS base class logs on construction; the host does this once too.
initializeLogger({ pretty: false, level: "silent" });

/** Every key any provider path reads, so a test env is total rather than sparse. */
const NO_KEYS = {
  AZURE_SPEECH_KEY: undefined,
  AZURE_SPEECH_REGION: undefined,
  KUGELAUDIO_API_KEY: undefined,
  DEEPGRAM_API_KEY: undefined,
  ELEVEN_API_KEY: undefined,
  ELEVENLABS_API_KEY: undefined,
  CARTESIA_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
} satisfies Record<string, string | undefined>;

/** Kugel TTS dials its service on construction; point it at a closed local port so the
 * suite never reaches the network. */
const NO_NETWORK = { KUGELAUDIO_API_BASE: "http://127.0.0.1:9" };

const ALL_KEYS = {
  ...NO_NETWORK,
  AZURE_SPEECH_KEY: "azure-key",
  AZURE_SPEECH_REGION: "eastus",
  KUGELAUDIO_API_KEY: "kugel-key",
  DEEPGRAM_API_KEY: "dg-key",
  ELEVEN_API_KEY: "el-key",
  ELEVENLABS_API_KEY: undefined,
  CARTESIA_API_KEY: "ct-key",
  OPENAI_API_KEY: "oa-key",
} satisfies Record<string, string | undefined>;

/** A plugin module whose STT/TTS classes record the options they were built with. */
function recordingPlugin() {
  const built: Array<{ name: string; options: Record<string, unknown> }> = [];
  const loaded: string[] = [];
  const make = (name: string) =>
    class {
      constructor(options: Record<string, unknown>) {
        built.push({ name, options });
      }
      close() {}
    };
  const loadModule = async (specifier: string) => {
    loaded.push(specifier);
    return { STT: make(`${specifier}#STT`), TTS: make(`${specifier}#TTS`) };
  };
  return { built, loaded, loadModule };
}

// First in the file: it has to observe the process before any Azure STT has been built.
// Every Curb server imports the plugin module, so a global removed at import broke
// supabase-js in agents that never transcribe a word.
describe("the Azure STT WebSocket override", () => {
  it("keeps Node's WebSocket until an Azure STT is constructed", () => {
    const globals = globalThis as { WebSocket?: unknown };
    const builtIn = globals.WebSocket;
    expect(builtIn).toBeDefined();
    try {
      new AzureSTT({ key: "azure-key", region: "eastus", language: "en" });
      expect(globals.WebSocket).toBeUndefined();
    } finally {
      globals.WebSocket = builtIn;
    }
  });
});

/**
 * Resolution is asserted against values written out by hand rather than derived from the
 * implementation, so a change to the implementation cannot make the test agree with it.
 */
describe("buildVoiceStt / buildVoiceTts from descriptors", () => {
  it("passes each descriptor's options to the plugin under the plugin's own names", async () => {
    const { built, loadModule } = recordingPlugin();
    const env = { ...ALL_KEYS };
    await buildVoiceStt({ descriptor: deepgram.stt({ model: "nova-3", language: "de,en" }), env, loadModule });
    await buildVoiceStt({ descriptor: elevenlabs.stt({ model: "scribe_v2_realtime" }), env, loadModule });
    await buildVoiceStt({ descriptor: openai.stt(), env, loadModule });
    await buildVoiceTts({ descriptor: cartesia.tts({ voice: "v-1", model: "sonic-3" }), env, loadModule });
    await buildVoiceTts({ descriptor: elevenlabs.tts({ voice: "el-voice" }), env, loadModule });
    await buildVoiceTts({ descriptor: openai.tts({ voice: "nova", model: "tts-1-hd" }), env, loadModule });
    await buildVoiceTts({ descriptor: openai.tts(), env, loadModule });
    expect(built).toEqual([
      { name: "@livekit/agents-plugin-deepgram#STT", options: { apiKey: "dg-key", language: "de", model: "nova-3" } },
      { name: "@livekit/agents-plugin-elevenlabs#STT", options: { apiKey: "el-key", modelId: "scribe_v2_realtime" } },
      { name: "@livekit/agents-plugin-openai#STT", options: { apiKey: "oa-key", language: "en" } },
      { name: "@livekit/agents-plugin-cartesia#TTS", options: { apiKey: "ct-key", language: "en", model: "sonic-3", voice: "v-1" } },
      { name: "@livekit/agents-plugin-elevenlabs#TTS", options: { apiKey: "el-key", voiceId: "el-voice" } },
      { name: "@livekit/agents-plugin-openai#TTS", options: { apiKey: "oa-key", voice: "nova", model: "tts-1-hd" } },
      { name: "@livekit/agents-plugin-openai#TTS", options: { apiKey: "oa-key", voice: "alloy" } },
    ]);
  });

  it("builds today's defaults: Kugel voice 1072 on kugel-3.5 in English, Azure in English", async () => {
    const tts = await buildVoiceTts({ descriptor: kugelaudio.tts(), env: { ...ALL_KEYS } });
    const config = (tts as unknown as { session: { config: Record<string, unknown> } }).session.config;
    expect(config).toMatchObject({ voiceId: 1072, modelId: "kugel-3.5", language: "en", apiKey: "kugel-key" });
    await tts.close();

    const stt = await buildVoiceStt({ descriptor: azure.stt(), env: { ...ALL_KEYS } });
    expect((stt as AzureSTT).config).toMatchObject({
      key: "azure-key",
      region: "eastus",
      language: "en",
      segmentationSilenceTimeoutMs: 300,
    });
  });

  it("takes voice, model and language from the Kugel descriptor", async () => {
    const tts = await buildVoiceTts({
      descriptor: kugelaudio.tts({ voice: 42, model: "kugel-2", language: "de" }),
      env: { ...ALL_KEYS },
    });
    const config = (tts as unknown as { session: { config: Record<string, unknown> } }).session.config;
    expect(config).toMatchObject({ voiceId: 42, modelId: "kugel-2", language: "de" });
    await tts.close();
  });

  /** The voice and language a Kugel TTS was built with. */
  const kugelVoice = async (descriptor: TtsDescriptor) => {
    const tts = await buildVoiceTts({ descriptor, env: { ...ALL_KEYS } });
    const { voiceId, language } = (tts as unknown as { session: { config: Record<string, unknown> } }).session.config;
    await tts.close();
    return { voiceId, language };
  };

  it("speaks the default voice of the descriptor's language when it names no voice", async () => {
    expect(await kugelVoice(kugelaudio.tts({ language: "de" }))).toEqual({ voiceId: 1887, language: "de" });
    expect(await kugelVoice(kugelaudio.tts({ language: "de-DE" }))).toEqual({ voiceId: 1887, language: "de-DE" });
    expect(await kugelVoice(kugelaudio.tts({ language: "en" }))).toEqual({ voiceId: 1072, language: "en" });
    expect(await kugelVoice(kugelaudio.tts())).toEqual({ voiceId: 1072, language: "en" });
    // A language without a voice of its own keeps the English one.
    expect(await kugelVoice(kugelaudio.tts({ language: "fr" }))).toEqual({ voiceId: 1072, language: "fr" });
  });

  it("speaks an explicit voice whatever the language", async () => {
    expect(await kugelVoice(kugelaudio.tts({ voice: 42, language: "de" }))).toEqual({ voiceId: 42, language: "de" });
    expect(await kugelVoice(kugelaudio.tts({ voice: 1072, language: "de" }))).toEqual({ voiceId: 1072, language: "de" });
    expect(await kugelVoice(kugelaudio.tts({ voice: 1887 }))).toEqual({ voiceId: 1887, language: "en" });
  });

  it("speaks a tts.voice override over the language's default voice", async () => {
    const settings = new SessionSettings();
    settings.setAdjustable({ host: ["tts.voice"] });
    settings.setProps({ tts: kugelaudio.tts({ language: "de" }) });
    settings.update("host", { tts: { voice: 17 } });
    expect(await kugelVoice(settings.current().tts)).toEqual({ voiceId: 17, language: "de" });
  });

  it("takes region and segmentation from the Azure descriptor over the environment", async () => {
    const stt = await buildVoiceStt({
      descriptor: azure.stt({ language: "de", region: "westeurope", segmentationMs: 500 }),
      env: { ...ALL_KEYS, AZURE_SPEECH_REGION: "eastus2" },
    });
    expect((stt as AzureSTT).config).toMatchObject({
      region: "westeurope",
      language: "de",
      segmentationSilenceTimeoutMs: 500,
    });
  });

  it("builds Kugel Ear speech-to-text from the descriptor and the KugelAudio key", async () => {
    const stt = await buildVoiceStt({
      descriptor: kugelaudio.stt({
        language: "de, en",
        turnDetectionLevel: "conservative",
        boostedPhrases: ["Beispiel GmbH", "Modell X7"],
      }),
      env: { ...ALL_KEYS, HTTPS_PROXY: "http://proxy.example:3128" },
    });
    expect(stt).toBeInstanceOf(KugelSTT);
    expect((stt as KugelSTT).config).toEqual({
      apiBase: "http://127.0.0.1:9",
      apiKey: "kugel-key",
      proxyUrl: "http://proxy.example:3128",
      language: ["de", "en"],
      turnDetectionLevel: "conservative",
      boostedPhrases: ["Beispiel GmbH", "Modell X7"],
    });
    const plain = await buildVoiceStt({ descriptor: kugelaudio.stt(), env: { ...ALL_KEYS, KUGELAUDIO_API_BASE: undefined } });
    expect((plain as KugelSTT).config).toEqual({ apiBase: "https://api.kugelaudio.com", apiKey: "kugel-key" });
  });

  it("refuses a Kugel Ear language it does not transcribe, before any call", async () => {
    for (const language of ["ja", "de-DE", "German", " , "]) {
      const pending = buildVoiceStt({ descriptor: kugelaudio.stt({ language }), env: { ...ALL_KEYS } });
      await expect(pending).rejects.toThrow(VoiceProviderError);
      await expect(pending).rejects.toThrow(/two-letter codes from: de, en, fr/);
    }
  });

  it("fails fast on a missing credential, naming the env var to set", async () => {
    const { loadModule } = recordingPlugin();
    const cases: Array<[Promise<unknown>, string]> = [
      [buildVoiceStt({ descriptor: azure.stt(), env: { ...NO_KEYS } }), "AZURE_SPEECH_KEY"],
      [buildVoiceStt({ descriptor: kugelaudio.stt(), env: { ...NO_KEYS } }), "KUGELAUDIO_API_KEY"],
      [buildVoiceStt({ descriptor: deepgram.stt(), env: { ...NO_KEYS }, loadModule }), "DEEPGRAM_API_KEY"],
      [buildVoiceStt({ descriptor: elevenlabs.stt(), env: { ...NO_KEYS }, loadModule }), "ELEVEN_API_KEY"],
      [buildVoiceStt({ descriptor: openai.stt(), env: { ...NO_KEYS }, loadModule }), "OPENAI_API_KEY"],
      [buildVoiceTts({ descriptor: kugelaudio.tts(), env: { ...NO_KEYS, ...NO_NETWORK } }), "KUGELAUDIO_API_KEY"],
      [buildVoiceTts({ descriptor: cartesia.tts(), env: { ...NO_KEYS }, loadModule }), "CARTESIA_API_KEY"],
      [buildVoiceTts({ descriptor: elevenlabs.tts(), env: { ...NO_KEYS }, loadModule }), "ELEVEN_API_KEY"],
      [buildVoiceTts({ descriptor: openai.tts(), env: { ...NO_KEYS }, loadModule }), "OPENAI_API_KEY"],
    ];
    for (const [pending, envName] of cases) {
      await expect(pending).rejects.toThrow(VoiceProviderError);
      await expect(pending).rejects.toThrow(envName);
    }
  });

  it("accepts the spelled-out ElevenLabs key too", async () => {
    const { built, loadModule } = recordingPlugin();
    await buildVoiceTts({
      descriptor: elevenlabs.tts(),
      env: { ...NO_KEYS, ELEVENLABS_API_KEY: "spelled-out" },
      loadModule,
    });
    expect(built[0]!.options.apiKey).toBe("spelled-out");
  });

  it("raises on an unknown provider instead of falling back to a default", async () => {
    const bogus = { provider: "polly", kind: "tts", options: {} } as unknown as ReturnType<typeof kugelaudio.tts>;
    await expect(buildVoiceTts({ descriptor: bogus, env: { ...ALL_KEYS } })).rejects.toThrow(
      /Unknown tts provider "polly"/,
    );
  });

  it("checks both keys before building either provider", async () => {
    const { built, loadModule } = recordingPlugin();
    await expect(
      buildVoiceProviders({
        settings: { stt: deepgram.stt(), tts: cartesia.tts() },
        env: { ...NO_KEYS, DEEPGRAM_API_KEY: "dg-key" },
        loadModule,
      }),
    ).rejects.toThrow(/CARTESIA_API_KEY/);
    expect(built).toEqual([]);
  });

  it("returns the descriptors it built from, for a later swap to compare against", async () => {
    const { loadModule } = recordingPlugin();
    const settings = { stt: deepgram.stt(), tts: cartesia.tts({ voice: "v" }) };
    const providers = await buildVoiceProviders({ settings, env: { ...ALL_KEYS }, loadModule });
    expect(providers.descriptors).toEqual(settings);
  });
});

describe("describeMissingVoiceEnv", () => {
  it("lists the vendor keys the given providers need, and passes when they are present", () => {
    const defaults = { stt: azure.stt(), tts: kugelaudio.tts() };
    expect(describeMissingVoiceEnv(defaults, { ...NO_KEYS })).toBe(
      "Voice is not configured (STT: azure, TTS: kugelaudio): missing " +
        "AZURE_SPEECH_KEY (speech-to-text), KUGELAUDIO_API_KEY (text-to-speech). " +
        "Add the key(s) to the project's .env " +
        "(see .env.example); `npm run dev` reloads when it is saved. Text chat works without them.",
    );
    expect(describeMissingVoiceEnv(defaults, { ...ALL_KEYS })).toBeNull();
    expect(
      describeMissingVoiceEnv({ stt: deepgram.stt(), tts: openai.tts() }, { ...NO_KEYS, OPENAI_API_KEY: "k" }),
    ).toMatch(/missing DEEPGRAM_API_KEY \(speech-to-text\)\./);
  });
});

/**
 * Plugin imports are paid once, before a warm runner says `ready`. A plugin that is not
 * installed, or exports the wrong shape, must fail warmup rather than the first call.
 */
describe("preloadVoicePlugins", () => {
  const recording = () => {
    const loaded: string[] = [];
    const loadModule = async (specifier: string) => {
      loaded.push(specifier);
      return { STT: class {}, TTS: class {} };
    };
    return { loaded, loadModule };
  };

  it("imports exactly the selected providers' plugin packages", async () => {
    const { loaded, loadModule } = recording();
    await preloadVoicePlugins({ stt: deepgram.stt(), tts: cartesia.tts() }, { env: {}, loadModule });
    expect(loaded.sort()).toEqual([
      "@livekit/agents-plugin-cartesia",
      "@livekit/agents-plugin-deepgram",
    ]);
  });

  it("imports one package once when it serves both capabilities", async () => {
    const { loaded, loadModule } = recording();
    await preloadVoicePlugins({ stt: elevenlabs.stt(), tts: elevenlabs.tts() }, { env: {}, loadModule });
    expect(loaded).toEqual(["@livekit/agents-plugin-elevenlabs"]);
  });

  it("imports nothing for the framework's own providers", async () => {
    const { loaded, loadModule } = recording();
    await preloadVoicePlugins({ stt: azure.stt(), tts: kugelaudio.tts() }, { env: {}, loadModule });
    expect(loaded).toEqual([]);
  });

  it("fails when a selected plugin does not export the class the provider needs", async () => {
    await expect(
      preloadVoicePlugins(
        { stt: deepgram.stt(), tts: kugelaudio.tts() },
        { env: {}, loadModule: async () => ({}) },
      ),
    ).rejects.toThrow(/does not export the expected STT class/);
  });

  it("fails when a selected plugin is not installed", async () => {
    await expect(
      preloadVoicePlugins(
        { stt: azure.stt(), tts: openai.tts() },
        {
          env: {},
          loadModule: async () => {
            throw new VoiceProviderError('needs the plugin package "@livekit/agents-plugin-openai"');
          },
        },
      ),
    ).rejects.toThrow(VoiceProviderError);
  });
});

describe("hosted provider proxy configuration", () => {
  it("defaults Azure Speech to eastus when no region is configured", async () => {
    const stt = await buildVoiceStt({
      descriptor: azure.stt(),
      env: { AZURE_SPEECH_KEY: "test-key" },
    });

    expect(stt).toBeInstanceOf(AzureSTT);
    expect((stt as AzureSTT).config.region).toBe("eastus");
  });

  it("passes the runner HTTPS proxy to the native Azure STT client", async () => {
    const stt = await buildVoiceStt({
      descriptor: azure.stt(),
      env: {
        AZURE_SPEECH_KEY: "test-key",
        AZURE_SPEECH_REGION: "eastus",
        HTTPS_PROXY: "http://egress-proxy.example:3129",
      },
    });

    expect(stt).toBeInstanceOf(AzureSTT);
    expect((stt as AzureSTT).config.proxyUrl).toBe("http://egress-proxy.example:3129");
  });

  it("passes the runner HTTPS proxy to the native Kugel TTS client", async () => {
    const tts = await buildVoiceTts({
      descriptor: kugelaudio.tts(),
      env: {
        KUGELAUDIO_API_KEY: "test-key",
        HTTPS_PROXY: "http://egress-proxy.example:3129",
      },
    });

    const session = (tts as unknown as { session: { config: { proxyUrl?: string } } }).session;
    expect(session.config.proxyUrl).toBe("http://egress-proxy.example:3129");
    await tts.close();
  });

  it("applies that proxy to the Azure Speech SDK without changing direct local use", () => {
    const setProxy = vi.fn();
    applyAzureSpeechProxy({ setProxy }, "http://user:pass@egress-proxy.example:3129");
    expect(setProxy).toHaveBeenCalledWith("egress-proxy.example", 3129, "user", "pass");

    setProxy.mockClear();
    applyAzureSpeechProxy({ setProxy }, undefined);
    expect(setProxy).not.toHaveBeenCalled();
  });
});

/** The dictionary selection is the one place where two independently valid
 * settings are invalid together, so it is the one worth pinning: the service
 * rejects the pair on the first spoken turn of a live call, and these assert
 * the framework rejects it while someone is still looking at the code. */
describe("buildVoiceTts dictionary selection", () => {
  const kugel = async (options: Parameters<typeof kugelaudio.tts>[0]) => {
    const tts = await buildVoiceTts({
      descriptor: kugelaudio.tts(options),
      env: { ...NO_NETWORK, KUGELAUDIO_API_KEY: "test-key" },
    });
    const config = (tts as unknown as { session: { config: Record<string, unknown> } }).session.config;
    await tts.close();
    return config;
  };

  it("refuses a selection with no project to own it", async () => {
    await expect(kugel({ voice: 1840, dictionaryIds: [7] })).rejects.toThrow(VoiceProviderError);
    await expect(kugel({ voice: 1840, dictionaryIds: [7] })).rejects.toThrow(/projectId/);
  });

  it("accepts a project with no selection: the project's default applies", async () => {
    await expect(kugel({ voice: 1840, projectId: 42 })).resolves.toMatchObject({ projectId: 42 });
  });

  it("passes a paired project and selection through", async () => {
    await expect(kugel({ voice: 1840, projectId: 42, dictionaryIds: [7, 8] })).resolves.toMatchObject({
      projectId: 42,
      dictionaryIds: [7, 8],
    });
  });
});
