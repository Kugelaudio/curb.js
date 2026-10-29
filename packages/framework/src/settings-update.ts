/**
 * Live session settings changed from OUTSIDE the agent: a client app (`curb.update` RPC,
 * `curb/client`'s `agent.update`) or the host (`PATCH /v1/sessions/{id}`).
 *
 *   <Agent adjustable={{ client: ["tts.voice"], host: ["tts.voice", "llm"] }}>
 *
 * DENY BY DEFAULT. Only the paths `adjustable` lists for the sender's origin may change;
 * an update that touches any other path is refused `not_adjustable` as a whole. An update
 * is ATOMIC: it is checked completely before anything changes, so a refusal leaves the
 * call exactly as it was.
 *
 * An accepted change is an OVERRIDE: it sits above the `<Agent>` / `<Skill>` props until the
 * next outside change of the same path, and the props stay the base underneath it.
 *
 * Pure and browser-safe: the schemas here are also the host protocol's (`hosted/protocol.ts`)
 * and the types are `curb/client`'s.
 */

import { z } from "zod";
import { AgentAuthoringError } from "./authoring.js";
import type { MessageIssue } from "./messages.js";
import {
  anthropic,
  defaultKugelVoice,
  kugelaudio,
  openai,
  openaiCompatible,
  type KugelaudioLlmModel,
  type LlmDescriptor,
  type SttDescriptor,
  type TtsDescriptor,
} from "./providers.js";

/** Every setting an outside party can be allowed to change. */
export const ADJUSTABLE_PATHS = ["tts.voice", "tts.model", "stt.language", "llm"] as const;
export const AdjustablePath = z.enum(ADJUSTABLE_PATHS);
export type AdjustablePath = z.infer<typeof AdjustablePath>;

/** Who sent an update. Stamped by the transport: RPC is `client`, the host protocol `host`. */
export type SettingsOrigin = "client" | "host";

/** `<Agent adjustable>`: which paths each origin may change. Absent means none. */
export type Adjustable = {
  client?: readonly AdjustablePath[];
  host?: readonly AdjustablePath[];
};

const voiceId = z.union([z.string().min(1), z.number().int().nonnegative()]);

/** The body of `curb.update` and `PATCH /v1/sessions/{id}`. */
export const SessionUpdate = z.object({
  tts: z
    .object({
      /** A voice id: a number for `kugelaudio`, a string for the other TTS providers. */
      voice: voiceId.optional(),
      model: z.string().min(1).optional(),
    })
    .optional(),
  stt: z.object({ language: z.string().min(1).optional() }).optional(),
  llm: z
    .object({
      /** `kugelaudio`, `anthropic`, `openai` or `openai-compatible`. */
      provider: z.string().min(1),
      model: z.string().min(1),
      /** `openai-compatible` only. */
      baseURL: z.string().min(1).optional(),
    })
    .optional(),
});
export type SessionUpdate = z.infer<typeof SessionUpdate>;

/** What a call runs on after an update. Never carries a credential. */
export const EffectiveSettings = z.object({
  tts: z.object({
    provider: z.string().min(1),
    voice: voiceId.optional(),
    model: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
  }),
  stt: z.object({
    provider: z.string().min(1),
    language: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }),
  llm: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }),
});
export type EffectiveSettings = z.infer<typeof EffectiveSettings>;

/**
 * The override layer: one value per adjustable path. A TTS voice or model belongs to the
 * provider it was set for: a voice id of one vendor names nothing at another.
 */
export type SettingsOverrides = {
  "tts.voice"?: { provider: TtsDescriptor["provider"]; value: string | number };
  "tts.model"?: { provider: TtsDescriptor["provider"]; value: string };
  "stt.language"?: string;
  llm?: LlmDescriptor;
};

/**
 * The server's answer to "can this provider run here": the environment variable it needs and
 * does not have, or null. Injected (`SessionSettings.setCredentialCheck`), because this
 * module is browser-safe and cannot read the environment.
 */
