import { describe, expect, it, vi } from "vitest";
import type { AgentLlmClient, AgentLlmStreamStep } from "../agent-session.js";
import type { AgentRunRequest } from "../llm/types.js";
import {
  ProviderError,
  Throttle,
  describeProviderError,
  providerFacts,
  redactSecrets,
  retryAfterMs,
  withRetries,
  withStreamRetries,
} from "./resilience.js";

const request: AgentRunRequest = { systemPrompt: "", skillTitle: "", stateSnapshot: [], tools: [], messages: [] };

/** An error as a provider SDK throws it: a status, the response's headers and its body. */
function apiError(statusCode: number, message: string, responseHeaders: Record<string, string> = {}) {
  return Object.assign(new Error(message), { statusCode, responseHeaders, responseBody: `{"error":"${message}","key":"sk-live-0123456789abcdef"}` });
}

/** A client that fails with each of `failures` in turn, then answers. */
function failing(failures: unknown[]) {
  const client = vi.fn<AgentLlmClient>(async () => {
    const failure = failures.shift();
    if (failure) throw failure;
    return { text: "Hello.", toolCalls: [] };
  });
  return client;
}

/** A clock that jumps ahead instead of waiting and keeps every pause it was asked for. */
function clock() {
  const pauses: number[] = [];
  let now = 0;
  const sleep = async (ms: number) => {
    pauses.push(Math.round(ms));
    now += ms;
  };
  return { pauses, sleep, random: () => 1, throttle: new Throttle(() => now), now: () => now };
}

describe("a rate limit", () => {
  it("is waited out for as long as the provider asks, then the request is sent again", async () => {
    const time = clock();
    const client = failing([apiError(429, "Rate limit reached", { "Retry-After": "7" }), apiError(503, "Overloaded", { "retry-after-ms": "250" })]);

    const response = await withRetries(client, time)(request);

    expect(response.text).toBe("Hello.");
    expect(client).toHaveBeenCalledTimes(3);
    // Seven seconds as asked; then a quarter second was asked, and the gap requests keep after
    // a rate limit (a second behind the one before) is longer.
    expect(time.pauses).toEqual([7000, 1000]);
    expect(time.throttle.stats()).toEqual({ waits: 2, waitedMs: 7250 });
  });

  it("does not use up the request's attempts: it is retried for minutes, with a growing pause when the provider names none", async () => {
    const time = clock();
    const client = failing(Array.from({ length: 7 }, () => apiError(429, "Too many requests")));

    const response = await withRetries(client, time)(request);

    expect(response.text).toBe("Hello.");
    expect(client).toHaveBeenCalledTimes(8);
    // Doubling from two seconds, up to the longest pause; seven refusals are no reason to give up.
    expect(time.pauses).toEqual([2000, 4000, 8000, 16_000, 32_000, 64_000, 120_000]);
  });

  it("fails the request once it has waited longer than its patience, and says how long", async () => {
    const time = clock();
    const onGiveUp = vi.fn();
    const client = failing(Array.from({ length: 50 }, () => apiError(429, "Too many requests for key sk-live-0123456789abcdef", { "retry-after": "60" })));

    const failure = await withRetries(client, { ...time, onGiveUp })(request).catch((error: unknown) => error);

    // Five minutes of waiting: the sixth minute is not started.
    expect(client).toHaveBeenCalledTimes(6);
    expect(time.now()).toBe(300_000);
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as Error).message).toBe("HTTP 429: Too many requests for key [redacted] (still rate limited after 300 s of waiting)");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("holds every request of the run back while one waits, and slows the run down once for a burst", async () => {
    const time = clock();
    const slowDown = vi.fn();
    time.throttle.onSlowDown(slowDown);
    const limit = () => apiError(429, "Rate limit reached", { "retry-after": "5" });
    // Three requests leave together and are refused together.
    const burst = [limit(), limit(), limit()].map((refusal) => withRetries(failing([refusal]), time));

    await Promise.all(burst.map((client) => client(request)));

    // One burst is one wait and one slow-down, however many requests it refused.
    expect(time.throttle.stats()).toEqual({ waits: 1, waitedMs: 5000 });
    expect(slowDown).toHaveBeenCalledOnce();
    // None is sent again before the pause is over, and then they go a second apart.
    expect(time.pauses).toEqual([5000, 1000, 1000]);
  });

  it("widens the gap between requests with each further burst, up to four seconds", async () => {
    const time = clock();
    const slowDown = vi.fn();
    time.throttle.onSlowDown(slowDown);
    const limit = () => apiError(429, "Rate limit reached", { "retry-after-ms": "100" });

    await withRetries(failing([limit(), limit(), limit(), limit()]), time)(request);
    expect(slowDown).toHaveBeenCalledTimes(4);
    time.pauses.length = 0;
    await withRetries(failing([]), time)(request);
    await withRetries(failing([]), time)(request);

    // Each request waits its turn behind the one before it.
    expect(time.pauses).toEqual([4000, 4000]);
  });
});

