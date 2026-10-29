import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGEMENT_ADDRESS_ENV,
  MANAGEMENT_TOKEN_ENV,
  startManagementServer,
  type ManagementServer,
  type ManagementServerOptions,
} from "./management-server.js";
import { z } from "zod";
import { AppMessages } from "../messages.js";
import { SessionRegistry, type CallHandle } from "./session-registry.js";
import type { HostedCallReporter } from "./call-reporter.js";
import { EventJournal, type JournalEntry } from "./event-journal.js";
import {
  DrainResponse,
  ErrorBody,
  Health,
  HostMessageResponse,
  JournalRecord,
  LiveCall,
  Ping,
  RunnerStatus,
  SessionList,
  StartCallResponse,
  StopCallResponse,
  type ErrorCode,
} from "./protocol.js";

/** `CallHandle.update` for calls whose live settings this file does not exercise. */
const settingsNotUnderTest = async (): Promise<never> => {
  throw new Error("live settings are not under test here");
};

/**
 * The host's whole way in, so this is the contract. Every body is parsed with the protocol
 * schema it claims to be, and every failure must carry a code a host can classify: a host
 * that cannot tell "full" from "retiring" from "wrong generation" retries the wrong one.
 */

const TOKEN = "runner-token-1";

let server: ManagementServer | null = null;

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

function idle(): CallHandle {
  return { ended: new Promise<void>(() => {}), deliver: async () => {}, update: settingsNotUnderTest, close: async () => {} };
}

/** Port 0: the OS picks a free one, so tests never race each other for a fixed port. */
async function start(
  reg: SessionRegistry | null,
  options: Partial<ManagementServerOptions> = {},
): Promise<ManagementServer> {
  const started = await startManagementServer(reg, {
    address: "127.0.0.1:0",
    token: TOKEN,
    ...options,
  });
  if (started === null) throw new Error("the server did not start");
  server = started;
  return started;
}

afterEach(async () => {
  await server?.close();
  server = null;
  delete process.env[MANAGEMENT_ADDRESS_ENV];
  delete process.env[MANAGEMENT_TOKEN_ENV];
});

function call(
  path: string,
  method = "GET",
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const [host, port] = server!.address.split(":");
    const req = httpRequest(
      {
        host,
        port: Number(port),
        path,
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
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

/** Asserts a non-2xx answer is a schema-valid ErrorBody with the expected code. */
async function expectError(
  pending: Promise<{ status: number; body: string }>,
  status: number,
  code: ErrorCode,
): Promise<ErrorBody> {
  const response = await pending;
  expect(response.status).toBe(status);
  const body = ErrorBody.parse(JSON.parse(response.body));
  expect(body.error).toBe(code);
  return body;
}

/**
 * Follow an NDJSON stream until `expected` lines have arrived, then hang up. `afterConnect`
 * runs once the response headers are in, so a record published there reaches this reader.
 */
function readStream(
  path: string,
  expected: number,
  afterConnect: () => void = () => {},
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const [host, port] = server!.address.split(":");
    const lines: Array<Record<string, unknown>> = [];
    let buffered = "";

    const req = httpRequest(
      {
        host,
        port: Number(port),
        path,
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffered += chunk;
          const parts = buffered.split("\n");
          buffered = parts.pop() ?? "";
          for (const part of parts) {
            if (part !== "") lines.push(JSON.parse(part) as Record<string, unknown>);
          }
          if (lines.length >= expected) {
            req.destroy();
            resolve(lines);
          }
        });
        afterConnect();
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      // The hang-up above surfaces here; anything else is a real failure.
      if (error.code !== "ECONNRESET") reject(error);
    });
    req.end();
  });
}

function registry(maxSessions = 2, identity: { configurationVersion?: number } = {}) {
  return new SessionRegistry({
    identity: { maxSessions, deploymentId: "dep-1", ...identity },
    startCall: async () => idle(),
    makeReporter: fakeReporter,
    log: () => {},
  });
}