export type CredentialCheck = (descriptor: LlmDescriptor | SttDescriptor | TtsDescriptor) => string | null;

/** The providers one conversation runs on. */
export type ProviderSettings = {
  llm: LlmDescriptor;
  stt: SttDescriptor;
  tts: TtsDescriptor;
};

export type SettingsRefusalCode = "not_adjustable" | "invalid_settings";

/**
 * An update was refused; nothing changed. The transport returns `code` to the sender: 403 /
 * 422 over the host protocol, RpcError 2005 / 2006 over LiveKit.
 */
export class SettingsRefusedError extends Error {
  readonly code: SettingsRefusalCode;
  readonly origin: SettingsOrigin;
  /** On `not_adjustable`: the first path the origin may not change. */
  readonly path: string | undefined;
  /** On `invalid_settings`: what is wrong, `path` into the update body. */
  readonly issues: MessageIssue[] | undefined;

  constructor(
    code: SettingsRefusalCode,
    origin: SettingsOrigin,
    detail: string,
    extra: { path?: string; issues?: MessageIssue[] } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = "SettingsRefusedError";
    this.code = code;
    this.origin = origin;
    this.path = extra.path;
    this.issues = extra.issues;
  }
}

const KNOWN_KEYS: Record<string, readonly string[]> = {
  "": ["tts", "stt", "llm"],
  tts: ["voice", "model"],
  stt: ["language"],
  llm: ["provider", "model", "baseURL"],
};

const LLM_PROVIDERS = ["kugelaudio", "anthropic", "openai", "openai-compatible"] as const;

/** STT providers whose descriptor takes a `language` option. */
const STT_WITH_LANGUAGE = new Set<SttDescriptor["provider"]>(["kugelaudio", "azure", "deepgram", "openai"]);

/**
 * Check one update against the gate and the providers it would change, and return the
 * overrides it sets. Throws {@link SettingsRefusedError}; never partially applies.
 *
 * `base` is what the props (or the defaults) say right now: an override changes an option of
 * the base provider, so a voice id is checked against the provider that will speak it.
 */
export function planSettingsUpdate(options: {
  body: unknown;
  origin: SettingsOrigin;
  adjustable: Adjustable;
  base: ProviderSettings;
  /** Refuses a provider switch the server holds no credential for. Absent: not checked. */
  credentials?: CredentialCheck;
}): SettingsOverrides {
  const { body, origin, adjustable, base } = options;
  const parsed = SessionUpdate.safeParse(body);
  if (!parsed.success) {
    throw invalid(origin, parsed.error.issues.map((issue) => ({
      path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
      message: issue.message,
    })));
  }
  const unknown = unknownKeys(body);
  if (unknown.length > 0) throw invalid(origin, unknown);

  const update = parsed.data;
  const touched: AdjustablePath[] = [];
  if (update.tts?.voice !== undefined) touched.push("tts.voice");
  if (update.tts?.model !== undefined) touched.push("tts.model");
  if (update.stt?.language !== undefined) touched.push("stt.language");
  if (update.llm !== undefined) touched.push("llm");

  const allowed = adjustable[origin] ?? [];
  const refused = touched.filter((path) => !allowed.includes(path));
  if (refused.length > 0) {
    throw new SettingsRefusedError(
      "not_adjustable",
      origin,
      `the ${origin} may not change ${refused.join(", ")}; <Agent adjustable> lets it change ` +
        (allowed.length === 0 ? "nothing" : allowed.join(", ")),
      { path: refused[0] },
    );
  }

  const issues: MessageIssue[] = [];
  const next: SettingsOverrides = {};
  if (update.tts?.voice !== undefined) {
    const voice = voiceFor(base.tts.provider, update.tts.voice);
    if (voice === undefined) {
      issues.push({
        path: ["tts", "voice"],
        message: `${base.tts.provider} voices are numeric ids, got ${JSON.stringify(update.tts.voice)}`,
      });
    } else {
      next["tts.voice"] = { provider: base.tts.provider, value: voice };
    }
  }
  if (update.tts?.model !== undefined) next["tts.model"] = { provider: base.tts.provider, value: update.tts.model };
  if (update.stt?.language !== undefined) {
    if (STT_WITH_LANGUAGE.has(base.stt.provider)) {
      next["stt.language"] = update.stt.language;
    } else {
      issues.push({
        path: ["stt", "language"],
        message: `the ${base.stt.provider} speech recognizer takes no language`,
      });
    }
  }
  if (update.llm !== undefined) {
    const llm = llmFor(update.llm, origin, base.llm, issues);
    // Only `llm` can change a provider; a voice or language change keeps the one the props
    // chose. Checked HERE so a switch that could never run is refused, not accepted and then
    // failing every turn after it.
    const missing = llm === undefined ? null : (options.credentials?.(llm) ?? null);
    if (missing !== null) {
      issues.push({
        path: ["llm", "provider"],
        message: `${update.llm.provider} needs ${missing}, which this server does not have`,
      });
    } else if (llm !== undefined) {
      next.llm = llm;
    }
  }
  if (issues.length > 0) throw invalid(origin, issues);
  return next;
}

