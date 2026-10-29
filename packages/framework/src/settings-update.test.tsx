import { afterEach, describe, expect, it, vi } from "vitest";
import { missingLlmCredential } from "./llm/ai-sdk.js";
import { Agent, AgentSiteRuntime, Text, useSession, type Adjustable } from "./index.js";
import { AgentAuthoringError } from "./authoring.js";
import { anthropic, azure, elevenlabs, kugelaudio, openaiCompatible, type LlmDescriptor } from "./providers.js";
import { SessionSettings } from "./session-settings.js";
import { SettingsRefusedError, type SettingsOrigin } from "./settings-update.js";

/**
 * Live settings from outside the agent (a client's `curb.update`, the host's PATCH): deny by
 * default, all-or-nothing, and checked against the provider each value would reach.
 */

function settingsWith(adjustable: Adjustable, llm?: LlmDescriptor) {
  const settings = new SessionSettings();
  settings.setAdjustable(adjustable);
  settings.setProps({ tts: kugelaudio.tts({ voice: 42 }), stt: azure.stt({ language: "en" }), ...(llm ? { llm } : {}) });
  return settings;
}

function refusal(settings: SessionSettings, origin: SettingsOrigin, body: unknown): SettingsRefusedError {
  try {
    settings.update(origin, body);
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsRefusedError);
    return error as SettingsRefusedError;
  }
  throw new Error("the update was accepted");
}

