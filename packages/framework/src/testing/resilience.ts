import type { AgentLlmClient, AgentLlmStreamStep } from "../agent-session.js";
import type { AgentRunRequest, AgentRunResponse, AgentStreamPart } from "../llm/types.js";

/**
 * What keeps a test run going when a provider pushes back.
 *
 * A request the provider rate limits (429, or 503 with `Retry-After`) is not a failure of the
 * run: the whole run slows down. Every request waits out the pause the provider asked for (or
 * a growing one of its own when it named none), requests are spaced apart from then on, the
 * host is told so that it runs fewer conversations at once, and the request is sent again for
 * minutes before it counts as failed. {@link Throttle} holds that state for all requests of a
 * run, the agent's, the caller's and the judge's alike, and counts the waits for the report.
 *
 * Any other error a second try can get past (a server error, a dropped connection) is tried a
 * few times with a short backoff, all within the one deadline of the request (`timeoutMs`): a
 * provider that does not answer fails the request once that is up, however many tries it had.
 * Only a rate limit gives the next attempt a deadline of its own, since waiting for it is no
 * time the provider spent answering. A provider that keeps timing out, two rounds of requests in
 * a row with no answer in between, is not sent more for a deadline's length: every request of the
 * run fails at once meanwhile, so a run on a provider that is down ends in about two deadlines.
 * A request that still fails is a {@link ProviderError}: short, without the provider's response
 * body, and with nothing in it that looks like a key.
 */

/** A provider request that failed for good: after the retries, or with an error no retry helps.
 * It carries no cause on purpose: the original holds the request and the response body. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export type RetryOptions = {
  /** Requests per call for errors other than a rate limit, the first included. Default 4. */
  attempts?: number;
  /** The pause before the first retry when the provider names none; it doubles from there. Default 1000. */
  baseDelayMs?: number;
  /** The longest pause after an error that is no rate limit. Default 30000. */
  maxDelayMs?: number;
  /** How long one request keeps waiting for a rate limit to lift before it fails. Default 5 minutes. */
  rateLimitPatienceMs?: number;
  /** How long the provider has to answer the request, its retries included; a rate limit starts
   * it afresh, so that waiting for one does not use up the time a request has to answer.
   * Default: none beyond the request's own signal. */
  timeoutMs?: number;
  /** The state every request of the run shares. Default: one of this client's own. */
  throttle?: Throttle;
  /** Called when a request failed for good, before the {@link ProviderError} is thrown. */
  onGiveUp?: () => void;
  /** Stand-ins for waiting and the dice, for tests; the clock is the throttle's. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** How long one request waits for a rate limit to lift: long enough for a per-minute limit to
 * come round several times. */
export const RATE_LIMIT_PATIENCE_MS = 5 * 60_000;
/** The pause after a rate limit that names none, doubling up to the longest one a provider may ask for. */
const RATE_LIMIT_BASE_DELAY_MS = 2000;
const RATE_LIMIT_MAX_DELAY_MS = 120_000;
/** The gap between two requests once the provider has rate limited the run, and how far it grows. */
const FIRST_SPACING_MS = 1000;
const MAX_SPACING_MS = 4000;
/** Longest provider message a report shows. */
const MAX_ERROR_TEXT = 300;
/** Rounds of requests in a row that got no answer before the provider counts as not answering. */
const TIMEOUT_ROUNDS = 2;

/** How much a run was slowed down by its provider's rate limit. */
export type ThrottleStats = {
  /** The times the run paused because the provider rate limited it. */
  waits: number;
  /** How long it was paused, all pauses together. */
  waitedMs: number;
};

/**
 * What every request of a run shares about its provider's rate limit: until when no request is
 * sent, how far apart requests are sent from now on, and how often and how long the run waited.
 */
export class Throttle {
  private until = 0;
  private spacingMs = 0;
  private nextStartAt = 0;
  /** How many requests were sent, and how many had been when the run was last slowed down:
   * a request sent before that belongs to the burst that was already acted on. */
  private sent = 0;
  private sentAtSlowDown = 0;
  private waits = 0;
  private waitedMs = 0;
  /** Rounds of requests that ran out of time with no answer since, the newest request when the
   * last round was counted, and until when no request is sent because of them. */
  private timeoutRounds = 0;
  private sentAtTimeout = 0;
  private notAnswering: { until: number; deadlineMs: number } | null = null;
  private readonly slowDown = new Set<() => void>();
  readonly now: () => number;