function turn(seq: number): JournalEntry {
  return {
    producer: "sess_a",
    seq,
    class: "conversation",
    at: 1_700_000_000_000 + seq,
    body: { type: "turn", seq, at: 1_700_000_000_000 + seq, speaker: "caller", text: "hi", final: true },
  };
}

const START = { sessionId: "s1", realtimeUrl: "wss://x", realtimeToken: "t" };

describe("startManagementServer", () => {
  it("serves nothing when this process is not managed", async () => {
    // A server that existed anyway would open a port nothing asked for.
    expect(await startManagementServer(registry())).toBeNull();
  });

  it("refuses to open without a token", async () => {
    const log = vi.fn();
    expect(
      await startManagementServer(registry(), { address: "127.0.0.1:0", token: "", log }),
    ).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("health and the token", () => {
  it("answers health without a token", async () => {
    await start(registry());
    const response = await call("/health", "GET", undefined, null);
    expect(response.status).toBe(200);
    expect(Health.parse(JSON.parse(response.body))).toEqual({
      ok: true,
      protocolVersion: 1,
      versions: [1],
    });
  });

  it("is required on every route but health", async () => {
    await start(registry());
    await expectError(call("/v1/runner", "GET", undefined, null), 401, "unauthorized");
    await expectError(call("/v1/runner", "GET", undefined, "wrong-token-x"), 401, "unauthorized");
    await expectError(call("/v1/sessions", "POST", START, null), 401, "unauthorized");
  });

  it("is checked before the route, so an unauthorized caller learns nothing", async () => {
    await start(registry());
    // 401-vs-404 would enumerate the surface for anyone who can reach the port.
    await expectError(call("/v1/sessions", "GET", undefined, null), 401, "unauthorized");
    await expectError(call("/v9/nonsense", "GET", undefined, null), 401, "unauthorized");
  });
});

describe("runner status", () => {
  it("states the protocol version and the runner's generation", async () => {
    await start(registry(2, { configurationVersion: 4 }));
    const response = await call("/v1/runner");
    expect(response.status).toBe(200);
    expect(RunnerStatus.parse(JSON.parse(response.body))).toEqual({
      protocolVersion: 1,
      deploymentId: "dep-1",
      configurationVersion: 4,
      maxSessions: 2,
      activeSessions: 0,
      draining: false,
      sessions: [],
    });
  });
});

describe("the events stream", () => {
  it("replays from the cursor and then follows live, every line a JournalRecord", async () => {
    const journal = new EventJournal();
    journal.publish({
      producer: "runner",
      seq: 1,
      class: "lifecycle",
      at: 1,
      body: { event: "ended", reason: "drained" },
    });
    journal.publish(turn(1));
    await start(registry(), { journal });

    const lines = await readStream("/v1/runner/events?from=1", 2, () => {
      journal.publish(turn(2));
    });

    // Envelope 1 was before the cursor; 2 is replayed and 3 arrives live.
    expect(lines.map((line) => line.envelope)).toEqual([2, 3]);
    for (const line of lines) JournalRecord.parse(line);
    expect(lines[0]).toMatchObject({ producer: "sess_a", seq: 1, class: "conversation" });
  });

  it("answers 410 with the oldest it still holds when the cursor is too old", async () => {
    // The host must be able to say how much it lost, not merely that it lost something.
    const journal = new EventJournal({ capacity: 2 });
    for (const seq of [1, 2, 3]) journal.publish(turn(seq));
    await start(registry(), { journal });

    const body = await expectError(call("/v1/runner/events?from=0"), 410, "cursor_too_old");
    expect(body).toMatchObject({ requested: 0, oldestRetained: 2 });
  });

  it("pings an idle stream, and the ping carries no envelope", async () => {
    const journal = new EventJournal();
    await start(registry(), { journal, heartbeatMs: 10 });

    const lines = await readStream("/v1/runner/events", 2);

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Ping.parse(line)).toEqual({ ping: expect.any(Number) });
      // A reader skips a ping without advancing its cursor.
      expect(line.envelope).toBeUndefined();
    }
  });

  it("does not let pings displace records in the replay buffer", async () => {
    const journal = new EventJournal({ capacity: 2 });
    await start(registry(), { journal, heartbeatMs: 5 });

    journal.publish(turn(1));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(journal.oldestRetained).toBe(1);
    expect(journal.lastEnvelope).toBe(1);
  });

  it("refuses a cursor that is not a non-negative integer", async () => {
    await start(registry(), { journal: new EventJournal() });
    for (const bad of ["soon", "-1", "1.5"]) {
      await expectError(call(`/v1/runner/events?from=${bad}`), 400, "invalid_request");
    }
  });

  it("answers 503 when the runner keeps no journal", async () => {
    await start(registry());
    await expectError(call("/v1/runner/events"), 503, "no_journal");
  });

  it("stops following once the reader goes away", async () => {
    const journal = new EventJournal();
    await start(registry(), { journal });

    await readStream("/v1/runner/events", 1, () => {
      journal.publish(turn(1));
    });

    // A subscriber left attached to a dead socket is a leak per reconnect.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journal.subscriberCount).toBe(0);
  });

  it("delivers the record published just before close, then ends the stream cleanly", async () => {
    const journal = new EventJournal();
    const started = await start(registry(), { journal });
    const [host, port] = started.address.split(":");

    // Read to the END of the body: a truncated stream errors or ends without the record.
    const received = new Promise<{ lines: string[]; clean: boolean }>((resolve, reject) => {
      const req = httpRequest(
        { host, port: Number(port), path: "/v1/runner/events", headers: { authorization: `Bearer ${TOKEN}` } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ lines: body.split("\n").filter(Boolean), clean: res.complete }));
          res.on("error", reject);
          // Written and closed in one tick, exactly as the runner does on shutdown.
          journal.publish({
            producer: "runner",
            seq: 1,
            class: "lifecycle",
            at: Date.now(),
            body: { event: "ended", reason: "drained" },
          });
          void started.close();
        },
      );
      req.on("error", reject);
      req.end();
    });

    const { lines, clean } = await received;
    server = null;
    expect(clean).toBe(true);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({ class: "lifecycle", body: { event: "ended" } });
  });
});

