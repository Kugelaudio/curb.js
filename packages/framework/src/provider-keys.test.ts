import { describe, expect, it } from "vitest";
import { keyPageSentence, kugelaudioLlmBaseUrl, kugelaudioSpeechBase, LLM_KEYS } from "./provider-keys.js";

describe("KugelAudio base URLs", () => {
  it("default to the speech API and the EU LLM ingress", () => {
    expect(kugelaudioSpeechBase({})).toBe("https://api.kugelaudio.com");
    expect(kugelaudioLlmBaseUrl({})).toBe("https://api.eu.kugelaudio.com/v1");
  });

  it("take KUGELAUDIO_API_BASE without its surrounding space or trailing slashes", () => {
    const env = { KUGELAUDIO_API_BASE: " https://kugel.example/// " };
    expect(kugelaudioSpeechBase(env)).toBe("https://kugel.example");
    expect(kugelaudioLlmBaseUrl(env)).toBe("https://kugel.example/v1");
  });

  it("trim a long run of slashes in linear time", () => {
    const started = Date.now();
    expect(kugelaudioSpeechBase({ KUGELAUDIO_API_BASE: `https://kugel.example${"/".repeat(100_000)}x` })).toMatch(/x$/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("count an empty value as unset", () => {
    expect(kugelaudioSpeechBase({ KUGELAUDIO_API_BASE: "  " })).toBe("https://api.kugelaudio.com");
  });
});

describe("where a missing key comes from", () => {
  it("names the provider's page for OpenAI and Anthropic", () => {
    expect(keyPageSentence(LLM_KEYS.openai.key)).toBe("Get a key at https://platform.openai.com/api-keys. ");
    expect(keyPageSentence(LLM_KEYS.anthropic.key)).toBe("Get a key at https://platform.claude.com/settings/keys. ");
  });

  it("says nothing for a key with no page: the sign-in, or an endpoint of the project's own", () => {
    expect(keyPageSentence(LLM_KEYS.kugelaudio.key)).toBe("");
    expect(keyPageSentence(LLM_KEYS["openai-compatible"].key)).toBe("");
  });
});
