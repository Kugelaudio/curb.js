import { Agent, fetch as undiciFetch } from "undici";

/**
 * How long an idle connection to the model provider is kept for the next request.
 *
 * Node's fetch closes it after 4 s. A voice agent's turns come further apart than that
 * (the caller speaks, then hears the reply), so every turn opened a new TCP and TLS
 * connection before its request could leave: one round trip more for TCP, one or two for
 * TLS, before the model starts. Kept below the idle limit of common HTTP front ends, so the
 * client closes first; a server's own `Keep-Alive: timeout` hint still wins when shorter.
 */
export const LLM_KEEP_ALIVE_MS = 30_000;

let dispatcher: Agent | undefined;

/**
 * The fetch every model provider's SDK is given. undici's own fetch with its own pool,
 * the same undici the AI SDK loads at runtime, so the two never disagree on versions.
 *
 * RISK: a request can fail on a connection the server closed in the same instant it was
 * reused; the AI SDK reports that as a retryable "Cannot connect to API" and sends it again
 * (unless the caller set `maxRetries: 0`).
 */
export const keepAliveFetch: typeof globalThis.fetch = (input, init) => {
  dispatcher ??= new Agent({ keepAliveTimeout: LLM_KEEP_ALIVE_MS });
  // undici's Request and Response are the classes Node's own fetch is built from; the DOM
  // lib types them separately.
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher },
  ) as unknown as Promise<Response>;
};