describe("live settings updates", () => {
  it("refuses everything by default, for both origins", () => {
    const settings = settingsWith({});
    for (const origin of ["client", "host"] as const) {
      const error = refusal(settings, origin, { tts: { voice: 7 } });
      expect(error.code).toBe("not_adjustable");
      expect(error.path).toBe("tts.voice");
      expect(error.message).toContain("lets it change nothing");
    }
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
  });

  it("gates each origin by its own list", () => {
    const settings = settingsWith({ client: ["tts.voice"], host: ["stt.language"] });
    expect(refusal(settings, "host", { tts: { voice: 7 } }).code).toBe("not_adjustable");
    expect(refusal(settings, "client", { stt: { language: "de" } }).code).toBe("not_adjustable");
    expect(settings.update("client", { tts: { voice: 7 } })).toMatchObject({ tts: { provider: "kugelaudio", voice: 7 } });
    expect(settings.update("host", { stt: { language: "de" } })).toMatchObject({ stt: { provider: "azure", language: "de" } });
  });

  it("refuses a mixed body as a whole: one path not adjustable changes nothing", () => {
    const settings = settingsWith({ host: ["tts.voice"] });
    const error = refusal(settings, "host", { tts: { voice: 7 }, llm: { provider: "anthropic", model: "claude-sonnet-5" } });
    expect(error.code).toBe("not_adjustable");
    expect(error.path).toBe("llm");
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
    expect(settings.current().llm).toStrictEqual(kugelaudio.llm());
  });

  it("refuses a body with one bad value as a whole: the good value is not applied either", () => {
    const settings = settingsWith({ host: ["tts.voice", "stt.language", "llm"] });
    const error = refusal(settings, "host", { tts: { voice: "Rachel" }, stt: { language: "de" } });
    expect(error.code).toBe("invalid_settings");
    expect(error.issues).toEqual([{ path: ["tts", "voice"], message: 'kugelaudio voices are numeric ids, got "Rachel"' }]);
    expect(settings.current().stt).toStrictEqual(azure.stt({ language: "en" }));
  });

  it("names unknown keys and wrong shapes as invalid_settings, not as a quiet no-op", () => {
    const settings = settingsWith({ host: ["tts.voice"] });
    expect(refusal(settings, "host", { tts: { pitch: 2 } }).issues).toEqual([
      { path: ["tts", "pitch"], message: expect.stringContaining("unknown setting") },
    ]);
    expect(refusal(settings, "host", { tts: { voice: { id: 1 } } }).code).toBe("invalid_settings");
    expect(refusal(settings, "host", [1]).code).toBe("invalid_settings");
  });

  it("checks values against the provider they reach", () => {
    const settings = new SessionSettings();
    settings.setAdjustable({ host: ["tts.voice", "stt.language"] });
    settings.setProps({ tts: elevenlabs.tts({ voice: "Rachel" }), stt: elevenlabs.stt() });
    // A string-voiced provider takes a numeric id as a string.
    expect(settings.update("host", { tts: { voice: 17 } }).tts).toEqual({ provider: "elevenlabs", voice: "17" });
    expect(refusal(settings, "host", { stt: { language: "de" } }).issues?.[0]?.message).toContain("takes no language");
  });

  it("lets a host change the language Kugel Ear listens for", () => {
    const settings = new SessionSettings();
    settings.setAdjustable({ host: ["stt.language"] });
    settings.setProps({ stt: kugelaudio.stt({ language: "de" }) });
    settings.update("host", { stt: { language: "en" } });
    expect(settings.current().stt).toStrictEqual(kugelaudio.stt({ language: "en" }));
  });

  it("switches the llm only to a real descriptor, and never lets a client move the endpoint", () => {
    const requestOptions = { reasoningEffort: "none", temperature: 0.7, body: { top_k: 20 } } as const;
    const own = openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3", ...requestOptions });
    const settings = settingsWith({ client: ["llm"], host: ["llm"] }, own);

    expect(refusal(settings, "client", { llm: { provider: "openai-compatible", model: "x", baseURL: "https://evil.example/v1" } }).issues?.[0]?.path).toEqual(["llm", "baseURL"]);
    // Its own endpoint, another model: allowed, and the author's request options stay.
    expect(settings.update("client", { llm: { provider: "openai-compatible", model: "qwen3" } }).llm).toEqual({ provider: "openai-compatible", model: "qwen3" });
    expect(settings.current().llm).toStrictEqual(
      openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "qwen3", ...requestOptions }),
    );
    // The host is trusted with an endpoint; another endpoint starts without the author's options.
    settings.update("host", { llm: { provider: "openai-compatible", model: "m", baseURL: "https://llm.example/v1" } });
    expect(settings.current().llm).toStrictEqual(openaiCompatible({ baseURL: "https://llm.example/v1", model: "m" }));

    expect(refusal(settings, "host", { llm: { provider: "gemini", model: "x" } }).issues?.[0]?.path).toEqual(["llm", "provider"]);
    expect(refusal(settings, "host", { llm: { provider: "anthropic", model: "x", baseURL: "http://a/v1" } }).code).toBe("invalid_settings");
    expect(refusal(settings, "host", { llm: { provider: "anthropic", model: "{{AGENT_MODEL}}" } }).issues?.[0]?.path).toEqual(["llm", "model"]);
    expect(settings.update("host", { llm: { provider: "anthropic", model: "claude-sonnet-5" } }).llm).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("reports the effective settings without credentials or extra options", () => {
    const settings = new SessionSettings();
    settings.setAdjustable({ host: ["tts.model"] });
    settings.setProps({ tts: kugelaudio.tts({ voice: 42, dictionaryIds: [1], projectId: 9 }) });
    expect(settings.update("host", { tts: { model: "kugel-4" } })).toEqual({
      tts: { provider: "kugelaudio", voice: 42, model: "kugel-4" },
      stt: { provider: "azure" },
      llm: { provider: "kugelaudio", model: "qwen3.8-27b" },
    });
  });

  it("switches the llm to a KugelAudio model it serves, and refuses one it does not", () => {
    const settings = settingsWith({ host: ["llm"] });
    settings.update("host", { llm: { provider: "anthropic", model: "claude-sonnet-5" } });
    expect(settings.update("host", { llm: { provider: "kugelaudio", model: "mistral-medium-3.5-128b" } }).llm).toEqual({
      provider: "kugelaudio",
      model: "mistral-medium-3.5-128b",
    });
    expect(refusal(settings, "host", { llm: { provider: "kugelaudio", model: "gpt-5" } }).issues).toEqual([
      { path: ["llm", "model"], message: 'kugelaudio.llm() got model "gpt-5", which KugelAudio does not serve.' },
    ]);
  });

  it("reports the voice that speaks: a Kugel TTS without one speaks its language's default", () => {
    const settings = new SessionSettings({ debug: vi.fn() });
    settings.setAdjustable({ host: ["tts.voice"] });
    settings.setProps({ tts: kugelaudio.tts({ language: "de" }) });
    expect(settings.view().tts).toEqual({ provider: "kugelaudio", voice: 1887, language: "de" });
    settings.setProps({ tts: kugelaudio.tts() });
    expect(settings.view().tts).toEqual({ provider: "kugelaudio", voice: 1072 });
    // An outside change of the voice is what speaks, so it is what is reported.
    settings.setProps({ tts: kugelaudio.tts({ language: "de" }) });
    expect(settings.update("host", { tts: { voice: 17 } }).tts).toEqual({ provider: "kugelaudio", voice: 17, language: "de" });
    // Another vendor's default voice is the vendor's: none is reported.
    settings.setProps({ tts: elevenlabs.tts() });
    expect(settings.view().tts).toEqual({ provider: "elevenlabs" });
  });

  it("refuses, as a whole, an llm switch this server holds no credential for", () => {
    const settings = settingsWith({ host: ["tts.voice", "llm"] });
    settings.setCredentialCheck((descriptor) => (descriptor.provider === "openai" ? "OPENAI_API_KEY" : null));
    const error = refusal(settings, "host", { tts: { voice: 7 }, llm: { provider: "openai", model: "gpt-5" } });
    expect(error.code).toBe("invalid_settings");
    expect(error.issues).toEqual([{ path: ["llm", "provider"], message: "openai needs OPENAI_API_KEY, which this server does not have" }]);
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
    expect(settings.current().llm).toStrictEqual(kugelaudio.llm());
    // A provider it can run is accepted.
    expect(settings.update("host", { llm: { provider: "anthropic", model: "claude-sonnet-5" } }).llm.model).toBe("claude-sonnet-5");
  });

  it("drops a voice override when the props move to another TTS provider, and does not bring it back", () => {
    const debug = vi.fn();
    const settings = new SessionSettings({ debug });
    settings.setAdjustable({ client: ["tts.voice", "tts.model"] });
    settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
    settings.update("client", { tts: { voice: 7, model: "kugel-4" } });
    // The active skill speaks with ElevenLabs: a KugelAudio voice id names nothing there.
    settings.setProps({ tts: elevenlabs.tts({ voice: "Rachel" }) });
    expect(settings.current().tts).toStrictEqual(elevenlabs.tts({ voice: "Rachel" }));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("dropped the tts.voice override set for kugelaudio"));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("dropped the tts.model override set for kugelaudio"));
    settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
    expect(settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
  });

  it("carries the override layer to a rebuilt runtime", () => {
    const first = settingsWith({ client: ["tts.voice"] });
    first.update("client", { tts: { voice: 7 } });
    const second = settingsWith({ client: ["tts.voice"] });
    expect(second.restoreOverrides(first.overridesSnapshot())).toEqual(["tts"]);
    expect(second.current().tts).toStrictEqual(kugelaudio.tts({ voice: 7 }));
  });
});

