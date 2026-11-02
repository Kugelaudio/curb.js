/**
 * Which environment variables each provider reads, and how: the one table the voice host
 * (`server/voice/providers.ts`), the LLM transport (`llm/provider.ts`, `llm/ai-sdk.ts`) and
 * `curb check` read. It imports nothing at runtime, so `curb check` names the variables
 * without loading LiveKit or the AI SDK. An empty value counts as unset everywhere.
 */

import type { LlmProviderId, SttProviderId, TtsProviderId } from "./providers.js";

export type Env = Record<string, string | undefined>;

/** A variable a provider reads: the name a fix sets, and the value as the provider gets it. */
export type ProviderVariable = {
  name: string;
  /** Trimmed; undefined when unset or empty. */
  read: (env: Env) => string | undefined;
  /** False when the provider runs without it. */
  required: boolean;
};

/** What one provider reads: its key, and the variables it reads besides. */
export type ProviderKeys = { key: ProviderVariable; also?: readonly ProviderVariable[] };

const variable = (name: string, required = true): ProviderVariable => ({
  name,
  required,
  read: (env) => env[name]?.trim() || undefined,
});

export const OPENAI_API_KEY = variable("OPENAI_API_KEY");
const KUGELAUDIO_API_KEY = variable("KUGELAUDIO_API_KEY");

/** What the hosting platform provisions for every hosted agent of an organisation: setting
 * them is refused (or pointless), and a hosted agent needs none of them pushed. */
export const PLATFORM_PROVIDED: ReadonlySet<string> = new Set(["KUGELAUDIO_API_KEY", "KUGELAUDIO_API_BASE"]);

/** What to do about a missing KUGELAUDIO_API_KEY in a hosted workspace, which supplies it beside
 * its platform token (`CURB_PLATFORM_TOKEN_FILE`, cli/cloud/host-model-key.ts); null elsewhere. */
export function hostKeyPendingFix(env: Env): string | null {
  return env.CURB_PLATFORM_TOKEN_FILE?.trim()
    ? "This workspace supplies KUGELAUDIO_API_KEY itself and has not issued it yet (it does once the workspace " +
        "runs). Wait a minute and run the command again; nothing needs to be set, and never ask the user for a key."
    : null;
}

/** Where `kugelaudio.llm()` is served when `KUGELAUDIO_API_BASE` is unset: the EU ingress, the
 * only one that serves the LLM. */
export const DEFAULT_KUGELAUDIO_LLM_BASE = "https://api.eu.kugelaudio.com";

/** The OpenAI-compatible base URL of `kugelaudio.llm()`: `KUGELAUDIO_API_BASE` (else the EU
 * ingress) plus `/v1`. */
export function kugelaudioLlmBaseUrl(env: Env): string {
  return `${(env.KUGELAUDIO_API_BASE?.trim() || DEFAULT_KUGELAUDIO_LLM_BASE).replace(/\/+$/, "")}/v1`;
}

export const LLM_KEYS: Record<LlmProviderId, ProviderKeys> = {
  kugelaudio: { key: KUGELAUDIO_API_KEY },
  // ai-sdk.ts also finds it in a local secrets file.
  anthropic: { key: variable("ANTHROPIC_API_KEY") },
  openai: { key: OPENAI_API_KEY },
  // A local endpoint (Ollama, vLLM) takes no key; a hosted one gets this one, else OPENAI_API_KEY.
  "openai-compatible": {
    key: {
      name: "AGENT_LLM_API_KEY",
      required: false,
      read: (env) => env.AGENT_LLM_API_KEY?.trim() || OPENAI_API_KEY.read(env),
    },
  },
};

export const SPEECH_KEYS: Record<SttProviderId | TtsProviderId, ProviderKeys> = {
  // The region is azure.stt({ region }), else AZURE_SPEECH_REGION, else eastus.
  azure: { key: variable("AZURE_SPEECH_KEY"), also: [variable("AZURE_SPEECH_REGION", false)] },
  deepgram: { key: variable("DEEPGRAM_API_KEY") },
  // ElevenLabs' canonical env var is ELEVEN_API_KEY; the spelled-out variant people guess
  // first is accepted too, and whichever exists is passed explicitly.
  elevenlabs: {
    key: {
      name: "ELEVEN_API_KEY",
      required: true,
      read: (env) => env.ELEVEN_API_KEY?.trim() || env.ELEVENLABS_API_KEY?.trim() || undefined,
    },
  },
  openai: { key: OPENAI_API_KEY },
  kugelaudio: { key: KUGELAUDIO_API_KEY },
  cartesia: { key: variable("CARTESIA_API_KEY") },
};
