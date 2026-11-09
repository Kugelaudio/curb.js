/**
 * `curb/providers`: the speech and LLM providers an agent talks through, as props.
 *
 *   import { kugelaudio } from "curb/providers";
 *   <Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "de" })} tts={kugelaudio.tts({ voice: 42 })}>
 *
 * Every factory returns a plain, serializable descriptor `{ provider, kind, options }`.
 * Nothing here dials a vendor or reads a secret, so this module is browser-safe and the
 * same descriptor renders in the preview, the dev server and a hosted runner. The server
 * turns a descriptor into a LiveKit plugin or an AI SDK model (`server/voice/providers.ts`,
 * `llm/provider.ts`); credentials stay in the environment.
 */

import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";

/** The speech language when a provider's `language` option is not set. */
export const DEFAULT_VOICE_LANGUAGE = "en";

/** The KugelAudio voice of each language, by base language code. */
const DEFAULT_KUGEL_VOICES: Readonly<Record<string, number>> = {
  en: 1072, // female, conversational, declared en-NZ
  de: 1887, // female, conversational, native German (de-DE)
};

/**
 * The voice a `kugelaudio.tts()` without `voice` speaks with: the default voice of its
 * `language`, so an agent told to speak German sounds German. The base language decides
 * ("de" of "de-AT", the first of "de,en"); a language without a voice of its own, like no
 * language at all, gets the English voice.
 */
export function defaultKugelVoice(language?: string): number {
  const base = (language ?? DEFAULT_VOICE_LANGUAGE).split(",")[0]!.trim().toLowerCase().split(/[-_]/)[0]!;
  return DEFAULT_KUGEL_VOICES[base] ?? DEFAULT_KUGEL_VOICES[DEFAULT_VOICE_LANGUAGE]!;
}

/** The models `kugelaudio.llm()` runs, KugelAudio's EU-hosted LLMs. */
export const KUGELAUDIO_LLM_MODELS = ["qwen3.8-27b", "mistral-medium-3.5-128b"] as const;
export type KugelaudioLlmModel = (typeof KUGELAUDIO_LLM_MODELS)[number];
/** The model of a `kugelaudio.llm()` without `model`, which is also the agent's LLM when no
 * `llm` prop is given. */
export const DEFAULT_KUGELAUDIO_LLM_MODEL: KugelaudioLlmModel = "qwen3.8-27b";

/** KugelAudio's LLM, hosted in the EU, on the same `KUGELAUDIO_API_KEY` as its speech. Thinking
 * is off on the service's side, so the agent never speaks its reasoning. */
export type KugelaudioLlmOptions = {
  /** Default {@link DEFAULT_KUGELAUDIO_LLM_MODEL}. */
  model?: KugelaudioLlmModel;
};