describe("sessions", () => {
  it("starts a call, and says whether it was already running", async () => {
    await start(registry());

    const first = await call("/v1/sessions", "POST", START);
    expect(first.status).toBe(202);
    expect(StartCallResponse.parse(JSON.parse(first.body)).accepted).toBe(true);

    const again = await call("/v1/sessions", "POST", START);
    expect(again.status).toBe(202);
    expect(StartCallResponse.parse(JSON.parse(again.body)).accepted).toBe(false);
  });

  it("ignores fields it does not know", async () => {
    await start(registry());
    const response = await call("/v1/sessions", "POST", { ...START, futureField: { x: 1 } });
    expect(response.status).toBe(202);
  });

  it("distinguishes full from retiring from wrong generation", async () => {
    await start(registry(1, { configurationVersion: 3 }));

    await expectError(
      call("/v1/sessions", "POST", { ...START, sessionId: "x", configurationVersion: 4 }),
      409,
      "generation_mismatch",
    );

    await call("/v1/sessions", "POST", START);
    await expectError(
      call("/v1/sessions", "POST", { ...START, sessionId: "s2" }),
      409,
      "runner_at_capacity",
    );

    await call("/v1/runner/drain", "POST");
    // 503, not 409: "start a new runner" is a different instruction from "this call cannot
    // be placed here".
    await expectError(
      call("/v1/sessions", "POST", { ...START, sessionId: "s3" }),
      503,
      "runner_draining",
    );
  });

  it("answers 500 start_failed when the call cannot start", async () => {
    const reg = new SessionRegistry({
      identity: { maxSessions: 1 },
      startCall: async () => {
        throw new Error("the room rejected the token");
      },
      makeReporter: fakeReporter,
      log: () => {},
    });
    await start(reg);
    const body = await expectError(call("/v1/sessions", "POST", START), 500, "start_failed");
    expect(body.detail).toContain("rejected the token");
  });

  it("lists and describes calls", async () => {
    await start(registry(3));
    await call("/v1/sessions", "POST", { ...START, sessionId: "a" });

    const list = SessionList.parse(JSON.parse((await call("/v1/sessions")).body));
    expect(list.sessions.map((c) => c.sessionId)).toEqual(["a"]);
    const one = await call("/v1/sessions/a");
    expect(LiveCall.parse(JSON.parse(one.body))).toMatchObject({ sessionId: "a", state: "connected" });

    await expectError(call("/v1/sessions/ghost"), 404, "session_not_found");
  });

  it("ends one call and leaves the others running, passing the grace through", async () => {
    const closed: Array<[string, number]> = [];
    const reg = new SessionRegistry({
      identity: { maxSessions: 3 },
      startCall: async () => {
        let end!: () => void;
        const ended = new Promise<void>((resolve) => {
          end = resolve;
        });
        return {
          ended,
          update: settingsNotUnderTest,
          deliver: async () => {},
          close: async (reason, graceMs) => {
            closed.push([reason, graceMs]);
            end();
          },
        };
      },
      makeReporter: fakeReporter,
      log: () => {},
    });
    await start(reg);
    await call("/v1/sessions", "POST", { ...START, sessionId: "a" });
    await call("/v1/sessions", "POST", { ...START, sessionId: "b" });

    const stopped = await call("/v1/sessions/a?reason=operator_stop&graceMs=1200", "DELETE");
    expect(stopped.status).toBe(202);
    expect(StopCallResponse.parse(JSON.parse(stopped.body))).toEqual({ sessionId: "a", stopped: true });
    expect(closed).toEqual([["operator_stop", 1200]]);

    const left = SessionList.parse(JSON.parse((await call("/v1/sessions")).body)).sessions;
    expect(left.map((c) => c.sessionId)).toEqual(["b"]);
  });

  it("refuses a grace that is not an integer from 0 to 60000", async () => {
    await start(registry());
    await call("/v1/sessions", "POST", START);
    for (const bad of ["-1", "1.5", "60001", "soon", ""]) {
      await expectError(call(`/v1/sessions/s1?graceMs=${bad}`, "DELETE"), 400, "invalid_request");
    }
    // Still running: a refused stop stops nothing.
    expect(JSON.parse((await call("/v1/sessions/s1")).body).state).toBe("connected");
    expect((await call("/v1/sessions/s1?graceMs=60000", "DELETE")).status).toBe(202);
  });

  it("succeeds when told to end a call it does not have", async () => {
    await start(registry());
    // A stop is retried; a second must not turn a completed teardown into an error.
    const response = await call("/v1/sessions/ghost", "DELETE");
    expect(response.status).toBe(202);
    expect(StopCallResponse.parse(JSON.parse(response.body)).stopped).toBe(false);
  });

  it("answers a drain at once rather than when the last call ends", async () => {
    await start(registry(2));
    await call("/v1/sessions", "POST", START);

    // The call never ends in this test.
    const response = await call("/v1/runner/drain", "POST");
    expect(response.status).toBe(202);
    expect(DrainResponse.parse(JSON.parse(response.body))).toEqual({
      draining: true,
      activeSessions: 1,
    });
  });

  it("refuses a start body that is not JSON", async () => {
    await start(registry());
    const body = await expectError(call("/v1/sessions", "POST", "{nope"), 400, "invalid_request");
    expect(body.detail).toMatch(/not JSON/);
  });

  it("names every missing or malformed field in a refused start", async () => {
    await start(registry());
    const body = await expectError(
      call("/v1/sessions", "POST", { sessionId: "s1", configurationVersion: 0 }),
      400,
      "invalid_request",
    );
    // Named individually: an omitted token and an omitted room are different host bugs.
    expect(body.detail).toContain("realtimeUrl");
    expect(body.detail).toContain("realtimeToken");
    expect(body.detail).toContain("configurationVersion");
  });
});

