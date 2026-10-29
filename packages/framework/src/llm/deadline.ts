// How long one LLM request may take, and how a turn stops waiting for one: the abort
// reaches the transport through `request.signal`, and the turn moves on without it.
import type { AgentRunResponse, AgentStreamPart } from "./types.js";

const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** The abort reason of a request that outlived the session's LLM timeout. */
export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`The LLM did not answer within ${ms} ms (AGENT_LLM_TIMEOUT_MS).`);
    this.name = "LlmTimeoutError";
  }
}

/** Settle with `work`, or reject with the abort reason as soon as `signal`
 * aborts. The abandoned request settles later on its own (the abort reaches
 * the transport through `request.signal`); its outcome is ignored because the
 * turn has already moved on. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Close a stream the turn stopped reading. Not awaited: a stream stuck in a
 * hung provider call only finishes once the abort reaches that call. */
export function closeAbandonedStream(stream: AsyncGenerator<AgentStreamPart, AgentRunResponse>): void {
  stream
    .return({ text: "", toolCalls: [] })
    .catch((error: unknown) => console.error("[curb] closing an abandoned LLM stream failed:", error));
}

/** `AGENT_LLM_TIMEOUT_MS`, when set (server hosts); the default otherwise,
 * including in the browser preview, which has no process env. */
export function llmTimeoutFromEnv(): number {
  const raw = typeof process === "undefined" ? undefined : process.env.AGENT_LLM_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_LLM_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `AGENT_LLM_TIMEOUT_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}. Fix or unset it in the project .env.`,
    );
  }
  return value;
}