export type KugelaudioTtsOptions = {
  /** KugelAudio voice id. Default: the voice of `language`, {@link defaultKugelVoice}. */
  voice?: number;
  /** Kugel TTS model id. Default "kugel-3.5". */
  model?: string;
  /** ISO 639-1 language, e.g. "en", "de": how the text is read (dates, numbers) and, without
   * `voice`, which voice reads it. Default {@link DEFAULT_VOICE_LANGUAGE}. */
  language?: string;
  /** Pronunciation dictionaries to apply, by id. Requires {@link projectId}: dictionaries
   * belong to a KugelAudio project and the service refuses a selection without one. */
  dictionaryIds?: number[];
  /** KugelAudio project id, the number in your dashboard URL. Needed for `dictionaryIds`. */
  projectId?: number;
};
/** Kugel Ear 1 (`kugel-ear-1`), KugelAudio's speech-to-text. Key: `KUGELAUDIO_API_KEY`. */
export type KugelaudioSttOptions = {
  /** Language code(s) the caller speaks: "de", or "de,fr" to detect among several, expecting
   * the first. Unset: the service detects German or English. Supported: de, en, fr, it, es, pt,
   * nl, pl, ro. */
  language?: string;
  /** Who ends a caller's turn: "kugelturn" (default, KugelTurn hears when the speaker
   * finished) or "vad" (after one second of pause). */
  turnDetection?: "kugelturn" | "vad";
  /** How readily KugelTurn ends a turn: "responsive" (default) or "conservative" (holds
   * longer through a pause mid-thought). Only with turnDetection "kugelturn". */
  turnDetectionLevel?: "responsive" | "conservative";
  /** Names, brands and domain terms the recognizer should spell the way you write them. */
  boostedPhrases?: string[];
  /** Dictionaries whose words are used as vocabulary. Unset: every active dictionary of the
   * key's project; [] for none. */
  dictionaryIds?: number[];
  /** KugelAudio project whose dictionaries apply, the number in your dashboard URL. Unset: the
   * API key's own project. */
  projectId?: number;
};
export type AzureSttOptions = {
  /** Recognition language(s), e.g. "en" or "en,de". Default {@link DEFAULT_VOICE_LANGUAGE}. */
  language?: string;
  /** Speech resource region. Default: `AZURE_SPEECH_REGION`, else "eastus". */
  region?: string;
  /** Trailing silence before Azure finalises an utterance, in ms. Default 300. */
  segmentationMs?: number;
};
export type DeepgramSttOptions = { model?: string; language?: string };
export type ElevenlabsSttOptions = { model?: string };
export type ElevenlabsTtsOptions = { voice?: string; model?: string };
export type CartesiaTtsOptions = { voice?: string; model?: string; language?: string };
export type OpenaiTtsOptions = { voice?: string; model?: string };
export type OpenaiSttOptions = { model?: string; language?: string };
/** A JSON value, as a request body carries it. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The `reasoning_effort` values of the OpenAI API (openai-node's `ReasoningEffort`). Which of
 * them a model takes is up to its endpoint. */
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type OpenaiCompatibleOptions = {
  /** The endpoint's OpenAI-compatible base URL, e.g. "http://127.0.0.1:11434/v1". Its key,
   * when it needs one, is `AGENT_LLM_API_KEY` (else `OPENAI_API_KEY`). */
  baseURL: string;
  model: string;
  /** How long a reasoning model thinks, sent as `reasoning_effort`. "none" switches thinking
   * off on endpoints that take it (OpenAI, among others). Unset: the endpoint's default. */
  reasoningEffort?: (typeof REASONING_EFFORTS)[number];
  /** Sampling temperature, 0 to 2, sent as `temperature`. Unset: the endpoint's default. */
  temperature?: number;
  /** Nucleus sampling, above 0 and at most 1, sent as `top_p`. Unset: the endpoint's default. */
  topP?: number;
  /** Extra request fields the endpoint accepts, sent as written, e.g. vLLM's
   * `{ top_k: 20, chat_template_kwargs: { enable_thinking: false } }`. A field set to undefined is left out. */
  body?: Record<string, JsonValue | undefined>;
};

export type TtsDescriptor =
  | { provider: "kugelaudio"; kind: "tts"; options: KugelaudioTtsOptions }
  | { provider: "elevenlabs"; kind: "tts"; options: ElevenlabsTtsOptions }
  | { provider: "cartesia"; kind: "tts"; options: CartesiaTtsOptions }
  | { provider: "openai"; kind: "tts"; options: OpenaiTtsOptions };

export type SttDescriptor =
  | { provider: "kugelaudio"; kind: "stt"; options: KugelaudioSttOptions }
  | { provider: "azure"; kind: "stt"; options: AzureSttOptions }
  | { provider: "deepgram"; kind: "stt"; options: DeepgramSttOptions }
  | { provider: "elevenlabs"; kind: "stt"; options: ElevenlabsSttOptions }
  | { provider: "openai"; kind: "stt"; options: OpenaiSttOptions };

export type LlmDescriptor =
  | { provider: "kugelaudio"; kind: "llm"; options: { model: KugelaudioLlmModel } }
  | { provider: "anthropic"; kind: "llm"; options: { model: string } }
  | { provider: "openai"; kind: "llm"; options: { model: string } }
  | { provider: "openai-compatible"; kind: "llm"; options: OpenaiCompatibleOptions };

