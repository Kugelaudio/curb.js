import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readManagedConfig,
  runManaged,
  MAX_SESSIONS_VAR,
  CONFIGURATION_VERSION_VAR,
  DEPLOYMENT_ID_VAR,
} from "./managed-runner.js";
import { MANAGEMENT_ADDRESS_ENV, MANAGEMENT_TOKEN_ENV } from "../hosted/management-server.js";
import { EventJournal, type JournalRecord } from "../hosted/event-journal.js";
import { JournalRecord as JournalRecordSchema } from "../hosted/protocol.js";
import { HOSTED_MARKER, type DirectJoinSession, type WarmVoiceRunner } from "./direct-join.js";
import { AppMessages, type MessageMeta } from "../messages.js";
import { SessionSettings } from "../session-settings.js";

/**
 * Which mode a container starts in, decided from its environment alone.
 *
 * Getting this wrong is not a small bug: a runner that read managed mode when it was handed
 * one call would sit waiting for a port nobody dials, and a runner that missed managed
 * mode would exit after one conversation on a container the host believes can take
 * several.
 */

describe("readManagedConfig", () => {
  it("is not managed without an address", () => {
    // Direct-join and worker mode both run without one; managed mode is the opt-in.
    expect(readManagedConfig({})).toBeNull();
    expect(readManagedConfig({ [MAX_SESSIONS_VAR]: "5" })).toBeNull();
  });

  it("ignores a nonsense bound rather than serving an unbounded number of calls", () => {
    for (const bad of ["0", "-2", "many", "1.5"]) {
      const config = readManagedConfig({
        [MANAGEMENT_ADDRESS_ENV]: "127.0.0.1:7071",
        [MAX_SESSIONS_VAR]: bad,
      });
      // Falls back to 1. Coercing "many" to NaN and comparing against it would make every
      // capacity check false, so the runner would accept calls without limit.
      expect(config?.maxSessions).toBe(1);
    }
  });

  it("reads the runner's generation", () => {
    expect(
      readManagedConfig({
        [MANAGEMENT_ADDRESS_ENV]: "127.0.0.1:7071",
        [MAX_SESSIONS_VAR]: "2",
        [DEPLOYMENT_ID_VAR]: "dep-a",
        [CONFIGURATION_VERSION_VAR]: "7",
      }),
    ).toEqual({ address: "127.0.0.1:7071", maxSessions: 2, deploymentId: "dep-a", configurationVersion: 7 });
  });
});

// --- the warm runner, driven over its real management port -------------------------------

const TOKEN = "managed-runner-test-token";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeWarm(): WarmVoiceRunner {
  return {
    definition: {} as WarmVoiceRunner["definition"],
    settings: {} as WarmVoiceRunner["settings"],
    vad: {} as WarmVoiceRunner["vad"],
    takeBundle: async () => ({}) as never,
  };
}

/** A joined call that runs until it is closed. `closes` records each close's options. */
function fakeSession(
  closes: Array<{ graceMs?: number } | undefined> = [],
  messages = new AppMessages(),
  settings = new SessionSettings(),
): DirectJoinSession {
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    room: {} as DirectJoinSession["room"],
    roomName: "room-1",
    ended,
    messages,
    settings,
    handle: {
      close: async (options?: { graceMs?: number }) => {
        closes.push(options);
        end();
      },
    } as unknown as DirectJoinSession["handle"],
  };
}