describe("errors", () => {
  it("names a version it does not speak", async () => {
    await start(registry());
    const body = await expectError(call("/v2/runner"), 404, "unknown_version");
    expect(body.versions).toEqual([1]);
  });

  it("answers not_found for a route that does not exist", async () => {
    await start(registry());
    await expectError(call("/v1/nonsense"), 404, "not_found");
    await expectError(call("/v1/sessions", "PUT"), 404, "not_found");
    await expectError(call("/v1/sessions/s1/transcript", "POST", {}), 404, "not_found");
  });

  it("answers runner_takes_no_calls on a runner handed its call at start", async () => {
    await start(null, { journal: new EventJournal() });
    await expectError(call("/v1/runner"), 501, "runner_takes_no_calls");
    await expectError(call("/v1/sessions", "POST", START), 501, "runner_takes_no_calls");
    // Host-to-agent messages need a registry to route by call; agent-to-host still leaves
    // through the journal.
    await expectError(
      call("/v1/sessions/s1/messages", "POST", { id: "m-1", name: "ops.note", payload: {} }),
      501,
      "runner_takes_no_calls",
    );
  });

  it("keeps the runner alive when a handler throws", async () => {
    const reg = registry();
    vi.spyOn(reg, "status").mockImplementation(() => {
      throw new Error("the registry is broken");
    });
    await start(reg, { log: () => {} });

    const body = await expectError(call("/v1/runner"), 500, "internal");
    expect(body.detail).toBe("the registry is broken");
    // Still answering: a throw that reached the server's error event would take the process
    // down, and with it every live call.
    expect((await call("/health")).status).toBe(200);
  });
});

