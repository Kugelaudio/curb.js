/**
 * The origins a browser may hold while it connects to the local agent.
 *
 * A hostile page — a public website, or a DNS-rebinding name pointing at the loopback —
 * can open `new WebSocket("ws://127.0.0.1:…")`. The browser sends the page's own origin in
 * the `Origin` header; a server that ignores it has handed that page the agent's transcript
 * and every exposed tool. Native clients (a script, the `ws` test library, a host) send no
 * `Origin` at all and must stay able to connect: the browser is the only place a foreign
 * origin can appear, and browsers always send one on a WebSocket.
 */

/** The loopback hosts the preview is served on. `URL.hostname` keeps the brackets on IPv6. */
export const LOCAL_ORIGIN_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a connection carrying `origin` may connect to the agent. Absent (`undefined`) is
 * a client that is not a browser; present is a page, allowed only when its host is one the
 * server was told to serve.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedHosts: ReadonlySet<string>,
): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null", or anything that is not an origin at all
  }
  return (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === origin && allowedHosts.has(url.hostname);
}