/** The TTS overrides set for another provider than the one `base` speaks with now. */
export function staleTtsOverrides(
  base: ProviderSettings,
  overrides: SettingsOverrides,
): Array<"tts.voice" | "tts.model"> {
  return (["tts.voice", "tts.model"] as const).filter((path) => {
    const override = overrides[path];
    return override !== undefined && override.provider !== base.tts.provider;
  });
}

/**
 * The base providers with the overrides applied. A TTS override for another provider (see
 * {@link staleTtsOverrides}) is not applied.
 */
export function applySettingsOverrides(
  base: ProviderSettings,
  overrides: SettingsOverrides,
): ProviderSettings {
  let tts = base.tts;
  const voiceOverride = overrides["tts.voice"];
  const modelOverride = overrides["tts.model"];
  const voice = voiceOverride?.provider === tts.provider ? voiceFor(tts.provider, voiceOverride.value) : undefined;
  const model = modelOverride?.provider === tts.provider ? modelOverride.value : undefined;
  if (voice !== undefined || model !== undefined) {
    tts = {
      ...tts,
      options: {
        ...tts.options,
        ...(voice === undefined ? {} : { voice }),
        ...(model === undefined ? {} : { model }),
      },
    } as TtsDescriptor;
  }
  let stt = base.stt;
  if (overrides["stt.language"] !== undefined && STT_WITH_LANGUAGE.has(stt.provider)) {
    stt = { ...stt, options: { ...stt.options, language: overrides["stt.language"] } } as SttDescriptor;
  }
  return { llm: overrides.llm ?? base.llm, stt, tts };
}

/**
 * The wire view of what a call runs on: provider names and the adjustable options only. The
 * voice is the one that speaks: a `kugelaudio.tts()` without one reports its language's.
 */
export function effectiveSettings(settings: ProviderSettings): EffectiveSettings {
  const tts = settings.tts.options as { voice?: string | number; model?: string; language?: string };
  const stt = settings.stt.options as { language?: string; model?: string };
  const voice = settings.tts.provider === "kugelaudio" ? (tts.voice ?? defaultKugelVoice(tts.language)) : tts.voice;
  return {
    tts: {
      provider: settings.tts.provider,
      ...(voice === undefined ? {} : { voice }),
      ...(tts.model === undefined ? {} : { model: tts.model }),
      ...(tts.language === undefined ? {} : { language: tts.language }),
    },
    stt: {
      provider: settings.stt.provider,
      ...(stt.language === undefined ? {} : { language: stt.language }),
      ...(stt.model === undefined ? {} : { model: stt.model }),
    },
    llm: { provider: settings.llm.provider, model: settings.llm.options.model },
  };
}