/** OpenAI's speech-to-speech models. Key: `OPENAI_API_KEY`. */
export type OpenaiS2sOptions = {
  /** `openai.live()` only, on an endpoint that takes `expects_reply` on a commentary. The model
   * says each reply of the back office word for word, and the caller's next finished turn goes back
   * to `llm`, so the agent's procedure leads the call. */
  verbatim?: boolean;
  /** Defaults to "gpt-live-1" for `openai.live()` and LiveKit's default for `openai.realtime()`. */
  model?: string;
  voice?: string;
  /** Another endpoint on the same protocol. */
  baseURL?: string;
};

/** Which wire a model speaks decides how it hands work to Curb; the agent never sees the difference. */
export type S2sDescriptor = { provider: "openai"; kind: "s2s"; protocol: "live" | "realtime"; options: OpenaiS2sOptions };

export type TtsProviderId = TtsDescriptor["provider"];
export type SttProviderId = SttDescriptor["provider"];
export type LlmProviderId = LlmDescriptor["provider"];

/** The provider props `<Agent>` and `<Skill>` accept. */
export type ProviderProps = {
  llm?: LlmDescriptor;
  stt?: SttDescriptor;
  tts?: TtsDescriptor;
};

/** What `<Agent>` accepts beyond the provider props of a `<Skill>`. With `s2s`, that model hears
 * the caller, decides when to speak and speaks; `stt` and `tts` are not used, and `llm` runs
 * skills and tools behind it. */
export type AgentProviderProps = ProviderProps & { s2s?: S2sDescriptor };

/** A scaffold placeholder create-curb.js was supposed to replace, e.g. `{{AGENT_MODEL}}`. */
const PLACEHOLDER = /\{\{\s*[A-Z0-9_]+\s*\}\}/;

/**
 * Refuse a model id that is empty or still a scaffold placeholder.
 *
 * WHY HERE. The id is identity-bearing: left as `{{AGENT_MODEL}}` it type-checks, bundles,
 * deploys, joins a room and fails on the first live turn as `not_found_error`. The factory
 * runs when the agent tree renders, which every host (dev server, `curb check`, `curb
 * build`'s render check, the hosted runner) does before a call, so the mistake surfaces
 * there instead of in a container log.
 */
function modelId(factory: string, model: string): string {
  if (typeof model !== "string" || model.trim() === "") {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: `${factory}() needs a model id, got ${JSON.stringify(model)}.`,
      location: { source: "src/agent/agent.tsx", component: factory },
      fix: `Pass the model id, for example ${factory}("claude-haiku-4-5").`,
    });
  }
  if (PLACEHOLDER.test(model)) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.scaffoldPlaceholder,
      severity: "error",
      message: `${factory}(${JSON.stringify(model)}) still holds a scaffold placeholder, so the model names nothing real.`,
      location: { source: "src/agent/agent.tsx", component: factory },
      fix:
        `Replace ${JSON.stringify(model)} with a real model id like "claude-haiku-4-5". ` +
        "Projects created with `npm create curb.js` get this substituted during scaffolding; " +
        "a project copied out of templates/default does not.",
    });
  }
  return model;
}

/** Drop undefined options so equal settings compare and serialize equal. */
function defined<T extends object>(options: T | undefined): T {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as T;
}

export const kugelaudio = {
  /** KugelAudio's EU-hosted LLM. Key: `KUGELAUDIO_API_KEY`; endpoint: `KUGELAUDIO_API_BASE`,
   * else https://api.eu.kugelaudio.com. */
  llm: (options?: KugelaudioLlmOptions): LlmDescriptor => {
    const model = options?.model ?? DEFAULT_KUGELAUDIO_LLM_MODEL;
    if (!KUGELAUDIO_LLM_MODELS.includes(model)) {
      throw new AgentAuthoringError({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
        severity: "error",
        message: `kugelaudio.llm() got model ${JSON.stringify(model)}, which KugelAudio does not serve.`,
        location: { source: "src/agent/agent.tsx", component: "kugelaudio.llm" },
        fix:
          `Use one of ${KUGELAUDIO_LLM_MODELS.map((id) => JSON.stringify(id)).join(", ")}, or leave model unset ` +
          `for ${JSON.stringify(DEFAULT_KUGELAUDIO_LLM_MODEL)}.`,
      });
    }
    return { provider: "kugelaudio", kind: "llm", options: { model } };
  },
  tts: (options?: KugelaudioTtsOptions): TtsDescriptor => ({
    provider: "kugelaudio",
    kind: "tts",
    options: defined(options),
  }),
  stt: (options?: KugelaudioSttOptions): SttDescriptor => ({
    provider: "kugelaudio",
    kind: "stt",
    options: defined(options),
  }),
};