describe("other errors", () => {
  it("are tried a few times with a doubling pause, up to the longest one", async () => {
    const time = clock();
    const client = failing([apiError(500, "a"), apiError(502, "b"), Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })]);

    await withRetries(client, { ...time, baseDelayMs: 1000, maxDelayMs: 3000 })(request);

    expect(time.pauses).toEqual([1000, 2000, 3000]);
    // A server error is no rate limit: nothing is counted, and the run is not slowed down.
    expect(time.throttle.stats()).toEqual({ waits: 0, waitedMs: 0 });
  });

  it("fail the request after its attempts with a short error that carries neither the body nor a key", async () => {
    const time = clock();
    const onGiveUp = vi.fn();
    const client = failing(Array.from({ length: 4 }, () => apiError(500, "Internal error for key sk-live-0123456789abcdef")));

    const failure = await withRetries(client, { ...time, onGiveUp })(request).catch((error: unknown) => error);

    expect(client).toHaveBeenCalledTimes(4);
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as Error).message).toBe("HTTP 500: Internal error for key [redacted]");
    expect((failure as Error).cause).toBeUndefined();
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain("0123456789abcdef");
  });

  it("are not sent again when a second try cannot fix them", async () => {
    const time = clock();
    const client = failing([apiError(401, "Incorrect API key provided")]);

    await expect(withRetries(client, time)(request)).rejects.toThrow("HTTP 401: Incorrect API key provided");
    expect(client).toHaveBeenCalledOnce();
    expect(time.pauses).toEqual([]);
  });

  it("that refuse payment or permission are sent once and keep the provider's status and words", async () => {
    for (const [status, words] of [
      [402, "Insufficient credits: top up at https://example.com/billing to use this model."],
      [403, "This model is not enabled for this account."],
    ] as const) {
      const time = clock();
      const client = failing([apiError(status, words)]);

      const failure = await withRetries(client, time)(request).catch((error: unknown) => error);

      expect(client).toHaveBeenCalledOnce();
      expect(time.pauses).toEqual([]);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).status).toBe(status);
      expect((failure as Error).message).toBe(`HTTP ${status}: ${words}`);
    }
  });

  it("leave a cancelled request alone: the abort is passed on, uncounted", async () => {
    const controller = new AbortController();
    const onGiveUp = vi.fn();
    const aborted = new Error("The turn was cancelled.");
    const client: AgentLlmClient = async () => {
      controller.abort(aborted);
      throw aborted;
    };

    await expect(withRetries(client, { ...clock(), onGiveUp })({ ...request, signal: controller.signal })).rejects.toBe(aborted);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});