/** A voice id in the type `provider` takes, or undefined when it cannot be one. */
function voiceFor(provider: TtsDescriptor["provider"], voice: string | number): string | number | undefined {
  if (provider !== "kugelaudio") return String(voice);
  if (typeof voice === "number") return voice;
  return /^\d+$/.test(voice) ? Number(voice) : undefined;
}

function llmFor(
  update: NonNullable<SessionUpdate["llm"]>,
  origin: SettingsOrigin,
  base: LlmDescriptor,
  issues: MessageIssue[],
): LlmDescriptor | undefined {
  const provider = update.provider as (typeof LLM_PROVIDERS)[number];
  if (!LLM_PROVIDERS.includes(provider)) {
    issues.push({
      path: ["llm", "provider"],
      message: `unknown llm provider ${JSON.stringify(update.provider)}; use one of ${LLM_PROVIDERS.join(", ")}`,
    });
    return undefined;
  }
  if (provider !== "openai-compatible" && update.baseURL !== undefined) {
    issues.push({ path: ["llm", "baseURL"], message: `only openai-compatible takes a baseURL, not ${provider}` });
    return undefined;
  }
  const ownBaseURL = base.provider === "openai-compatible" ? base.options.baseURL : undefined;
  if (provider === "openai-compatible") {
    const baseURL = update.baseURL ?? ownBaseURL;
    if (baseURL === undefined) {
      issues.push({ path: ["llm", "baseURL"], message: "openai-compatible needs a baseURL" });
      return undefined;
    }
    // The endpoint receives the agent's LLM key. A caller's app must not be able to send it
    // somewhere the agent's author did not point it.
    if (origin === "client" && baseURL !== ownBaseURL) {
      issues.push({
        path: ["llm", "baseURL"],
        message: "a client may not point the LLM at an endpoint the agent does not already use",
      });
      return undefined;
    }
    if (!isHttpUrl(baseURL)) {
      issues.push({ path: ["llm", "baseURL"], message: `${JSON.stringify(baseURL)} is not an http(s) URL` });
      return undefined;
    }
  }
  try {
    if (provider === "kugelaudio") return kugelaudio.llm({ model: update.model as KugelaudioLlmModel });
    if (provider === "anthropic") return anthropic(update.model);
    if (provider === "openai") return openai(update.model);
    const baseURL = (update.baseURL ?? ownBaseURL)!;
    // The author's request options (thinking off, sampling, extra fields) belong to their
    // endpoint: another model there keeps them, another endpoint starts without them.
    const ownOptions = base.provider === "openai-compatible" && base.options.baseURL === baseURL ? base.options : {};
    return openaiCompatible({ ...ownOptions, baseURL, model: update.model });
  } catch (error) {
    if (!(error instanceof AgentAuthoringError)) throw error;
    issues.push({ path: ["llm", "model"], message: error.diagnostic.message });
    return undefined;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Keys the update schema does not know: a typo must not be accepted as a no-op. */
function unknownKeys(body: unknown): MessageIssue[] {
  const issues: MessageIssue[] = [];
  const visit = (value: unknown, at: string[]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const known = KNOWN_KEYS[at.join(".")];
    if (known === undefined) return;
    for (const [key, child] of Object.entries(value)) {
      if (!known.includes(key)) {
        issues.push({
          path: [...at, key],
          message: `unknown setting; the adjustable paths are ${ADJUSTABLE_PATHS.join(", ")}`,
        });
        continue;
      }
      visit(child, [...at, key]);
    }
  };
  visit(body, []);
  return issues;
}

function invalid(origin: SettingsOrigin, issues: MessageIssue[]): SettingsRefusedError {
  const detail = issues
    .map((issue) => `${issue.path.map(String).join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
  return new SettingsRefusedError("invalid_settings", origin, detail, { issues });
}
