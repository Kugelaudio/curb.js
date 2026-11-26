import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLlmClient, AgentLlmStreamStep } from "./agent-session.js";
import { ProviderError, Throttle } from "./llm/resilience.js";
import type { AgentRunRequest, AgentRunResponse } from "./llm/types.js";
import { LIVE_RATE_LIMIT_PATIENCE_MS, createVoiceAgentBundle, liveTransportWrap, type LlmTransportOptions } from "./voice-host.js";

/**
 * A live call's turn (a cascaded call's, or a speech model's back office) used to end in the
 * fallback line the first time the provider's rate limit outlasted the SDK's two quick retries.
 * Live bundles now wait out a short burst of 429s, for seconds, as `curb test` does for minutes.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The provider behind every live bundle of this file: rate limited `limits` times, then answering. */
const provider = vi.hoisted(() => ({ limits: 0, calls: 0, retryAfterMs: 10, maxRetries: [] as Array<number | undefined> }));

vi.mock("./llm/ai-sdk.js", async (original) => {
  const actual = await original<typeof import("./llm/ai-sdk.js")>();
  const answer = () => {
    provider.calls += 1;
    if (provider.calls <= provider.limits) {
      throw Object.assign(new Error("Too many LLM requests for this organization"), {
        statusCode: 429,
        responseHeaders: { "retry-after-ms": String(provider.retryAfterMs) },
      });
    }
    return { text: "Gern, ich schaue nach.", toolCalls: [] };
  };
  return {
    ...actual,
    runAiSdkAgent: async (_request: unknown, options: { maxRetries?: number }) => {
      provider.maxRetries.push(options.maxRetries);
      return answer();
    },
    streamAiSdkAgent: async function* (_request: unknown, options: { maxRetries?: number }) {
      provider.maxRetries.push(options.maxRetries);
      const response = answer();
      yield { delta: response.text, text: response.text };
      return response;
    },
  };
});

/** What the AI SDK throws for a 429: the status and the response headers on the error. */
function rateLimited(retryAfterMs?: number): Error {
  return Object.assign(new Error("Too many LLM requests for this organization"), {
    statusCode: 429,
    responseHeaders: retryAfterMs === undefined ? {} : { "retry-after-ms": String(retryAfterMs) },
    isRetryable: true,
  });
}

const ANSWER: AgentRunResponse = { text: "Gern, ich schaue nach.", toolCalls: [] };

/** Transports that are rate limited `limits` times, then answer. */
function limitedTransports(limits: number, retryAfterMs?: number) {
  let calls = 0;
  const options: LlmTransportOptions[] = [];
  const llm: AgentLlmClient = async () => {
    calls += 1;
    if (calls <= limits) throw rateLimited(retryAfterMs);
    return ANSWER;
  };
  const streamLlm: AgentLlmStreamStep = async function* () {
    calls += 1;
    if (calls <= limits) throw rateLimited(retryAfterMs);
    yield { delta: ANSWER.text, text: ANSWER.text };
    return ANSWER;
  };
  return {
    transports: (given: LlmTransportOptions = {}) => {
      options.push(given);
      return { llm, streamLlm };
    },
    calls: () => calls,
    options,
  };
}

const request = { messages: [], stateSnapshot: [], systemPrompt: "", tools: [] } as unknown as AgentRunRequest;
const waits: number[] = [];
/** A clock that only waiting moves, so a test waits for nothing. */
function fakeTime() {
  let now = 0;
  return {
    throttle: new Throttle(() => now),
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

describe("liveTransportWrap", () => {
  it("sends a rate-limited request again after the pause the provider asks for, with the SDK's own retries off", async () => {
    waits.length = 0;
    const fake = limitedTransports(2, 1200);

    const { llm } = liveTransportWrap(fakeTime())(fake.transports);

    await expect(llm(request)).resolves.toEqual(ANSWER);
    expect(fake.calls()).toBe(3);
    expect(fake.options).toEqual([{ maxRetries: 0 }]);
    expect(waits.filter((ms) => ms > 0)).toEqual([1200, 1200]);
  });

  it("does the same for a streamed step that was refused before its first word", async () => {
    const fake = limitedTransports(2);

    const { streamLlm } = liveTransportWrap({ ...fakeTime(), random: () => 0.5 })(fake.transports);
    const step = streamLlm(request);
    const parts = [];
    let next = await step.next();
    while (!next.done) {
      parts.push(next.value);
      next = await step.next();
    }

    expect(next.value).toEqual(ANSWER);
    expect(parts).toEqual([{ delta: ANSWER.text, text: ANSWER.text }]);
    expect(fake.calls()).toBe(3);
  });

  it("gives up at once when the provider asks for a longer pause than a caller can wait", async () => {
    const fake = limitedTransports(1, LIVE_RATE_LIMIT_PATIENCE_MS + 5_000);

    const { llm } = liveTransportWrap(fakeTime())(fake.transports);

    await expect(llm(request)).rejects.toBeInstanceOf(ProviderError);
    await expect(liveTransportWrap(fakeTime())(limitedTransports(1, LIVE_RATE_LIMIT_PATIENCE_MS + 5_000).transports).llm(request)).rejects.toThrow(
      /still rate limited/,
    );
    expect(fake.calls()).toBe(1);
  });
});

describe("a live bundle's turn", () => {
  it("answers after a burst of rate limits instead of saying the fallback line, with no wrap from the host", async () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "test-kugel-key");
    provider.limits = 2;
    provider.calls = 0;
    provider.maxRetries = [];
    // No wrap: what the dev server, a hosted runner and a direct join build.
    const { session } = await createVoiceAgentBundle();

    const errors: string[] = [];
    const reply = await session.runTurn("Hallo, ich habe eine Frage.", { kind: "synthetic" }, (event) => {
      if (event.type === "error") errors.push(event.error.kind);
    });

    expect(errors).toEqual([]);
    expect(reply).toContain(ANSWER.text);
    expect(provider.calls).toBe(3);
    expect(new Set(provider.maxRetries)).toEqual(new Set([0]));
  });

  it("still ends the turn in the fallback line when the limit outlasts what a caller can wait", async () => {
    vi.stubEnv("KUGELAUDIO_API_KEY", "test-kugel-key");
    provider.limits = 99;
    provider.calls = 0;
    provider.retryAfterMs = LIVE_RATE_LIMIT_PATIENCE_MS + 5_000;
    const { session } = await createVoiceAgentBundle();

    const errors: string[] = [];
    await session.runTurn("Hallo?", { kind: "synthetic" }, (event) => {
      if (event.type === "error") errors.push(event.error.kind);
    });

    expect(errors).toEqual(["failed"]);
    // One request per attempt the session makes; none waited the 20 s the provider asked for.
    expect(provider.calls).toBeLessThanOrEqual(2);
    provider.retryAfterMs = 10;
  });
});