/** Every `curb-hosted` line printed on stdout, parsed. */
function hostedLines(log: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return log.mock.calls
    .map((args: unknown[]) => String(args[0]))
    .filter((line: string) => line.startsWith(`${HOSTED_MARKER} `))
    .map((line: string) => JSON.parse(line.slice(HOSTED_MARKER.length + 1)) as Record<string, unknown>);
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function http(
  address: string,
  path: string,
  method = "GET",
  body?: unknown,
  token = TOKEN,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: address.split(":")[0],
        port: Number(address.split(":")[1]),
        path,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function quiet() {
  vi.stubEnv(MANAGEMENT_TOKEN_ENV, TOKEN);
  vi.spyOn(console, "error").mockImplementation(() => {});
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runManaged warmup", () => {
  it("announces ready only after warmup has finished, and warms once", async () => {
    const log = quiet();
    const warmup = deferred<WarmVoiceRunner>();
    const warm = vi.fn(() => warmup.promise);
    const join = vi.fn();

    const running = runManaged({ address: "127.0.0.1:0", maxSessions: 1 }, { warm, join });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A host places a call on a runner the moment it says ready. Saying it while the
    // agent, the VAD and the plugins are still loading puts that cost back on the caller.
    expect(warm).toHaveBeenCalledTimes(1);
    expect(hostedLines(log).map((line) => line.event)).not.toContain("ready");

    warmup.resolve(fakeWarm());
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));

    expect((await http(String(ready.address), "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
    expect(warm).toHaveBeenCalledTimes(1);
    expect(join).not.toHaveBeenCalled();
  });

  it("fails before ready when warmup fails", async () => {
    const log = quiet();
    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 1 },
      {
        warm: async () => {
          throw new Error("silero onnx model could not be loaded");
        },
        join: vi.fn(),
      },
    );

    // Rejecting is what makes the generated entry exit non-zero. A runner that said ready and
    // then failed every call would look warm to the host and answer nobody.
    const outcome = await Promise.race([
      running.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 2000)),
    ]);
    expect(outcome).toMatch(/silero onnx model/);
    expect(hostedLines(log).map((line) => line.event)).not.toContain("ready");
  });
});