  /** `now` stands in for the clock in tests. */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Have `listener` called each time the run should do less at once: once per burst of rate
   * limits. Returns the function that stops it. */
  onSlowDown(listener: () => void): () => void {
    this.slowDown.add(listener);
    return () => void this.slowDown.delete(listener);
  }

  /** No request is sent for `ms` from now: the backoff after an error that is no rate limit. */
  pause(ms: number): void {
    this.until = Math.max(this.until, this.now() + ms);
  }

  /** A request is sent now. Returns its number, for {@link limited}. */
  send(): number {
    this.sent += 1;
    return this.sent;
  }

  /**
   * Request number `request` was rate limited: no request is sent for `ms`. The first such
   * request of a burst also slows the rest of the run down, by a wider gap between requests and
   * by telling the host; the others of the burst were sent before anyone knew.
   */
  limited(ms: number, request: number): void {
    const now = this.now();
    const until = Math.max(this.until, now + ms);
    this.waitedMs += until - Math.max(this.until, now);
    this.until = until;
    if (request <= this.sentAtSlowDown) return;
    this.sentAtSlowDown = this.sent;
    this.waits += 1;
    this.spacingMs = Math.min(MAX_SPACING_MS, Math.max(FIRST_SPACING_MS, this.spacingMs * 2));
    for (const listener of [...this.slowDown]) listener();
  }

  /**
   * Request number `request` got no answer within its deadline of `deadlineMs`. Requests sent
   * before an earlier one ran out of time are of that one's round, which counts once: they were
   * all waiting on the same silence. After {@link TIMEOUT_ROUNDS} rounds in a row, no request is
   * sent for `deadlineMs` ({@link notAnsweringFor}).
   */
  timedOut(request: number, deadlineMs: number): void {
    if (request <= this.sentAtTimeout) return;
    this.sentAtTimeout = this.sent;
    this.timeoutRounds += 1;
    if (this.timeoutRounds >= TIMEOUT_ROUNDS) this.notAnswering = { until: this.now() + deadlineMs, deadlineMs };
  }

  /** The provider answered a request: its timeouts count afresh. */
  answered(): void {
    this.timeoutRounds = 0;
    this.notAnswering = null;
  }

  /** The deadline the provider kept running out of, while requests are not sent because of it;
   * else null. */
  notAnsweringFor(): number | null {
    return this.notAnswering && this.now() < this.notAnswering.until ? this.notAnswering.deadlineMs : null;
  }

  /** Milliseconds until the pause is over. */
  remaining(): number {
    return Math.max(0, this.until - this.now());
  }

  /** Take the next place in line: milliseconds until this request may be sent, after the pause
   * and at the run's spacing behind the request before it. */
  reserve(): number {
    const now = this.now();
    const start = Math.max(now, this.until, this.nextStartAt);
    this.nextStartAt = start + this.spacingMs;
    return start - now;
  }

  stats(): ThrottleStats {
    return { waits: this.waits, waitedMs: Math.round(this.waitedMs) };
  }
}

/** `client`, sending a request again when the provider says to (see the module comment). */
export function withRetries(client: AgentLlmClient, options: RetryOptions = {}): AgentLlmClient {
  const plan = retryPlan(options);
  return async (request) => {
    const call = plan.call(request.signal);
    while (true) {
      const sent = await call.ready();
      const attempt = call.attempt();
      try {
        const response = await client(attempt.signal === request.signal ? request : { ...request, signal: attempt.signal });
        call.answered();
        return response;
      } catch (error) {
        await call.failed(error, sent, attempt.expired());
      } finally {
        attempt.done();
      }
    }
  };
}

/**
 * `stream`, starting a step again when the provider refused it before it said anything. A step
 * that failed after its first part is not sent again: the caller may have heard its words.
 */
export function withStreamRetries(stream: AgentLlmStreamStep, options: RetryOptions = {}): AgentLlmStreamStep {
  const plan = retryPlan(options);
  return async function* (request: AgentRunRequest): AsyncGenerator<AgentStreamPart, AgentRunResponse> {
    const call = plan.call(request.signal);
    while (true) {
      const sent = await call.ready();
      const attempt = call.attempt();
      const step = stream(attempt.signal === request.signal ? request : { ...request, signal: attempt.signal });
      let started = false;
      let finished = false;
      try {
        while (true) {
          const next = await step.next();
          if (next.done) {
            finished = true;
            call.answered();
            return next.value;
          }
          started = true;
          yield next.value;
        }
      } catch (error) {
        finished = true;
        if (started) throw call.stopped(error, sent, attempt.expired());
        await call.failed(error, sent, attempt.expired());
      } finally {
        attempt.done();
        // The consumer stopped reading (a cancelled turn): close the provider's stream too.
        if (!finished) void step.return({ text: "", toolCalls: [] }).catch(() => {});
      }
    }
  };
}

