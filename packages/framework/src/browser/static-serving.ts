/**
 * What `serve-static.ts` decides about a request, kept apart from the server so it can be
 * tested: which file a path names, where a `/kugel/*` request is relayed, and which requests
 * may use the relay at all.
 */

import { resolve, sep } from "node:path";
import { isAllowedOrigin, LOCAL_ORIGIN_HOSTS } from "../server/origin.js";

/** The KugelAudio API the relay forwards to. Every relayed request goes to this origin. */
export const RELAY_UPSTREAM = "https://api.eu.kugelaudio.com";
/** The path prefix the page sends relayed requests under. */
export const RELAY_PREFIX = "/kugel/";

/**
 * The upstream URL a `/kugel/<rest>` request goes to, over `https` or `wss`; null when the
 * request is not a relay request or would leave the API's origin.
 */
export function relayTarget(url: URL, scheme: "https" | "wss"): string | null {
  if (!url.pathname.startsWith(RELAY_PREFIX)) return null;
  const upstream = new URL(RELAY_UPSTREAM);
  upstream.protocol = `${scheme}:`;
  const rest = url.pathname.slice(RELAY_PREFIX.length).replace(/^\/+/, "");
  const target = new URL(`${upstream.origin}/${rest}${url.search}`);
  return target.origin === upstream.origin ? target.href : null;
}

/**
 * The file under `root` that `pathname` names, or null when it names none: a malformed
 * escape, a NUL byte, or a path that leaves `root`.
 */
export function staticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const file = resolve(base, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);
  return file === base || file.startsWith(base + sep) ? file : null;
}

type RequestHeaders = { host?: string; origin?: string; "sec-fetch-site"?: string | string[] };

/**
 * Whether a request may use the relay, which adds the developer's key. Only the page this
 * server serves may: the request names a loopback host (no DNS-rebinding name), carries no
 * foreign `Origin`, and is not one a browser marks as sent from another site.
 */
export function relayAllowed(headers: RequestHeaders): boolean {
  const host = headers.host;
  if (host === undefined) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOCAL_ORIGIN_HOSTS.has(hostname)) return false;
  if (!isAllowedOrigin(headers.origin, LOCAL_ORIGIN_HOSTS)) return false;
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}