describe("runManaged calls", () => {
  it("joins with the start request's session id and reports first audio once", async () => {
    const log = quiet();
    const journal = new EventJournal();
    const warmRunner = fakeWarm();
    const join = vi.fn(async (config: { onFirstAudio?: (monotonicMs: number) => void }) => {
      // LiveKit reaches `speaking` again on every reply; only the first is first audio.
      config.onFirstAudio?.(1234.4);
      config.onFirstAudio?.(5000);
      return fakeSession();
    });

    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 1 },
      { warm: async () => warmRunner, join, journal, now: () => 1000 },
    );
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);

    const started = await http(address, "/v1/sessions", "POST", {
      sessionId: "sess-from-spec",
      realtimeUrl: "wss://rooms.invalid",
      realtimeToken: "room-token",
    });
    expect(started.status).toBe(202);

    expect(join).toHaveBeenCalledTimes(1);
    expect(join.mock.calls[0]![0]).toMatchObject({
      url: "wss://rooms.invalid",
      token: "room-token",
      sessionId: "sess-from-spec",
      warm: warmRunner,
    });

    const lifecycle: JournalRecord[] = [];
    journal.subscribe(0, (record) => lifecycle.push(record));
    const firstAudio = lifecycle.filter(
      (record) =>
        record.class === "lifecycle" &&
        (record.body as Record<string, unknown>).event === "first-audio",
    );
    expect(firstAudio).toHaveLength(1);
    expect(firstAudio[0]).toMatchObject({ producer: "runner", class: "lifecycle" });
    expect(firstAudio[0]!.body).toEqual({
      event: "first-audio",
      session: "sess-from-spec",
      monotonicMs: 1234,
      sinceStartMs: 234,
    });

    expect((await http(address, "/v1/sessions/sess-from-spec", "DELETE")).status).toBe(202);
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("hands the start request's client context and experiments to the call, and none when it has none", async () => {
    const log = quiet();
    const join = vi.fn(
      async (_config: {
        sessionId?: string;
        clientContext?: Record<string, string>;
        experiments?: Record<string, string>;
      }) => fakeSession(),
    );
    const running = runManaged({ address: "127.0.0.1:0", maxSessions: 2 }, { warm: async () => fakeWarm(), join });
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);

    const room = { realtimeUrl: "wss://rooms.invalid", realtimeToken: "t" };
    const placed = await http(address, "/v1/sessions", "POST", {
      sessionId: "s1",
      ...room,
      clientContext: { event: "webinar-11-04", ref: "newsletter" },
      experiments: { greeting: "casual" },
    });
    expect(placed.status).toBe(202);
    expect((await http(address, "/v1/sessions", "POST", { sessionId: "s2", ...room })).status).toBe(202);

    const bySession = new Map(join.mock.calls.map(([config]) => [config.sessionId, config]));
    expect(bySession.get("s1")?.clientContext).toEqual({ event: "webinar-11-04", ref: "newsletter" });
    expect(bySession.get("s1")?.experiments).toEqual({ greeting: "casual" });
    expect(bySession.get("s2")).not.toHaveProperty("clientContext");
    expect(bySession.get("s2")).not.toHaveProperty("experiments");

    for (const sessionId of ["s1", "s2"]) await http(address, `/v1/sessions/${sessionId}`, "DELETE");
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("hands the start request's direction to the call, and none when it states none", async () => {
    const log = quiet();
    const join = vi.fn(async (_config: { sessionId?: string; direction?: string }) => fakeSession());
    const running = runManaged({ address: "127.0.0.1:0", maxSessions: 2 }, { warm: async () => fakeWarm(), join });
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);

    const room = { realtimeUrl: "wss://rooms.invalid", realtimeToken: "t" };
    const placed = await http(address, "/v1/sessions", "POST", { sessionId: "s1", ...room, direction: "outbound" });
    expect(placed.status).toBe(202);
    expect((await http(address, "/v1/sessions", "POST", { sessionId: "s2", ...room })).status).toBe(202);
    const refused = await http(address, "/v1/sessions", "POST", { sessionId: "s3", ...room, direction: "callback" });
    expect(refused.status).toBe(400);

    const bySession = new Map(join.mock.calls.map(([config]) => [config.sessionId, config]));
    expect(bySession.get("s1")?.direction).toBe("outbound");
    expect(bySession.get("s2")).not.toHaveProperty("direction");
    expect(bySession.has("s3")).toBe(false);

    for (const sessionId of ["s1", "s2"]) await http(address, `/v1/sessions/${sessionId}`, "DELETE");
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("refuses a start whose client context is not one string per key, before touching the room", async () => {
    const log = quiet();
    const join = vi.fn(async () => fakeSession());
    const running = runManaged({ address: "127.0.0.1:0", maxSessions: 1 }, { warm: async () => fakeWarm(), join });
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);

    const refused = await http(address, "/v1/sessions", "POST", {
      sessionId: "s1",
      realtimeUrl: "wss://rooms.invalid",
      realtimeToken: "t",
      clientContext: { event: { id: "webinar-11-04" } },
    });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toMatchObject({ error: "invalid_request" });
    expect(join).not.toHaveBeenCalled();

    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("hands a stop's grace to the voice session, so the agent can finish its sentence", async () => {
    const log = quiet();
    const closes: Array<{ graceMs?: number } | undefined> = [];
    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 1 },
      { warm: async () => fakeWarm(), join: vi.fn(async () => fakeSession(closes)) },
    );
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);
    await http(address, "/v1/sessions", "POST", {
      sessionId: "s1",
      realtimeUrl: "wss://rooms.invalid",
      realtimeToken: "t",
    });

    expect((await http(address, "/v1/sessions/s1?reason=done&graceMs=1500", "DELETE")).status).toBe(202);
    await waitFor(() => (closes.length > 0 ? true : undefined));
    expect(closes).toEqual([{ graceMs: 1500 }]);

    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("still refuses a call pinned to another deployment, before touching the room", async () => {
    const log = quiet();
    const join = vi.fn(async () => fakeSession());
    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 1, deploymentId: "dep-a" },
      { warm: async () => fakeWarm(), join },
    );
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);

    const refused = await http(address, "/v1/sessions", "POST", {
      sessionId: "s1",
      realtimeUrl: "wss://rooms.invalid",
      realtimeToken: "t",
      deploymentId: "dep-b",
    });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ error: "generation_mismatch" });
    expect(join).not.toHaveBeenCalled();

    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });
});