function retryPlan(options: RetryOptions) {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const patienceMs = options.rateLimitPatienceMs ?? RATE_LIMIT_PATIENCE_MS;
  const throttle = options.throttle ?? new Throttle();
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  /** Half to all of `ms`, so that requests which failed together do not come back together. */
  const jittered = (ms: number) => ms * (0.5 + random() / 2);

  /** What the request rejects with for good: the abort itself, else a {@link ProviderError}. */
  const givenUp = (error: unknown, signal: AbortSignal | undefined, note = ""): unknown => {
    if (signal?.aborted) return error;
    options.onGiveUp?.();
    return new ProviderError(`${describeProviderError(error)}${note}`);
  };

  return {
    /** One request, through all its attempts. */
    call(signal: AbortSignal | undefined) {
      const { timeoutMs } = options;
      let failures = 0;
      let limits = 0;
      let limitedSince: number | null = null;
      /** When the provider's time to answer is up; set by the first attempt after a rate limit. */
      let deadlineAt: number | null = null;
      /** The request ran out of its time: the provider counts as not answering it. */
      const outOfTime = (sent: number) => {
        if (timeoutMs !== undefined) throttle.timedOut(sent, timeoutMs);
      };
      return {
        /** Wait for this request's place in line. Returns the number it is sent under. Throws when
         * the provider keeps timing out: the request is not sent at all. */
        async ready(): Promise<number> {
          for (let wait = throttle.reserve(); wait > 0; wait = throttle.remaining()) await sleep(wait, signal);
          const silentFor = throttle.notAnsweringFor();
          if (silentFor !== null) {
            throw givenUp(new Error(`not sent: the provider did not answer within ${duration(silentFor)}, ${TIMEOUT_ROUNDS} times in a row`), signal);
          }
          return throttle.send();
        },
        /** The signal of one attempt: the request's own, with what is left of its deadline. */
        attempt(): { signal: AbortSignal | undefined; done: () => void; expired: () => boolean } {
          if (timeoutMs === undefined) return { signal, done: () => {}, expired: () => false };
          deadlineAt ??= throttle.now() + timeoutMs;
          // A timer of its own rather than AbortSignal.timeout: it is cleared when the attempt is over.
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
            Math.max(0, deadlineAt - throttle.now()),
          );
          return {
            signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
            done: () => clearTimeout(timer),
            expired: () => deadline.signal.aborted,
          };
        },
        /** The provider answered. */
        answered(): void {
          throttle.answered();
        },
        /** What a stream that failed after its first part throws: it is not sent again. */
        stopped(error: unknown, sent: number, expired: boolean): unknown {
          if (!expired || signal?.aborted) return givenUp(error, signal);
          outOfTime(sent);
          return givenUp(error, signal, ` (no answer within ${duration(timeoutMs!)})`);
        },
        /** Pause before the next attempt, or throw what the request fails with for good.
         * `expired`: the attempt ended because the request's deadline was up. */
        async failed(error: unknown, sent: number, expired: boolean): Promise<void> {
          const facts = providerFacts(error);
          if (signal?.aborted) throw givenUp(error, signal);
          if (facts.rateLimited) {
            limits += 1;
            limitedSince ??= throttle.now();
            const waited = throttle.now() - limitedSince;
            const delay = Math.min(RATE_LIMIT_MAX_DELAY_MS, facts.retryAfterMs ?? jittered(RATE_LIMIT_BASE_DELAY_MS * 2 ** (limits - 1)));
            if (waited + delay > patienceMs) {
              throw givenUp(error, signal, ` (still rate limited after ${Math.round(waited / 1000)} s of waiting)`);
            }
            throttle.limited(delay, sent);
            // Waiting is no time the provider spent answering: the next attempt has a deadline of its own.
            deadlineAt = null;
            return;
          }
          if (expired) {
            outOfTime(sent);
            throw givenUp(error, signal, ` (no answer within ${duration(timeoutMs!)})`);
          }
          failures += 1;
          if (failures >= attempts || !facts.retryable) throw givenUp(error, signal);
          // The provider's own pause when it named one, else doubling with jitter.
          const pause = Math.min(maxDelayMs, facts.retryAfterMs ?? jittered(baseDelayMs * 2 ** (failures - 1)));
          if (deadlineAt !== null && throttle.now() + pause >= deadlineAt) {
            outOfTime(sent);
            throw givenUp(error, signal, ` (no answer within ${duration(timeoutMs!)})`);
          }
          throttle.pause(pause);
        },
      };
    },
  };
}

