/**
 * LLM provider resolution for the agent brain: the `llm` descriptor from the tree
 * (`<Agent llm={kugelaudio.llm()}>`, see `curb/providers`) plus the credential from the
 * environment, read through the table in `provider-keys.ts`. Read per turn, so a changed prop
 * applies to the next turn.
 *
 *   kugelaudio.llm({ model? })        KUGELAUDIO_API_KEY, at KUGELAUDIO_API_BASE (else the EU
 *                                     ingress) + /v1
 *   anthropic(model)                  ANTHROPIC_API_KEY (resolved in ai-sdk.ts)
 *   openai(model)                     OPENAI_API_KEY
 *   openaiCompatible({ baseURL, model, reasoningEffort?, temperature?, topP?, body? })
 *                                     AGENT_LLM_API_KEY, else OPENAI_API_KEY, else none
 *                                     (a local Ollama/vLLM endpoint needs no key)
 */

import { kugelaudioLlmBaseUrl, LLM_KEYS } from "../provider-keys.js";
import type { LlmDescriptor, OpenaiCompatibleOptions } from "../providers.js";

export type LlmProviderConfig =
  | { kind: "kugelaudio"; model: string; baseUrl: string; apiKey: string }
  | { kind: "anthropic"; model: string }
  | { kind: "openai"; model: string; apiKey: string }
  | ({ kind: "openai-compatible"; model: string; baseUrl: string; apiKey: string | undefined } & Omit<
      OpenaiCompatibleOptions,
      "baseURL" | "model"
    >);

export class LlmProviderConfigError extends Error {}

/** Descriptor + env → the transport config. A missing key for the chosen provider raises. */
export function resolveLlmProvider(
  descriptor: LlmDescriptor,
  env: Record<string, string | undefined> = process.env,
): LlmProviderConfig {
  switch (descriptor.provider) {
    case "kugelaudio": {
      const { key } = LLM_KEYS.kugelaudio;
      const apiKey = key.read(env);
      if (!apiKey) {
        throw new LlmProviderConfigError(
          `The agent's llm is kugelaudio.llm({ model: "${descriptor.options.model}" }), which needs ${key.name} ` +
            "in the project .env (see .env.example). A hosted agent gets it from the platform.",
        );
      }
      // Thinking is off on the service's side, so nothing beyond the conversation is sent.
      return { kind: "kugelaudio", model: descriptor.options.model, baseUrl: kugelaudioLlmBaseUrl(env), apiKey };
    }
    case "anthropic":
      return { kind: "anthropic", model: descriptor.options.model };
    case "openai": {
      const { key } = LLM_KEYS.openai;
      const apiKey = key.read(env);
      if (!apiKey) {
        throw new LlmProviderConfigError(
          `The agent's llm is openai("${descriptor.options.model}"), which needs ${key.name} ` +
            "in the project .env (see .env.example).",
        );
      }
      return { kind: "openai", model: descriptor.options.model, apiKey };
    }
    case "openai-compatible": {
      // The request options (reasoningEffort, sampling, body) ride along to the transport.
      const { baseURL, model, ...request } = descriptor.options;
      return {
        kind: "openai-compatible",
        model,
        baseUrl: baseURL,
        apiKey: LLM_KEYS["openai-compatible"].key.read(env),
        ...request,
      };
    }
    default: {
      const unknown: { provider?: unknown } = descriptor;
      throw new LlmProviderConfigError(
        `Unknown llm provider ${JSON.stringify(unknown.provider)}. Build the llm prop with ` +
          'kugelaudio.llm(), anthropic(), openai() or openaiCompatible() from "curb/providers".',
      );
    }
  }
}
