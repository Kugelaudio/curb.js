/** `undici` (Node's HTTP client, which the LLM providers use to keep their connection open
 * between turns): the browser keeps connections open itself, so `fetch` is the browser's own and
 * an `Agent` carries no settings. */
export class Agent {
  constructor(_options?: unknown) {}
}

/** The browser has no global dispatcher to configure. */
export function getGlobalDispatcher(): undefined {
  return undefined;
}

export function fetch(input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }): Promise<Response> {
  const { dispatcher: _dispatcher, ...browserInit } = init ?? {};
  return globalThis.fetch(input, browserInit);
}
