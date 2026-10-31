import { describe, expect, it } from "vitest";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import {
  anthropic,
  azure,
  cartesia,
  deepgram,
  defaultKugelVoice,
  elevenlabs,
  kugelaudio,
  openai,
  openaiCompatible,
} from "./providers.js";

/** Descriptors are written out by hand: they are a wire shape (they cross the browser,
 * the dev server and a hosted runner), so a change to one must fail here. */
describe("curb/providers factories", () => {
  it("return plain, serializable descriptors", () => {
    const cases = [
      [kugelaudio.tts({ voice: 42, model: "kugel-3", language: "de", dictionaryIds: [1], projectId: 2 }),
        { provider: "kugelaudio", kind: "tts", options: { voice: 42, model: "kugel-3", language: "de", dictionaryIds: [1], projectId: 2 } }],
      [kugelaudio.tts(), { provider: "kugelaudio", kind: "tts", options: {} }],
      [azure.stt({ language: "de", region: "westeurope", segmentationMs: 400 }),
        { provider: "azure", kind: "stt", options: { language: "de", region: "westeurope", segmentationMs: 400 } }],
      [azure.stt(), { provider: "azure", kind: "stt", options: {} }],
      [deepgram.stt({ model: "nova-3", language: "en" }), { provider: "deepgram", kind: "stt", options: { model: "nova-3", language: "en" } }],
      [elevenlabs.stt({ model: "scribe_v2_realtime" }), { provider: "elevenlabs", kind: "stt", options: { model: "scribe_v2_realtime" } }],
      [elevenlabs.tts({ voice: "v", model: "eleven_flash_v2_5" }), { provider: "elevenlabs", kind: "tts", options: { voice: "v", model: "eleven_flash_v2_5" } }],
      [cartesia.tts({ voice: "c", model: "sonic-3" }), { provider: "cartesia", kind: "tts", options: { voice: "c", model: "sonic-3" } }],
      [openai.tts({ voice: "nova", model: "tts-1" }), { provider: "openai", kind: "tts", options: { voice: "nova", model: "tts-1" } }],
      [openai.stt({ model: "gpt-4o-transcribe" }), { provider: "openai", kind: "stt", options: { model: "gpt-4o-transcribe" } }],
      [kugelaudio.llm(), { provider: "kugelaudio", kind: "llm", options: { model: "qwen3.8-27b" } }],
      [kugelaudio.llm({ model: "mistral-medium-3.5-128b" }),
        { provider: "kugelaudio", kind: "llm", options: { model: "mistral-medium-3.5-128b" } }],
      [anthropic("claude-sonnet-5"), { provider: "anthropic", kind: "llm", options: { model: "claude-sonnet-5" } }],
      [openai("gpt-5.2"), { provider: "openai", kind: "llm", options: { model: "gpt-5.2" } }],
      [openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" }),
        { provider: "openai-compatible", kind: "llm", options: { baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" } }],
    ] as const;
    for (const [descriptor, expected] of cases) {
      expect(descriptor).toStrictEqual(expected);
      expect(JSON.parse(JSON.stringify(descriptor))).toStrictEqual(expected);
    }
  });

  it("drop unset options, so equal settings compare equal", () => {
    expect(kugelaudio.tts({ voice: undefined, language: "de" })).toStrictEqual(kugelaudio.tts({ language: "de" }));
  });

  it("refuse a scaffold placeholder for a model id, naming the code and the fix", () => {
    let thrown: unknown;
    try {
      anthropic("{{AGENT_MODEL}}");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const diagnostic = (thrown as AgentAuthoringError).diagnostic;
    expect(diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.scaffoldPlaceholder);
    expect(diagnostic.message).toContain("{{AGENT_MODEL}}");
    expect(diagnostic.fix).toContain("npm create curb.js");
    expect(() => openai("{{ AGENT_MODEL }}")).toThrow(AgentAuthoringError);
    expect(() => openaiCompatible({ baseURL: "http://x/v1", model: "{{AGENT_MODEL}}" })).toThrow(
      AgentAuthoringError,
    );
  });

  it("refuse an empty model id or base URL", () => {
    expect(() => anthropic("")).toThrow(/needs a model id/);
    expect(() => openaiCompatible({ baseURL: " ", model: "llama3.3" })).toThrow(/needs a baseURL/);
  });

  it("refuse a model KugelAudio does not serve, listing the ones it does", () => {
    let thrown: unknown;
    try {
      kugelaudio.llm({ model: "gpt-5.2" as "qwen3.8-27b" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const diagnostic = (thrown as AgentAuthoringError).diagnostic;
    expect(diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidProp);
    expect(diagnostic.message).toBe('kugelaudio.llm() got model "gpt-5.2", which KugelAudio does not serve.');
    expect(diagnostic.fix).toBe(
      'Use one of "qwen3.8-27b", "mistral-medium-3.5-128b", or leave model unset for "qwen3.8-27b".',
    );
  });
});

describe("openaiCompatible request options", () => {
  const endpoint = { baseURL: "https://llm.example/v1", model: "example-model" };

  /** The diagnostic `openaiCompatible(options)` refuses with. */
  function refusal(options: Record<string, unknown>) {
    try {
      openaiCompatible({ ...endpoint, ...options } as Parameters<typeof openaiCompatible>[0]);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentAuthoringError);
      const { diagnostic } = error as AgentAuthoringError;
      expect(diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidProp);
      expect(diagnostic.location?.component).toBe("openaiCompatible");
      return diagnostic;
    }
    throw new Error(`openaiCompatible accepted ${JSON.stringify(options)}`);
  }

  it("carry reasoning, sampling and extra body fields in a plain, serializable descriptor", () => {
    const descriptor = openaiCompatible({
      ...endpoint,
      reasoningEffort: "none",
      temperature: 0.7,
      topP: 0.8,
      body: { top_k: 20, chat_template_kwargs: { enable_thinking: false }, stop: ["\n\n"] },
    });
    const expected = {
      provider: "openai-compatible",
      kind: "llm",
      options: {
        ...endpoint,
        reasoningEffort: "none",
        temperature: 0.7,
        topP: 0.8,
        body: { top_k: 20, chat_template_kwargs: { enable_thinking: false }, stop: ["\n\n"] },
      },
    };
    expect(descriptor).toStrictEqual(expected);
    expect(JSON.parse(JSON.stringify(descriptor))).toStrictEqual(expected);
  });

  it("drop unset options and unset or empty body, so equal requests compare equal", () => {
    expect(
      openaiCompatible({ ...endpoint, temperature: undefined, body: { top_k: undefined } }),
    ).toStrictEqual(openaiCompatible(endpoint));
    expect(openaiCompatible({ ...endpoint, body: {} })).toStrictEqual(openaiCompatible(endpoint));
    expect(openaiCompatible({ ...endpoint, temperature: 0, topP: 1 }).options).toMatchObject({ temperature: 0, topP: 1 });
  });

  it("refuse a reasoningEffort the API does not define, listing the values", () => {
    const diagnostic = refusal({ reasoningEffort: "off" });
    expect(diagnostic.message).toContain('reasoningEffort "off"');
    expect(diagnostic.fix).toContain('"none"');
    expect(diagnostic.fix).toContain('"high"');
  });

  it("refuse temperature outside 0 to 2 and topP outside (0, 1]", () => {
    for (const temperature of [-0.1, 2.1, Number.NaN, Number.POSITIVE_INFINITY, "0.7"]) {
      expect(refusal({ temperature }).message).toContain("temperature");
    }
    for (const topP of [0, -0.5, 1.1, Number.NaN, "0.8"]) {
      expect(refusal({ topP }).message).toContain("topP");
    }
  });

  it("refuse a body field Curb sets itself or an option sets, naming what to use instead", () => {
    for (const [field, fixPart] of [
      ["model", "the `model` option"],
      ["temperature", "the `temperature` option"],
      ["top_p", "the `topP` option"],
      ["reasoning_effort", "the `reasoningEffort` option"],
      ["reasoningEffort", "the `reasoningEffort` option"],
      ["messages", "Curb"],
      ["tools", "Curb"],
      ["tool_choice", "Curb"],
      ["stream", "Curb"],
      ["stream_options", "Curb"],
      ["verbosity", "the AI SDK"],
    ] as const) {
      const diagnostic = refusal({ body: { top_k: 20, [field]: "x" } });
      expect(diagnostic.message).toContain(`body.${field}`);
      expect(diagnostic.fix).toContain(fixPart);
    }
  });

  it("refuse a body that is not an object of JSON values, naming the path", () => {
    expect(refusal({ body: [1, 2] }).message).toContain("as an array");
    expect(refusal({ body: "top_k=20" }).message).toContain("body");
    expect(refusal({ body: { kwargs: { cb: () => 1 } } }).message).toContain("body.kwargs.cb");
    expect(refusal({ body: { stop: ["a", undefined] } }).message).toContain("body.stop[1]");
    expect(refusal({ body: { at: new Date(0) } }).message).toContain("body.at");
    expect(refusal({ body: { top_k: Number.NaN } }).message).toContain("body.top_k");
  });
});

describe("defaultKugelVoice", () => {
  it("is the voice of the language's base, and the English voice for any other language", () => {
    for (const language of ["de", "de-AT", "de_DE", "DE", "de,en", " de "]) {
      expect(defaultKugelVoice(language)).toBe(1887);
    }
    for (const language of ["en", "en-US", "en,de", undefined, "fr", "ja"]) {
      expect(defaultKugelVoice(language)).toBe(1072);
    }
    expect(defaultKugelVoice()).toBe(1072);
  });
});