export const azure = {
  stt: (options?: AzureSttOptions): SttDescriptor => ({
    provider: "azure",
    kind: "stt",
    options: defined(options),
  }),
};

export const deepgram = {
  stt: (options?: DeepgramSttOptions): SttDescriptor => ({
    provider: "deepgram",
    kind: "stt",
    options: defined(options),
  }),
};

export const elevenlabs = {
  tts: (options?: ElevenlabsTtsOptions): TtsDescriptor => ({
    provider: "elevenlabs",
    kind: "tts",
    options: defined(options),
  }),
  stt: (options?: ElevenlabsSttOptions): SttDescriptor => ({
    provider: "elevenlabs",
    kind: "stt",
    options: defined(options),
  }),
};

export const cartesia = {
  tts: (options?: CartesiaTtsOptions): TtsDescriptor => ({
    provider: "cartesia",
    kind: "tts",
    options: defined(options),
  }),
};

/** Anthropic Claude as the agent's LLM. Key: `ANTHROPIC_API_KEY`. */
export function anthropic(model: string): LlmDescriptor {
  return { provider: "anthropic", kind: "llm", options: { model: modelId("anthropic", model) } };
}

/** OpenAI: `openai(model)` is the LLM; `openai.tts()` / `openai.stt()` the speech
 * providers. Key: `OPENAI_API_KEY`. */
export const openai = Object.assign(
  (model: string): LlmDescriptor => ({
    provider: "openai",
    kind: "llm",
    options: { model: modelId("openai", model) },
  }),
  {
    tts: (options?: OpenaiTtsOptions): TtsDescriptor => ({
      provider: "openai",
      kind: "tts",
      options: defined(options),
    }),
    stt: (options?: OpenaiSttOptions): SttDescriptor => ({
      provider: "openai",
      kind: "stt",
      options: defined(options),
    }),
    /** OpenAI Live as the agent's voice (`<Agent s2s>`). */
    live: (options?: OpenaiS2sOptions): S2sDescriptor => ({
      provider: "openai",
      kind: "s2s",
      protocol: "live",
      options: { model: "gpt-live-1", ...defined(options) },
    }),
    /** OpenAI Realtime as the agent's voice (`<Agent s2s>`). */
    realtime: (options?: Omit<OpenaiS2sOptions, "verbatim">): S2sDescriptor => ({
      provider: "openai",
      kind: "s2s",
      protocol: "realtime",
      options: defined(options ?? {}),
    }),
  },
);

/** Any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, …) as the agent's LLM. */
export function openaiCompatible(options: OpenaiCompatibleOptions): LlmDescriptor {
  if (typeof options?.baseURL !== "string" || options.baseURL.trim() === "") {
    refuseOption(
      `openaiCompatible() needs a baseURL, got ${JSON.stringify(options?.baseURL)}.`,
      'Pass the endpoint, for example openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" }).',
    );
  }
  const { reasoningEffort, temperature, topP } = options;
  if (reasoningEffort !== undefined && !REASONING_EFFORTS.includes(reasoningEffort)) {
    refuseOption(
      `openaiCompatible() got reasoningEffort ${JSON.stringify(reasoningEffort)}, which is not a reasoning_effort value.`,
      `Use one of ${REASONING_EFFORTS.map((value) => JSON.stringify(value)).join(", ")}; "none" switches thinking ` +
        "off where the endpoint supports it. The endpoint's documentation lists the values each model takes.",
    );
  }
  if (temperature !== undefined && !(typeof temperature === "number" && temperature >= 0 && temperature <= 2)) {
    refuseOption(
      `openaiCompatible() got temperature ${String(temperature)}, outside 0 to 2.`,
      "Pass a number from 0 to 2, for example temperature: 0.7, or leave it unset for the endpoint's default.",
    );
  }
  if (topP !== undefined && !(typeof topP === "number" && topP > 0 && topP <= 1)) {
    refuseOption(
      `openaiCompatible() got topP ${String(topP)}, outside the range above 0 up to 1.`,
      "Pass a number above 0 and at most 1, for example topP: 0.8, or leave it unset for the endpoint's default.",
    );
  }
  return {
    provider: "openai-compatible",
    kind: "llm",
    options: defined({
      baseURL: options.baseURL,
      model: modelId("openaiCompatible", options.model),
      reasoningEffort,
      temperature,
      topP,
      body: requestBody(options.body),
    }),
  };
}

