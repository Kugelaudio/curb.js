import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppMessages } from "../messages.js";
import { kugelaudio } from "../providers.js";
import { SessionSettings } from "../session-settings.js";
import type { HostedCallReporter } from "./call-reporter.js";
import { startManagementServer, type ManagementServer } from "./management-server.js";
import { ErrorBody, LiveCall, SessionList, SessionUpdateResponse, StopCallResponse, type ErrorCode } from "./protocol.js";
import { SessionRegistry, type CallHandle } from "./session-registry.js";

/**
 * Live settings over the host protocol (`PATCH /v1/sessions/{id}`), and the management port of
 * a process that does not place its own calls (`curb start`, `curb dev`): calls are adopted as
 * LiveKit runs them, and placing one is refused with 501.
 */

const TOKEN = "runner-token-live";
let server: ManagementServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function fakeReporter(): HostedCallReporter {
  return {
    turn: vi.fn(),
    event: vi.fn(),
    host: vi.fn(() => true),
    count: vi.fn(),
    journaled: true,
    finish: vi.fn(async () => {}),
    undelivered: 0,
  };
}

/** A call whose settings are real: `adjustable` decides what the host may change. */
function liveCall(adjustable: { host?: Array<"tts.voice" | "llm"> } = { host: ["tts.voice"] }) {
  const settings = new SessionSettings();
  settings.setAdjustable(adjustable);
  settings.setProps({ tts: kugelaudio.tts({ voice: 42 }) });
  const messages = new AppMessages({ warn: () => {}, error: () => {} });
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const closes: number[] = [];
  const handle: CallHandle = {
    ended,
    deliver: async (message) => {
      await messages.deliver("host", { id: message.id, key: message.name, payload: message.payload });
    },
    update: async (body) => settings.update("host", body),
    close: async (_reason, graceMs) => {
      closes.push(graceMs);
      end();
    },
  };
  return { settings, messages, handle, closes, end };
}

async function serve(registry: SessionRegistry): Promise<void> {
  server = await startManagementServer(registry, { address: "127.0.0.1:0", token: TOKEN, log: () => {} });
  if (server === null) throw new Error("the server did not start");
}

function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const [host, port] = server!.address.split(":");
    const req = httpRequest(
      {
        host,
        port: Number(port),
        path,
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function expectError(path: string, method: string, body: unknown, status: number, code: ErrorCode) {
  const answer = await call(path, method, body);
  expect(answer.status).toBe(status);
  const error = ErrorBody.parse(answer.json);
  expect(error.error).toBe(code);
  return error;
}

function placedRegistry(handle: CallHandle) {
  return new SessionRegistry({
    identity: { maxSessions: 2 },
    startCall: async () => handle,
    makeReporter: fakeReporter,
    log: () => {},
  });
}

describe("PATCH /v1/sessions/{id}", () => {
  it("answers 200 with the effective settings for an adjustable path", async () => {
    const live = liveCall();
    const registry = placedRegistry(live.handle);
    await registry.start({ sessionId: "s1", realtimeUrl: "wss://x", realtimeToken: "t" });
    await serve(registry);

    const answer = await call("/v1/sessions/s1", "PATCH", { tts: { voice: 17 } });
    expect(answer.status).toBe(200);
    expect(SessionUpdateResponse.parse(answer.json)).toEqual({
      sessionId: "s1",
      settings: {
        tts: { provider: "kugelaudio", voice: 17 },
        stt: { provider: "azure" },
        llm: { provider: "kugelaudio", model: "qwen3.8-27b" },
      },
    });
    expect(live.settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 17 }));
  });

  it("answers 403 not_adjustable naming the path, and changes nothing of a mixed body", async () => {
    const live = liveCall();
    const registry = placedRegistry(live.handle);
    await registry.start({ sessionId: "s1", realtimeUrl: "wss://x", realtimeToken: "t" });
    await serve(registry);

    const error = await expectError(
      "/v1/sessions/s1",
      "PATCH",
      { tts: { voice: 17 }, llm: { provider: "anthropic", model: "claude-sonnet-5" } },
      403,
      "not_adjustable",
    );
    expect(error.path).toBe("llm");
    expect(live.settings.current().tts).toStrictEqual(kugelaudio.tts({ voice: 42 }));
  });

  it("answers 422 invalid_settings with the issues", async () => {
    const live = liveCall();
    const registry = placedRegistry(live.handle);
    await registry.start({ sessionId: "s1", realtimeUrl: "wss://x", realtimeToken: "t" });
    await serve(registry);

    const error = await expectError("/v1/sessions/s1", "PATCH", { tts: { voice: "Rachel" } }, 422, "invalid_settings");
    expect(error.issues).toEqual([{ path: ["tts", "voice"], message: 'kugelaudio voices are numeric ids, got "Rachel"' }]);
    await expectError("/v1/sessions/s1", "PATCH", { tts: { pitch: 1 } }, 422, "invalid_settings");
  });

  it("answers 404 for an unknown call and 400 for a body that is not JSON", async () => {
    await serve(placedRegistry(liveCall().handle));
    await expectError("/v1/sessions/nobody", "PATCH", { tts: { voice: 1 } }, 404, "session_not_found");
    await expectError("/v1/sessions/nobody", "PATCH", "{nope", 400, "invalid_request");
  });

  it("applies a change to a call still starting once it connects", async () => {
    const live = liveCall();
    let connect!: (handle: CallHandle) => void;
    const registry = new SessionRegistry({
      identity: { maxSessions: 1 },
      startCall: () => new Promise<CallHandle>((resolve) => (connect = resolve)),
      makeReporter: fakeReporter,
      log: () => {},
    });
    const started = registry.start({ sessionId: "s1", realtimeUrl: "wss://x", realtimeToken: "t" });
    const updated = registry.update("s1", { tts: { voice: 5 } });
    connect(live.handle);
    await started;
    expect(await updated).toMatchObject({ ok: true, settings: { tts: { voice: 5 } } });
  });
});