describe("POST /v1/sessions/{id}/messages", () => {
  const DECISION = {
    id: "m-1",
    name: "human.decision",
    payload: { disposition: "allowed", reason: "verified" },
    inReplyTo: "a-1",
  };

  function recording(starting?: Promise<void>) {
    const delivered: Array<{ session: string; id: string }> = [];
    const reg = new SessionRegistry({
      identity: { maxSessions: 3 },
      startCall: async (spec) => {
        await starting;
        return {
          ended: new Promise<void>(() => {}),
          update: settingsNotUnderTest,
          deliver: async (message) => {
            delivered.push({ session: spec.sessionId, id: message.id });
          },
          close: async () => {},
        };
      },
      makeReporter: fakeReporter,
      log: () => {},
    });
    return { reg, delivered };
  }

  it("delivers once and answers a repeated id as not delivered", async () => {
    const { reg, delivered } = recording();
    await start(reg);
    await call("/v1/sessions", "POST", START);

    const first = await call("/v1/sessions/s1/messages", "POST", DECISION);
    expect(first.status).toBe(202);
    expect(HostMessageResponse.parse(JSON.parse(first.body))).toEqual({ id: "m-1", delivered: true });
    const again = await call("/v1/sessions/s1/messages", "POST", DECISION);
    expect(again.status).toBe(202);
    expect(HostMessageResponse.parse(JSON.parse(again.body))).toEqual({ id: "m-1", delivered: false });
    expect(delivered).toEqual([{ session: "s1", id: "m-1" }]);
  });

  it("answers 404 session_not_found for a call it does not have", async () => {
    await start(recording().reg);
    await expectError(call("/v1/sessions/ghost/messages", "POST", DECISION), 404, "session_not_found");
  });

  it("answers 400 invalid_request for a body that is not a HostMessage", async () => {
    const { reg, delivered } = recording();
    await start(reg);
    await call("/v1/sessions", "POST", START);

    await expectError(call("/v1/sessions/s1/messages", "POST", "{nope"), 400, "invalid_request");
    const body = await expectError(
      call("/v1/sessions/s1/messages", "POST", { id: "", name: "", payload: [] }),
      400,
      "invalid_request",
    );
    expect(body.detail).toContain("id");
    expect(body.detail).toContain("name");
    expect(body.detail).toContain("payload");
    expect(delivered).toEqual([]);
  });

  it("holds a message for a call still starting and delivers it once connected", async () => {
    let connect!: () => void;
    const { reg, delivered } = recording(new Promise<void>((resolve) => (connect = resolve)));
    await start(reg);
    const starting = call("/v1/sessions", "POST", START);
    await vi.waitFor(() => expect(reg.get("s1")?.state).toBe("starting"));

    const early = await call("/v1/sessions/s1/messages", "POST", DECISION);
    expect(HostMessageResponse.parse(JSON.parse(early.body))).toEqual({ id: "m-1", delivered: true });
    expect(delivered).toEqual([]);

    connect();
    expect((await starting).status).toBe(202);
    expect(delivered).toEqual([{ session: "s1", id: "m-1" }]);
  });

  /** One call served by a real app-messages hub, delivered the way the managed runner does. */
  async function served(listen: (hub: AppMessages) => void) {
    const hub = new AppMessages({ error: () => {} });
    listen(hub);
    const reg = new SessionRegistry({
      identity: { maxSessions: 1 },
      startCall: async () => ({
        ended: new Promise<void>(() => {}),
        update: settingsNotUnderTest,
        deliver: async (message) => {
          await hub.deliver("host", { id: message.id, key: message.name, payload: message.payload });
        },
        close: async () => {},
      }),
      makeReporter: fakeReporter,
      log: () => {},
    });
    await start(reg);
    await call("/v1/sessions", "POST", START);
    return hub;
  }

  it("delivers a plain, undotted key verbatim to a handler listening from the host", async () => {
    const seen: unknown[] = [];
    await served((hub) => hub.subscribe("host", "claim-submitted", { onMessage: (payload) => seen.push(payload) }));
    const answer = await call("/v1/sessions/s1/messages", "POST", {
      id: "m-1",
      name: "claim-submitted",
      payload: { claimId: "C-1" },
    });
    expect(answer.status).toBe(202);
    expect(seen).toEqual([{ claimId: "C-1" }]);
  });

  it("answers 422 no_handler when nothing listens for the key from the host", async () => {
    // A client handler for the same key does not count: the origin is the transport's.
    await served((hub) => hub.subscribe("client", "ops.notice", { onMessage: () => {} }));
    const body = await expectError(
      call("/v1/sessions/s1/messages", "POST", { id: "m-1", name: "ops.notice", payload: {} }),
      422,
      "no_handler",
    );
    expect(body.detail).toContain("ops.notice");
  });

  it("answers 422 invalid_payload with the schema's issues", async () => {
    await served((hub) =>
      hub.subscribe("host", "lead", { schema: z.object({ score: z.number() }), onMessage: () => {} }),
    );
    const body = await expectError(
      call("/v1/sessions/s1/messages", "POST", { id: "m-1", name: "lead", payload: { score: "high" } }),
      422,
      "invalid_payload",
    );
    expect(body.issues).toEqual([{ path: ["score"], message: expect.any(String) }]);
  });

  it("answers 422 handler_failed when the handler throws, and the call carries on", async () => {
    await served((hub) =>
      hub.subscribe("host", "ops.notice", {
        onMessage: () => {
          throw new Error("handler bug");
        },
      }),
    );
    await expectError(
      call("/v1/sessions/s1/messages", "POST", { id: "m-1", name: "ops.notice", payload: {} }),
      422,
      "handler_failed",
    );
    expect((await call("/v1/sessions/s1")).status).toBe(200);
  });
});
