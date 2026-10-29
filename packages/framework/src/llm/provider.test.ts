import { describe, expect, it } from "vitest";
import { anthropic, kugelaudio, openai, openaiCompatible, type LlmDescriptor } from "../providers.js";
import { LlmProviderConfigError, resolveLlmProvider } from "./provider.js";

describe("resolveLlmProvider", () => {
  it("kugelaudio requires KUGELAUDIO_API_KEY, naming it and where a hosted agent gets it", () => {
    expect(() => resolveLlmProvider(kugelaudio.llm(), {})).toThrow(LlmProviderConfigError);
    expect(() => resolveLlmProvider(kugelaudio.llm(), { KUGELAUDIO_API_KEY: " " })).toThrow(
      /needs KUGELAUDIO_API_KEY .*A hosted agent gets it from the platform\./,
    );
  });

  it("kugelaudio is served at the EU ingress, or at KUGELAUDIO_API_BASE, plus /v1", () => {
    expect(resolveLlmProvider(kugelaudio.llm(), { KUGELAUDIO_API_KEY: "k" })).toEqual({
      kind: "kugelaudio",
      model: "qwen3.8-27b",
      baseUrl: "https://api.eu.kugelaudio.com/v1",
      apiKey: "k",
    });
    const staging = { KUGELAUDIO_API_KEY: "k", KUGELAUDIO_API_BASE: " https://staging.example/ " };
    expect(resolveLlmProvider(kugelaudio.llm({ model: "mistral-medium-3.5-128b" }), staging)).toEqual({
      kind: "kugelaudio",
      model: "mistral-medium-3.5-128b",
      baseUrl: "https://staging.example/v1",
      apiKey: "k",
    });
  });

  it("anthropic carries the descriptor's model; its key is resolved by the transport", () => {
    expect(resolveLlmProvider(anthropic("claude-sonnet-5"), {})).toEqual({
      kind: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("openai requires OPENAI_API_KEY and names it when missing", () => {
    expect(() => resolveLlmProvider(openai("gpt-5.2"), {})).toThrow(LlmProviderConfigError);
    expect(() => resolveLlmProvider(openai("gpt-5.2"), {})).toThrow(/OPENAI_API_KEY/);
    expect(resolveLlmProvider(openai("gpt-5.2"), { OPENAI_API_KEY: "sk-x" })).toEqual({
      kind: "openai",
      model: "gpt-5.2",
      apiKey: "sk-x",
    });
  });

  it("openai-compatible takes its base URL from the descriptor and treats the key as optional", () => {
    expect(
      resolveLlmProvider(openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "llama3.3" }), {}),
    ).toEqual({
      kind: "openai-compatible",
      model: "llama3.3",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: undefined,
    });
  });

  it("openai-compatible reads AGENT_LLM_API_KEY, falling back to OPENAI_API_KEY for proxy endpoints", () => {
    const descriptor = openaiCompatible({ baseURL: "https://openrouter.ai/api/v1", model: "x" });
    expect(resolveLlmProvider(descriptor, { OPENAI_API_KEY: "sk-proxy" })).toMatchObject({
      apiKey: "sk-proxy",
    });
    expect(
      resolveLlmProvider(descriptor, { AGENT_LLM_API_KEY: "sk-own", OPENAI_API_KEY: "sk-proxy" }),
    ).toMatchObject({ apiKey: "sk-own" });
  });

  it("rejects an unknown provider by name", () => {
    const bogus = { provider: "gemini", kind: "llm", options: { model: "g" } } as unknown as LlmDescriptor;
    expect(() => resolveLlmProvider(bogus, {})).toThrow(/Unknown llm provider "gemini"/);
  });
});
