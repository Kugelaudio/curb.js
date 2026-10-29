/**
 * The LiveKit room of one browser call (`curb dev`, `curb server`): its name, and where each
 * side joins it with which token. Only when the environment names a LiveKit: without one, a
 * browser call runs over the page's own socket (`../local-host/`).
 *
 * Two sources, one shape:
 * - credentials: this process holds a LiveKit API key (`LIVEKIT_URL` with
 *   `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`) and mints both tokens itself.
 * - a realtime session: with `CURB_REALTIME_SESSION_URL` set, every call asks that URL for a
 *   fresh room and two tokens good for that room only, and this process holds no key. A host
 *   that runs `curb dev` where the browser cannot reach a LiveKit server beside it sets it,
 *   so the project never holds a secret that mints tokens for any room. In that mode the
 *   LiveKit variables are refused rather than ignored.
 */

import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";

export type LivekitCredentials = {
  url: string;
  apiKey: string;
  apiSecret: string;
};

/** Where one participant joins: the signalling URL and a token for the call's room. */
export type LivekitJoin = { url: string; token: string };

/** One call's room: the agent server joins as `agent`, the page as `caller`. */
export type LivekitRoomTicket = { room: string; agent: LivekitJoin; caller: LivekitJoin };

export const REALTIME_SESSION_URL_ENV = "CURB_REALTIME_SESSION_URL";

/** Each selects or mints for a LiveKit of its own, which a realtime session replaces. */
const REFUSED_BESIDE_SESSION = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;

/** A realtime session that has not answered by then fails the call. */
export const REALTIME_SESSION_TIMEOUT_MS = 15_000;

export async function mintToken(
  credentials: LivekitCredentials,
  options: { roomName: string; identity: string; agent?: boolean },
): Promise<string> {
  const token = new AccessToken(credentials.apiKey, credentials.apiSecret, {
    identity: options.identity,
    ttl: "2h",
  });
  token.addGrant({
    room: options.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    ...(options.agent ? { agent: true } : {}),
  });
  return token.toJwt();
}

/**
 * One call's room for `env` as it is now: from the realtime session when
 * `CURB_REALTIME_SESSION_URL` is set, otherwise a fresh room on `LIVEKIT_URL`. Null when
 * `env` names no LiveKit at all: the call then runs over the page's own socket.
 */
export async function openLivekitRoom(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<LivekitRoomTicket | null> {
  const sessionUrl = realtimeSessionUrl(env);
  if (sessionUrl) return roomFromSession(sessionUrl, fetchImpl);
  const credentials = livekitCredentials(env);
  return credentials ? roomFromCredentials(credentials) : null;
}

/**
 * The LiveKit deployment `env` names (`LIVEKIT_URL` + `LIVEKIT_API_KEY` +
 * `LIVEKIT_API_SECRET`), or null when it names none. Half of it throws: a key without a
 * URL, or a URL without its key, is a misconfiguration, never a reason to run locally.
 */
export function livekitCredentials(env: NodeJS.ProcessEnv): LivekitCredentials | null {
  const url = env.LIVEKIT_URL;
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (!url && !apiKey && !apiSecret) return null;
  if (!url || !apiKey || !apiSecret) {
    const missing = [!url && "LIVEKIT_URL", !apiKey && "LIVEKIT_API_KEY", !apiSecret && "LIVEKIT_API_SECRET"]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `A LiveKit deployment needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET; ${missing} missing. ` +
        "Set all three, or none to run browser calls over the page's own socket.",
    );
  }
  return { url, apiKey, apiSecret };
}

/** A fresh room on a LiveKit this process holds the key of. */
export async function roomFromCredentials(credentials: LivekitCredentials): Promise<LivekitRoomTicket> {
  const room = `curb-${randomUUID().slice(0, 8)}`;
  const [agentToken, callerToken] = await Promise.all([
    mintToken(credentials, { roomName: room, identity: "curb-agent", agent: true }),
    mintToken(credentials, { roomName: room, identity: "user" }),
  ]);
  return {
    room,
    agent: { url: credentials.url, token: agentToken },
    caller: { url: credentials.url, token: callerToken },
  };
}

/**
 * The realtime session URL `env` selects, or null when calls use LiveKit credentials.
 * Throws when it is not an http(s) URL, or is set beside a LiveKit variable.
 */
export function realtimeSessionUrl(env: NodeJS.ProcessEnv): URL | null {
  const raw = env[REALTIME_SESSION_URL_ENV];
  if (!raw) return null;
  const refused = REFUSED_BESIDE_SESSION.filter((name) => env[name]);
  if (refused.length > 0) {
    throw new Error(
      `${REALTIME_SESSION_URL_ENV} is set, so calls get their room from it and never use a LiveKit key. ` +
        `Remove ${refused.join(", ")} from .env and the environment.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${REALTIME_SESSION_URL_ENV} is not a URL: "${raw}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${REALTIME_SESSION_URL_ENV} must be an http or https URL, not "${url.protocol}".`);
  }
  return url;
}

/**
 * Asks the realtime session for one call's room: `POST` with no body, answered by
 * `{room, agentUrl, agentToken, callerUrl, callerToken}`. A refusal throws with the
 * session's own `message` when its body carries one.
 */
export async function roomFromSession(url: URL, fetchImpl: typeof fetch = fetch): Promise<LivekitRoomTicket> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(REALTIME_SESSION_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    throw new Error(
      `The realtime session at ${url.origin} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`The realtime session refused the call (HTTP ${response.status}): ${refusalMessage(text)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`The realtime session answered HTTP ${response.status} with a body that is not JSON.`);
  }
  const field = (name: string): string => {
    const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
    if (typeof value !== "string" || value === "") {
      throw new Error(`The realtime session's answer has no "${name}".`);
    }
    return value;
  };
  return {
    room: field("room"),
    agent: { url: field("agentUrl"), token: field("agentToken") },
    caller: { url: field("callerUrl"), token: field("callerToken") },
  };
}

/** The refusal's `message` (and `code`) from a JSON body, else the body's start. */
function refusalMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { message?: unknown; code?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return typeof body.code === "string" ? `${body.message} (${body.code})` : body.message;
    }
  } catch {
    // Not JSON: the body itself is the best account there is.
  }
  const trimmed = text.trim().slice(0, 300);
  return trimmed === "" ? "no message" : trimmed;
}
