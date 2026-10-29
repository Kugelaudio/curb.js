import { describe, expect, it, vi } from "vitest";
import {
  livekitCredentials,
  openLivekitRoom,
  realtimeSessionUrl,
  roomFromSession,
  type LivekitCredentials,
} from "./rooms.js";

const CREDENTIALS: LivekitCredentials = { url: "ws://127.0.0.1:7880", apiKey: "devkey", apiSecret: "secret" };
const SESSION_URL = "http://127.0.0.1:7682/realtime-session";
const SESSION = {
  room: "preview-ws-0193-abc123",
  agentUrl: "ws://realtime.example:7880",
  agentToken: "agent-token",
  callerUrl: "wss://realtime.example.com",
  callerToken: "caller-token",
  expiresAt: "2026-10-27T15:10:00Z",
};

/** The claims of a LiveKit token (a JWT): enough to see whose and for which room. */
function claims(token: string): { sub: string; video: { room: string; agent?: boolean } } {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

function answering(status: number, body: unknown) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

const LIVEKIT_ENV = {
  LIVEKIT_URL: CREDENTIALS.url,
  LIVEKIT_API_KEY: CREDENTIALS.apiKey,
  LIVEKIT_API_SECRET: CREDENTIALS.apiSecret,
};

describe("openLivekitRoom", () => {
  it("mints a fresh room and both tokens on the LiveKit the environment names", async () => {
    const fetchImpl = answering(200, SESSION);
    const ticket = await openLivekitRoom(LIVEKIT_ENV, fetchImpl);
    if (!ticket) throw new Error("expected a LiveKit room");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ticket.room).toMatch(/^curb-[0-9a-f]{8}$/);
    expect(ticket.agent.url).toBe(CREDENTIALS.url);
    expect(ticket.caller.url).toBe(CREDENTIALS.url);
    expect(claims(ticket.agent.token)).toMatchObject({ sub: "curb-agent", video: { room: ticket.room, agent: true } });
    expect(claims(ticket.caller.token)).toMatchObject({ sub: "user", video: { room: ticket.room } });
    expect(claims(ticket.caller.token).video.agent).toBeUndefined();

    const second = await openLivekitRoom(LIVEKIT_ENV, fetchImpl);
    expect(second?.room).not.toBe(ticket.room);
  });

  it("is null when the environment names no LiveKit: the call runs on the page's socket", async () => {
    const fetchImpl = answering(200, SESSION);
    await expect(openLivekitRoom({}, fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses half a LiveKit configuration instead of running locally", async () => {
    await expect(openLivekitRoom({ LIVEKIT_URL: CREDENTIALS.url })).rejects.toThrow(
      "LIVEKIT_API_KEY, LIVEKIT_API_SECRET missing",
    );
    expect(() => livekitCredentials({ LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "secret" })).toThrow(
      "LIVEKIT_URL missing",
    );
    expect(livekitCredentials(LIVEKIT_ENV)).toEqual(CREDENTIALS);
  });

  it("takes the room from the realtime session and never mints a token", async () => {
    const fetchImpl = answering(200, SESSION);
    const ticket = await openLivekitRoom({ CURB_REALTIME_SESSION_URL: SESSION_URL }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(SESSION_URL);
    expect(init?.method).toBe("POST");
    expect(ticket).toEqual({
      room: SESSION.room,
      agent: { url: SESSION.agentUrl, token: SESSION.agentToken },
      caller: { url: SESSION.callerUrl, token: SESSION.callerToken },
    });
  });

  it("refuses LiveKit variables beside a realtime session instead of ignoring them", async () => {
    const fetchImpl = answering(200, SESSION);
    const env = { CURB_REALTIME_SESSION_URL: SESSION_URL, LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "secret" };

    await expect(openLivekitRoom(env, fetchImpl)).rejects.toThrow(
      "Remove LIVEKIT_API_KEY, LIVEKIT_API_SECRET from .env and the environment.",
    );
    expect(() => realtimeSessionUrl({ CURB_REALTIME_SESSION_URL: SESSION_URL, LIVEKIT_URL: "wss://x" })).toThrow(
      "Remove LIVEKIT_URL",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("realtimeSessionUrl", () => {
  it("is null when unset and refuses a value that is not an http(s) URL", () => {
    expect(realtimeSessionUrl({})).toBeNull();
    expect(realtimeSessionUrl({ CURB_REALTIME_SESSION_URL: "" })).toBeNull();
    expect(() => realtimeSessionUrl({ CURB_REALTIME_SESSION_URL: "ws://127.0.0.1:7682/realtime-session" })).toThrow(
      'CURB_REALTIME_SESSION_URL must be an http or https URL, not "ws:"',
    );
    expect(() => realtimeSessionUrl({ CURB_REALTIME_SESSION_URL: "not a url" })).toThrow(
      'CURB_REALTIME_SESSION_URL is not a URL: "not a url".',
    );
  });
});

describe("roomFromSession", () => {
  const url = new URL(SESSION_URL);

  it("carries the session's own refusal", async () => {
    const tooSoon = answering(429, {
      code: "workspace_call_too_soon",
      message: "One preview call starts per 10s; try again in a moment.",
    });
    await expect(roomFromSession(url, tooSoon)).rejects.toThrow(
      "The realtime session refused the call (HTTP 429): One preview call starts per 10s; try again in a moment. (workspace_call_too_soon)",
    );
    await expect(roomFromSession(url, answering(502, "bad gateway\n"))).rejects.toThrow(
      "The realtime session refused the call (HTTP 502): bad gateway",
    );
  });

  it("names the field an answer lacks", async () => {
    const { callerToken: _, ...partial } = SESSION;
    await expect(roomFromSession(url, answering(200, partial))).rejects.toThrow(
      `The realtime session's answer has no "callerToken".`,
    );
    await expect(roomFromSession(url, answering(200, "<html>"))).rejects.toThrow("a body that is not JSON");
  });

  it("says where it could not reach", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(roomFromSession(url, down)).rejects.toThrow(
      "The realtime session at http://127.0.0.1:7682 did not answer: fetch failed",
    );
  });
});