describe("a management port on a process that places no calls (curb start, curb dev)", () => {
  it("adopts each call LiveKit runs, serves it, and drops it when the call ends", async () => {
    const registry = new SessionRegistry({ makeReporter: fakeReporter, log: () => {} });
    expect(registry.placesCalls).toBe(false);
    await serve(registry);

    const first = liveCall();
    const second = liveCall({ host: ["llm"] });
    const heard: unknown[] = [];
    first.messages.subscribe("host", "note", { schema: z.object({ text: z.string() }), onMessage: (payload) => void heard.push(payload) });
    registry.adopt("room-a").connected(first.handle);
    registry.adopt("room-b").connected(second.handle);

    const list = await call("/v1/sessions");
    expect(SessionList.parse(list.json).sessions.map((session) => session.sessionId)).toEqual(["room-a", "room-b"]);
    expect(LiveCall.parse((await call("/v1/sessions/room-a")).json).state).toBe("connected");

    expect((await call("/v1/sessions/room-a/messages", "POST", { id: "m1", name: "note", payload: { text: "hi" } })).status).toBe(202);
    expect(heard).toEqual([{ text: "hi" }]);
    expect((await call("/v1/sessions/room-a", "PATCH", { tts: { voice: 9 } })).status).toBe(200);
    await expectError("/v1/sessions/room-b", "PATCH", { tts: { voice: 9 } }, 403, "not_adjustable");

    // A call that ends on its own leaves the registry.
    second.end();
    await vi.waitFor(async () => {
      expect(SessionList.parse((await call("/v1/sessions")).json).sessions.map((s) => s.sessionId)).toEqual(["room-a"]);
    });
    // The host ends the other one.
    const stopped = await call("/v1/sessions/room-a?graceMs=1500", "DELETE");
    expect(StopCallResponse.parse(stopped.json)).toEqual({ sessionId: "room-a", stopped: true });
    expect(first.closes).toEqual([1500]);
    expect(SessionList.parse((await call("/v1/sessions")).json).sessions).toEqual([]);
  });

  it("refuses to place, count or drain calls with 501 runner_takes_no_calls", async () => {
    await serve(new SessionRegistry({ makeReporter: fakeReporter, log: () => {} }));
    await expectError("/v1/sessions", "POST", { sessionId: "s", realtimeUrl: "wss://x", realtimeToken: "t" }, 501, "runner_takes_no_calls");
    await expectError("/v1/runner", "GET", undefined, 501, "runner_takes_no_calls");
    await expectError("/v1/runner/drain", "POST", undefined, 501, "runner_takes_no_calls");
  });

  it("refuses a second call under a session id already registered", () => {
    const registry = new SessionRegistry({ makeReporter: fakeReporter, log: () => {} });
    registry.adopt("room-a");
    expect(() => registry.adopt("room-a")).toThrow(/already registered/);
  });

  it("frees the entry of a call that failed to start", () => {
    const registry = new SessionRegistry({ makeReporter: fakeReporter, log: () => {} });
    registry.adopt("room-a").failed(new Error("no room"));
    expect(registry.list()).toEqual([]);
  });
});