describe("a deadline per attempt", () => {
  it("ends an attempt that takes too long, and starts afresh for the attempt after a rate limit", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const client: AgentLlmClient = async (sent) => {
      calls += 1;
      signals.push(sent.signal!);
      if (calls === 1) throw apiError(429, "Rate limit reached", { "retry-after-ms": "1" });
      // The second attempt never answers: only its deadline ends it.
      return new Promise((_resolve, reject) => sent.signal!.addEventListener("abort", () => reject(sent.signal!.reason)));
    };

    const failure = await withRetries(client, { timeoutMs: 20 })(request).catch((error: unknown) => error);

    expect(calls).toBe(2);
    // Each attempt had a deadline of its own: waiting for the limit used up none of the second one's.
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as Error).message).toBe("The operation was aborted due to timeout (no answer within 20 ms)");
  });

  it("holds the retries of a request to its one deadline: a provider that fails slowly is not tried for minutes", async () => {
    const time = clock();
    const client = failing(Array.from({ length: 4 }, () => apiError(503, "Service unavailable")));

    const failure = await withRetries(client, { ...time, baseDelayMs: 1000, timeoutMs: 5000 })(request).catch((error: unknown) => error);

    // Pauses of one and two seconds fit into the five; the third, of four, would not.
    expect(client).toHaveBeenCalledTimes(3);
    expect(time.pauses).toEqual([1000, 2000]);
    expect((failure as Error).message).toBe("HTTP 503: Service unavailable (no answer within 5 s)");
  });

  it("leaves the request's own signal as it is when no deadline is set", async () => {
    const controller = new AbortController();
    const client = vi.fn<AgentLlmClient>(async () => ({ text: "Hello.", toolCalls: [] }));
    const sent = { ...request, signal: controller.signal };
    await withRetries(client)(sent);
    expect(client).toHaveBeenCalledWith(sent);
  });
});

describe("a provider that keeps timing out", () => {
  /** A client that never answers: only the deadline of its attempt ends it. */
  function silent() {
    return vi.fn<AgentLlmClient>(
      (sent) => new Promise((_resolve, reject) => sent.signal!.addEventListener("abort", () => reject(sent.signal!.reason))),
    );
  }

  it("is sent nothing more after two rounds in a row: the next request fails at once, and counts as given up", async () => {
    const throttle = new Throttle();
    const onGiveUp = vi.fn();
    const client = silent();
    const send = withRetries(client, { throttle, timeoutMs: 30, onGiveUp });

    // Two requests in flight together wait on the same silence: one round.
    const first = await Promise.allSettled([send(request), send(request)]);
    expect(first.map((settled) => settled.status)).toEqual(["rejected", "rejected"]);
    expect(throttle.notAnsweringFor()).toBeNull();
    await expect(send(request)).rejects.toThrow("The operation was aborted due to timeout (no answer within 30 ms)");

    const refused = await send(request).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ProviderError);
    expect((refused as Error).message).toBe("not sent: the provider did not answer within 30 ms, 2 times in a row");
    expect(client).toHaveBeenCalledTimes(3);
    expect(onGiveUp).toHaveBeenCalledTimes(4);
  });

  it("counts afresh once the provider answers, and is sent requests again a deadline later", async () => {
    const throttle = new Throttle();
    let answering = false;
    const client = vi.fn<AgentLlmClient>((sent) =>
      answering
        ? Promise.resolve({ text: "Hello.", toolCalls: [] })
        : new Promise((_resolve, reject) => sent.signal!.addEventListener("abort", () => reject(sent.signal!.reason))),
    );
    const send = withRetries(client, { throttle, timeoutMs: 20 });

    await expect(send(request)).rejects.toThrow("no answer within 20 ms");
    answering = true;
    await expect(send(request)).resolves.toMatchObject({ text: "Hello." });
    answering = false;
    await expect(send(request)).rejects.toThrow("no answer within 20 ms");
    // One round since the answer: still sent.
    expect(throttle.notAnsweringFor()).toBeNull();
    await expect(send(request)).rejects.toThrow("no answer within 20 ms");
    expect(throttle.notAnsweringFor()).toBe(20);

    await new Promise((resolve) => setTimeout(resolve, 30));
    answering = true;
    await expect(send(request)).resolves.toMatchObject({ text: "Hello." });
    expect(throttle.notAnsweringFor()).toBeNull();
  });

  it("is not what a rate limit is: waiting for one fails nothing, however long the provider asks", async () => {
    const time = clock();
    const client = failing([
      apiError(429, "Rate limit reached", { "Retry-After": "90" }),
      apiError(429, "Rate limit reached", { "Retry-After": "90" }),
      apiError(429, "Rate limit reached", { "Retry-After": "90" }),
    ]);

    const response = await withRetries(client, { ...time, timeoutMs: 60_000 })(request);

    expect(response.text).toBe("Hello.");
    expect(time.pauses).toEqual([90_000, 90_000, 90_000]);
    expect(time.throttle.notAnsweringFor()).toBeNull();
  });
});