describe("runManaged output", () => {
  it("prints the ready line hosts key on, with event first", async () => {
    const log = quiet();
    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 2 },
      { warm: async () => fakeWarm(), join: vi.fn() },
    );
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));

    // An external supervisor may match this exact prefix on stdout, so it is part of the
    // contract, not formatting.
    const raw = log.mock.calls
      .map((args: unknown[]) => String(args[0]))
      .find((line: string) => line.includes('"event":"ready"'));
    expect(raw?.startsWith(`${HOSTED_MARKER} {"event":"ready",`)).toBe(true);
    expect(ready).toEqual({
      event: "ready",
      address: expect.any(String),
      maxSessions: 2,
      warmupMs: expect.any(Number),
    });

    expect((await http(String(ready.address), "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });

  it("puts only protocol records on the stream: lifecycle and conversation, never logs", async () => {
    const log = quiet();
    const journal = new EventJournal();
    const running = runManaged(
      { address: "127.0.0.1:0", maxSessions: 1 },
      { warm: async () => fakeWarm(), join: vi.fn(async () => fakeSession()), journal },
    );
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);

    // A refused start makes the runner log a diagnostic; it must stay on stderr.
    await http(address, "/v1/sessions", "POST", { sessionId: "s1" });
    await http(address, "/v1/sessions", "POST", {
      sessionId: "s1",
      realtimeUrl: "wss://rooms.invalid",
      realtimeToken: "t",
    });
    expect((await http(address, "/v1/sessions/s1?reason=done&graceMs=500", "DELETE")).status).toBe(202);
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;

    const records: JournalRecord[] = [];
    journal.subscribe(0, (record) => records.push(record));
    for (const record of records) JournalRecordSchema.parse(record);
    expect(new Set(records.map((record) => record.class))).toEqual(
      new Set(["lifecycle", "conversation"]),
    );

    const lifecycle = records
      .filter((record) => record.class === "lifecycle")
      .map((record) => (record.body as { event: string }).event);
    // A drain over HTTP is announced like a signal drain, and `ended` is last.
    expect(lifecycle).toEqual(["ready", "call-started", "call-stopping", "draining", "ended"]);
    const draining = records.find(
      (record) => record.class === "lifecycle" && record.body.event === "draining",
    );
    expect(draining?.body).toEqual({ event: "draining", active: 0 });
  });

  it("delivers a host message to the call it names, over the management port", async () => {
    const log = quiet();
    const hubs = new Map<string, AppMessages>();
    const join = vi.fn(async (config: { sessionId?: string }) => {
      const messages = new AppMessages();
      hubs.set(config.sessionId!, messages);
      return fakeSession([], messages);
    });
    const running = runManaged({ address: "127.0.0.1:0", maxSessions: 2 }, { warm: async () => fakeWarm(), join });
    const ready = await waitFor(() => hostedLines(log).find((line) => line.event === "ready"));
    const address = String(ready.address);
    for (const sessionId of ["s1", "s2"]) {
      await http(address, "/v1/sessions", "POST", { sessionId, realtimeUrl: "wss://rooms.invalid", realtimeToken: "t" });
    }
    const heard = new Map<string, MessageMeta[]>();
    for (const [sessionId, messages] of hubs) {
      const seen: MessageMeta[] = [];
      messages.subscribe("host", "ops.notice", { onMessage: (_payload, meta) => void seen.push(meta) });
      heard.set(sessionId, seen);
    }

    const posted = await http(address, "/v1/sessions/s2/messages", "POST", {
      id: "m-1",
      name: "ops.notice",
      payload: { text: "supervisor online" },
    });
    expect(posted.status).toBe(202);
    expect(heard.get("s2")!.map((message) => message.id)).toEqual(["m-1"]);
    expect(heard.get("s1")).toEqual([]);

    for (const sessionId of ["s1", "s2"]) await http(address, `/v1/sessions/${sessionId}`, "DELETE");
    expect((await http(address, "/v1/runner/drain", "POST")).status).toBe(202);
    await running;
  });
});