/** A deadline as a message names it. */
const duration = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** HTTP statuses a second try can get past: timeouts, conflicts, rate limits, server errors. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429]);
/** Network failures a second try can get past. */
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

type ProviderFacts = {
  status: number | null;
  /** A second try can get past it. */
  retryable: boolean;
  /** The provider says to slow down: 429, or 503 with the pause to take. */
  rateLimited: boolean;
  retryAfterMs: number | null;
  message: string;
};

/**
 * What an LLM transport's error says, read from the fields provider SDKs put on theirs
 * (`statusCode`, `responseHeaders`, `isRetryable`, and the last error of a retry wrapper).
 */
export function providerFacts(error: unknown): ProviderFacts {
  const chain = errorChain(error);
  const status = firstDefined(chain, (link) => (typeof link.statusCode === "number" ? link.statusCode : typeof link.status === "number" ? link.status : undefined));
  const headers = firstDefined(chain, (link) => (isRecord(link.responseHeaders) ? link.responseHeaders : undefined));
  const code = firstDefined(chain, (link) => (typeof link.code === "string" ? link.code : undefined));
  const flagged = chain.some((link) => link.isRetryable === true);
  const network = (code !== undefined && RETRYABLE_CODES.has(code)) || chain.some((link) => link.message === "fetch failed");
  const retryable = status !== undefined ? RETRYABLE_STATUS.has(status) || status >= 500 : flagged || network;
  // The innermost message is the provider's own; a retry wrapper's only counts attempts.
  const message = [...chain].reverse().find((link) => typeof link.message === "string" && link.message.trim())?.message;
  const after = headers ? retryAfterMs(headers) : null;
  return {
    status: status ?? null,
    retryable,
    rateLimited: status === 429 || (status === 503 && after !== null),
    retryAfterMs: after,
    message: typeof message === "string" ? message : String(error),
  };
}

/** The pause a response asks for: `retry-after-ms`, else `retry-after` in seconds or as a date. */
export function retryAfterMs(headers: Readonly<Record<string, unknown>>, now = Date.now()): number | null {
  const header = (name: string) => {
    const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    return typeof found === "string" && found.trim() ? found.trim() : undefined;
  };
  const ms = Number(header("retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0 && header("retry-after-ms") !== undefined) return ms;
  const after = header("retry-after");
  if (after === undefined) return null;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(after);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** One short line for a failed provider request: its HTTP status and message, never its body. */
export function describeProviderError(error: unknown): string {
  const { status, message } = providerFacts(error);
  const text = redactSecrets(message.replace(/\s+/g, " ").trim());
  const capped = text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
  return status === null ? capped : `HTTP ${status}: ${capped}`;
}

/** Environment variables whose value is a secret, by name. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
/** Shapes a key has in a provider's message even when it is not one of this process's own. */
const SECRET_SHAPES = [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, /\b(?:sk|pk|rk|key)-[A-Za-z0-9_-]{8,}/g];

/** `text` without anything that is, or looks like, a key: the values of this process's secret
 * variables, bearer tokens, and the usual key prefixes. */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  let clean = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_NAME.test(name)) clean = clean.split(value).join("[redacted]");
  }
  for (const shape of SECRET_SHAPES) clean = clean.replace(shape, "[redacted]");
  return clean;
}

/** The error, the error it wraps as its last attempt, and their causes, outermost first. */
function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let link: unknown = error;
  while (isRecord(link) && !chain.includes(link) && chain.length < 8) {
    chain.push(link);
    link = link.lastError ?? link.cause;
  }
  return chain;
}

function firstDefined<T>(chain: readonly Record<string, unknown>[], read: (link: Record<string, unknown>) => T | undefined): T | undefined {
  for (const link of chain) {
    const value = read(link);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