describe("stream retries", () => {
  const drain = async (stream: ReturnType<AgentLlmStreamStep>) => {
    const parts: unknown[] = [];
    while (true) {
      const next = await stream.next();
      if (next.done) return { parts, response: next.value };
      parts.push(next.value);
    }
  };

  it("starts a step again that the provider refused before it said anything", async () => {
    const time = clock();
    let starts = 0;
    const stream: AgentLlmStreamStep = async function* () {
      starts += 1;
      if (starts === 1) throw apiError(429, "Rate limit reached", { "retry-after": "2" });
      yield { delta: "Hello.", text: "Hello." };
      return { text: "Hello.", toolCalls: [] };
    };

    const { parts, response } = await drain(withStreamRetries(stream, time)(request));

    expect(starts).toBe(2);
    expect(time.pauses).toEqual([2000]);
    expect(time.throttle.stats()).toEqual({ waits: 1, waitedMs: 2000 });
    expect(parts).toEqual([{ delta: "Hello.", text: "Hello." }]);
    expect(response.text).toBe("Hello.");
  });

  it("does not start a step again once the caller may have heard its words", async () => {
    const onGiveUp = vi.fn();
    let starts = 0;
    const stream: AgentLlmStreamStep = async function* () {
      starts += 1;
      yield { delta: "Sure, ", text: "Sure, " };
      throw apiError(503, "Overloaded");
    };

    await expect(drain(withStreamRetries(stream, { ...clock(), onGiveUp })(request))).rejects.toThrow("HTTP 503: Overloaded");
    expect(starts).toBe(1);
    expect(onGiveUp).toHaveBeenCalledOnce();
  });
});

describe("what a provider error says", () => {
  it("reads the status and the pause from the error a retry wrapper holds", () => {
    const wrapped = Object.assign(new Error("Failed after 3 attempts."), { lastError: apiError(429, "Too many requests", { "retry-after": "3" }) });
    expect(providerFacts(wrapped)).toEqual({ status: 429, retryable: true, rateLimited: true, retryAfterMs: 3000, message: "Too many requests" });
    expect(providerFacts(new Error("boom"))).toEqual({ status: null, retryable: false, rateLimited: false, retryAfterMs: null, message: "boom" });
    // A server that is down is a rate limit only when it says how long to stay away.
    expect(providerFacts(apiError(503, "Overloaded")).rateLimited).toBe(false);
    expect(providerFacts(apiError(503, "Overloaded", { "retry-after": "1" })).rateLimited).toBe(true);
  });

  it("reads Retry-After in milliseconds, in seconds and as a date", () => {
    expect(retryAfterMs({ "retry-after-ms": "1500", "retry-after": "9" })).toBe(1500);
    expect(retryAfterMs({ "Retry-After": "9" })).toBe(9000);
    expect(retryAfterMs({ "retry-after": "Wed, 01 Jan 2030 00:00:10 GMT" }, Date.parse("2030-01-01T00:00:00Z"))).toBe(10_000);
    expect(retryAfterMs({ "retry-after": "soon" })).toBeNull();
    expect(retryAfterMs({})).toBeNull();
  });

  it("is one short line without anything that is, or looks like, a key", () => {
    const env = { KUGELAUDIO_API_KEY: "ka_1234567890abcdef", HOME: "/home/alex-example" };
    expect(redactSecrets("key ka_1234567890abcdef in /home/alex-example, Bearer abcdefgh12345678, sk-proj-abcdefgh1234", env)).toBe(
      "key [redacted] in /home/alex-example, [redacted], [redacted]",
    );
    expect(describeProviderError(apiError(500, `Internal\n  error ${"x".repeat(400)}`))).toMatch(/^HTTP 500: Internal error x{285}…$/);
  });
});