describe("<Agent adjustable> and useSession()", () => {
  it("reads adjustable from the tree, and useSession().settings follows an outside change", () => {
    const seen: unknown[] = [];
    function Voice() {
      const { settings } = useSession();
      seen.push(settings.tts.options);
      return <Text>{`Voice ${String((settings.tts.options as { voice?: number }).voice)}.`}</Text>;
    }
    const runtime = new AgentSiteRuntime(() => (
      <Agent tts={kugelaudio.tts({ voice: 42 })} adjustable={{ client: ["tts.voice"] }}>
        <Voice />
      </Agent>
    ));
    // The first render already sees the props, not the defaults: the runtime renders again.
    expect(runtime.snapshot().stateSnapshot.join("\n")).toContain("Voice 42.");

    expect(runtime.settings.update("client", { tts: { voice: 7 } })).toMatchObject({ tts: { voice: 7 } });
    expect(runtime.snapshot().stateSnapshot.join("\n")).toContain("Voice 7.");
    expect(seen.at(-1)).toEqual({ voice: 7 });
    expect(() => runtime.settings.update("host", { tts: { voice: 8 } })).toThrow(SettingsRefusedError);
  });

  it("refuses an adjustable that names an unknown path, as an authoring error", () => {
    expect(
      () =>
        new AgentSiteRuntime(() => (
          <Agent adjustable={{ client: ["tts.pitch"] } as unknown as Adjustable}>
            <Text>Hi.</Text>
          </Agent>
        )),
    ).toThrow(AgentAuthoringError);
  });
});

describe("missingLlmCredential", () => {
  const saved = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  it("names the variable an LLM provider needs and this process lacks", () => {
    delete process.env.OPENAI_API_KEY;
    expect(missingLlmCredential({ provider: "openai", kind: "llm", options: { model: "gpt-5" } })).toBe("OPENAI_API_KEY");
    process.env.OPENAI_API_KEY = "sk-test";
    expect(missingLlmCredential({ provider: "openai", kind: "llm", options: { model: "gpt-5" } })).toBeNull();
    expect(
      missingLlmCredential({ provider: "openai-compatible", kind: "llm", options: { baseURL: "http://127.0.0.1:11434/v1", model: "m" } }),
    ).toBeNull();
  });
});
