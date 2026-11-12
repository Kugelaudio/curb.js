/**
 * Parse an incoming request's target as a `URL`, answering `null` instead of throwing.
 *
 * The request line is attacker-controlled. `GET http://[ HTTP/1.1` — an absolute-form
 * target with a broken IPv6 host — sails through Node's HTTP parser and becomes a
 * `request.url` that `new URL` refuses with `Invalid URL`. A handler that parses it
 * unguarded turns that into an uncaught exception: one malformed request takes down the
 * process and every live call on it. Every route reads the URL through this helper, so a
 * bad target is a refused request, never a crash.
 */
export function parseUrlOrNull(target: string | undefined, base: string): URL | null {
  try {
    return new URL(target ?? "/", base);
  } catch {
    return null;
  }
}