/**
 * Request fields Curb or the AI SDK write themselves, with what sets each. A copy in `body`
 * would not be sent as written: `@ai-sdk/openai-compatible` spreads the extra fields after
 * `model`, `temperature` and `top_p` (so they would override the descriptor) and before
 * `reasoning_effort`, `verbosity`, `messages` and the tools (so they would be dropped), reads
 * its camelCase options itself, and sets `stream` per call.
 */
const RESERVED_BODY_FIELDS: Readonly<Record<string, string>> = {
  model: "the `model` option",
  messages: "Curb, from the conversation",
  tools: "Curb, from the tools the agent renders",
  tool_choice: "Curb",
  stream: "Curb",
  stream_options: "Curb",
  temperature: "the `temperature` option",
  top_p: "the `topP` option",
  reasoning_effort: "the `reasoningEffort` option",
  reasoningEffort: "the `reasoningEffort` option",
  verbosity: "the AI SDK",
  textVerbosity: "the AI SDK",
  strictJsonSchema: "the AI SDK",
};

/** The descriptor's `body`: a plain object of JSON fields, none of them reserved. Unset
 * fields are dropped and an empty body is no body, so equal requests compare equal. */
function requestBody(body: unknown): Record<string, JsonValue> | undefined {
  if (body === undefined) return undefined;
  if (!isPlainObject(body)) {
    refuseOption(
      `openaiCompatible() got body ${Array.isArray(body) ? "as an array" : JSON.stringify(body)}; it is an object of extra request fields.`,
      "Pass the fields the endpoint accepts as an object, for example body: { top_k: 20 }.",
    );
  }
  const fields = defined(body);
  for (const [key, value] of Object.entries(fields)) {
    const owner = Object.prototype.hasOwnProperty.call(RESERVED_BODY_FIELDS, key) ? RESERVED_BODY_FIELDS[key] : undefined;
    if (owner !== undefined) {
      refuseOption(
        `openaiCompatible() got body.${key}, a request field that ${owner} sets.`,
        owner.startsWith("the `")
          ? `Remove ${key} from body and use ${owner} instead.`
          : `Remove ${key} from body; ${owner} writes that field itself, so a value here would not reach the endpoint as written.`,
      );
    }
    const path = nonJsonPath(value, `body.${key}`);
    if (path !== null) {
      refuseOption(
        `openaiCompatible() got ${path}, which is not a JSON value, so it cannot be sent to the endpoint.`,
        "Use strings, finite numbers, booleans, null, arrays and plain objects in body.",
      );
    }
  }
  return Object.keys(fields).length > 0 ? (fields as Record<string, JsonValue>) : undefined;
}

/** The path of the first value under `value` that JSON cannot carry unchanged, or null. */
function nonJsonPath(value: unknown, path: string): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const inner = nonJsonPath(item, `${path}[${index}]`);
      if (inner !== null) return inner;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const inner = nonJsonPath(item, `${path}.${key}`);
      if (inner !== null) return inner;
    }
    return null;
  }
  return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function refuseOption(message: string, fix: string): never {
  throw new AgentAuthoringError({
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message,
    location: { source: "src/agent/agent.tsx", component: "openaiCompatible" },
    fix,
  });
}
