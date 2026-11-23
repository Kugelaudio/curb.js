import { Agent, fetch as undiciFetch, getGlobalDispatcher } from "undici";

/**
 * How long an idle connection to the model provider is kept for the next request.
 *
 * Node's fetch closes it after 4 s. A voice agent's turns come further apart than that
 * (the caller speaks, then hears the reply), so every turn opened a new TCP and TLS
 * connection before its request could leave: one round trip more for TCP, one or two for
 * TLS, before the model starts. Kept below the idle limit of common HTTP front ends, so the
 * client closes first; a server's own `Keep-Alive: timeout` hint wins when shorter, and a
 * longer one is cut to this.
 */
export const LLM_KEEP_ALIVE_MS = 30_000;

/**
 * Whether requests would go out over Node's default transport: the global dispatcher is a
 * plain `Agent` nobody configured. A proxy (`NODE_USE_ENV_PROXY`, `setGlobalDispatcher`), a
 * mock or an agent with its own options is the application's transport and is kept.
 *
 * RISK: reads undici's internal `options` symbol, in Node's bundled copy and in the package.
 * If its shape changes, every dispatcher counts as configured and requests take Node's own
 * fetch: the transport is kept, only the longer idle time is lost.
 */
export function usesDefaultTransport(dispatcher: unknown = getGlobalDispatcher()): boolean {
  if (dispatcher === undefined) return true;
  if (typeof dispatcher !== "object" || dispatcher === null || dispatcher.constructor?.name !== "Agent") return false;
  const key = Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.description === "options");
  const options = key === undefined ? undefined : (dispatcher as Record<symbol, unknown>)[key];
  if (typeof options !== "object" || options === null) return false;
  return Object.entries(options).every(([name, value]) => value === undefined || (name === "maxOrigins" && value === Infinity));
}

/**
 * A fetch that keeps an idle connection open for `idleMs` when requests take Node's default
 * transport, and is Node's own fetch otherwise. undici's own fetch with its own pool, the same
 * undici the AI SDK loads at runtime, so the two never disagree on versions.
 *
 * RISK: a request can fail on a connection the server closed in the same instant it was
 * reused; the AI SDK reports that as a retryable "Cannot connect to API" and sends it again
 * (unless the caller set `maxRetries: 0`).
 */
export function createKeepAliveFetch(idleMs: number): typeof globalThis.fetch {
  let dispatcher: Agent | undefined;
  return (input, init) => {
    if (!usesDefaultTransport()) return globalThis.fetch(input, init);
    dispatcher ??= new Agent({ keepAliveTimeout: idleMs, keepAliveMaxTimeout: idleMs });
    // undici's Request and Response are the classes Node's own fetch is built from; the DOM
    // lib types them separately.
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher },
    ) as unknown as Promise<Response>;
  };
}

/** The fetch every model provider's SDK is given. */
export const keepAliveFetch = createKeepAliveFetch(LLM_KEEP_ALIVE_MS);
