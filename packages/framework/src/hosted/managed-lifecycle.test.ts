import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startManagementServer, type ManagementServer } from "./management-server.js";
import { SessionRegistry, type CallHandle, type StartCallSpec } from "./session-registry.js";
import { createCallReporter } from "./call-reporter.js";
import { EventJournal, type JournalRecord } from "./event-journal.js";
import { JournalRecord as JournalRecordSchema } from "./protocol.js";
import { AppMessages, HostTimeoutError, type MessageMeta } from "../messages.js";

/** `CallHandle.update` for calls whose live settings this file does not exercise. */
const settingsNotUnderTest = async (): Promise<never> => {
  throw new Error("live settings are not under test here");
};

/**
 * The whole runner, end to end, as a host actually drives it.
 *
 * Every layer here is real: the network port, the HTTP server, the registry, the runner
 * journal, and a per-call reporter publishing into it. Only the realtime room is a stand-in,
 * because the suite is hermetic (no keys, no network) and a room is the one part these
 * modules do not own.
 *
 * What it proves is the claim the multi-call design rests on: several conversations live in
 * one process without touching each other, and each can be started, watched and ended from
 * outside while the others carry on.
 */

const TOKEN = "lifecycle-token";

let address: string;
let journal: EventJournal;
let server: ManagementServer | null = null;

/** A call that runs until it is closed, and remembers how it ended. */
function controllable(): { handle: CallHandle; closed: string[]; end: () => void } {
  const closed: string[] = [];
  let resolve!: () => void;
  const ended = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    closed,
    end: () => resolve(),
    handle: {
      ended,
      update: settingsNotUnderTest,
      deliver: async () => {},
      close: async (reason: string) => {
        closed.push(reason);
        resolve();
      },
    },
  };
}

beforeEach(() => {
  journal = new EventJournal();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: address.split(":")[0],
        port: Number(address.split(":")[1]),
        path,
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
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

/** Every record one call has published, in order, read off the runner's journal. */
const recordsFor = (producer: string): Array<Record<string, unknown>> => {
  const seen: JournalRecord[] = [];
  journal.subscribe(0, (record) => seen.push(record));
  return seen
    .filter((record) => record.producer === producer)
    .map((record) => ({ ...(record.body as Record<string, unknown>), seq: record.seq }));
};

describe("a managed runner, end to end", () => {
  it("serves two calls at once, keeps their records apart, and ends one without the other", async () => {
    const calls = new Map<string, ReturnType<typeof controllable>>();
    // The reporter each call was handed. Captured through the SAME seam the voice pipeline
    // receives it on, rather than reaching into the registry: a test-only accessor would
    // prove something production never does.
    const reporters = new Map<string, ReturnType<typeof createCallReporter>>();

    const registry = new SessionRegistry({
      identity: { maxSessions: 3, deploymentId: "dep-1", configurationVersion: 3 },
      startCall: async (spec: StartCallSpec, reporter): Promise<CallHandle> => {
        const c = controllable();
        calls.set(spec.sessionId, c);
        reporters.set(spec.sessionId, reporter);
        return c.handle;
      },
      // A REAL journal, and a real reporter per call publishing into it.
      journal,
      log: () => {},
    });

    server = await startManagementServer(registry, {
      address: "127.0.0.1:0",
      token: TOKEN,
      journal,
    });
    expect(server).not.toBeNull();
    address = server!.address;

    // --- the host starts two calls on one runner -----------------------------------
    for (const id of ["call-a", "call-b"]) {
      const response = await call("/v1/sessions", "POST", {
        sessionId: id,
        realtimeUrl: "wss://rooms.invalid",
        realtimeToken: `token-${id}`,
        configurationVersion: 3,
      });
      expect(response.status).toBe(202);
      expect(JSON.parse(response.body).accepted).toBe(true);
    }

    const status = JSON.parse((await call("/v1/runner")).body);
    // The question an operator asks about a container: how many calls are on it.
    expect(status).toMatchObject({ deploymentId: "dep-1", maxSessions: 3, activeSessions: 2 });

    // --- both conversations happen, concurrently ------------------------------------
    const a = reporters.get("call-a")!;
    const b = reporters.get("call-b")!;
    a.turn({ speaker: "caller", text: "my number is 0170 111", final: true });
    b.turn({ speaker: "caller", text: "I want to cancel", final: true });
    a.turn({ speaker: "agent", text: "Thanks, I have 0170 111.", final: true });

    // THE PROPERTY THE WHOLE DESIGN RESTS ON. Each call's record is its own, with its own
    // sequence from 1. A shared reporter would interleave these two into one stream, and
    // since a reader deduplicates on (producer, sequence), one caller's words would arrive
    // attributed to the other's conversation, or be dropped as a replay.
    expect(recordsFor("call-a").map((r) => r.seq)).toEqual([1, 2]);
    expect(recordsFor("call-b").map((r) => r.seq)).toEqual([1]);
    expect(recordsFor("call-b")[0]!.text).toBe("I want to cancel");

    // --- the host ends one call from outside ----------------------------------------
    const stopped = await call("/v1/sessions/call-a?reason=capacity_expired", "DELETE");
    expect(stopped.status).toBe(202);

    // The reason reaches the agent, so it can close properly rather than having the room
    // dropped from under it mid-sentence.
    expect(calls.get("call-a")!.closed).toEqual(["capacity_expired"]);
    // And the other conversation is untouched, which is the whole point of ending one call
    // rather than stopping the container.
    expect(calls.get("call-b")!.closed).toEqual([]);

    const left = JSON.parse((await call("/v1/sessions")).body).sessions;
    expect(left.map((c: { sessionId: string }) => c.sessionId)).toEqual(["call-b"]);

    // The ended call reported why. This is the terminal record a reader uses to tell a
    // finished conversation from a truncated one.
    const tail = recordsFor("call-a").at(-1)!;
    expect(tail.kind).toBe("curb.ended");
    expect((tail.payload as Record<string, unknown>).reason).toBe("capacity_expired");

    // --- a rolling update drains the runner ------------------------------------------
    const drain = await call("/v1/runner/drain", "POST");
    expect(drain.status).toBe(202);

    // Draining never cuts off a call in progress: call-b keeps going, and only NEW
    // calls are refused. That is what makes a configuration change cost a cold start for
    // the next caller rather than a dropped conversation for this one.
    expect(registry.get("call-b")?.state).toBe("connected");
    const refused = await call("/v1/sessions", "POST", {
      sessionId: "call-c",
      realtimeUrl: "wss://rooms.invalid",
      realtimeToken: "t",
    });
    expect(refused.status).toBe(503);

    // The last call ends on its own; the runner is now empty and may exit.
    calls.get("call-b")!.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.status().activeSessions).toBe(0);
  });
});

describe("app messages over a managed runner", () => {
  /** Wires each call the way the join path does: a hub whose host side is its reporter. */
  async function runner() {
    const hubs = new Map<string, AppMessages>();
    const heard = new Map<string, MessageMeta[]>();
    const registry = new SessionRegistry({
      identity: { maxSessions: 2 },
      startCall: async (spec: StartCallSpec, reporter): Promise<CallHandle> => {
        const hub = new AppMessages({ warn: () => {} });
        hub.connectHost((message) => reporter.host(message));
        const seen: MessageMeta[] = [];
        hub.subscribe("host", "human.decision", { onMessage: (_payload, meta) => void seen.push(meta) });
        hubs.set(spec.sessionId, hub);
        heard.set(spec.sessionId, seen);
        return {
          ended: new Promise<void>(() => {}),
          update: settingsNotUnderTest,
          deliver: async (message) => {
            await hub.deliver("host", {
              id: message.id,
              key: message.name,
              payload: message.payload,
              ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
            });
          },
          close: async () => {},
        };
      },
      journal,
      log: () => {},
    });
    server = await startManagementServer(registry, { address: "127.0.0.1:0", token: TOKEN, journal });
    address = server!.address;
    for (const sessionId of ["call-a", "call-b"]) {
      await call("/v1/sessions", "POST", { sessionId, realtimeUrl: "wss://rooms.invalid", realtimeToken: "t" });
    }
    return { hubs, heard };
  }

  const hostRecords = (producer: string) => {
    const seen: JournalRecord[] = [];
    journal.subscribe(0, (record) => seen.push(record));
    return seen.filter((record) => record.class === "host" && record.producer === producer);
  };

  it("carries an askHost out as a host record and its reply back to the one call that asked", async () => {
    const { hubs, heard } = await runner();
    const a = hubs.get("call-a")!;
    const b = hubs.get("call-b")!;

    const askedA = a.send.askHost("human.requested", { topic: "refund" });
    const askedB = b.send.askHost("human.requested", { topic: "address" }, { timeoutMs: 200 });

    // Out: a schema-valid host record on each call's own producer and sequence.
    const [recordA] = hostRecords("call-a");
    const [recordB] = hostRecords("call-b");
    expect(JournalRecordSchema.parse(recordA)).toMatchObject({
      producer: "call-a",
      seq: 1,
      class: "host",
      body: { type: "host", seq: 1, name: "human.requested", payload: { topic: "refund" }, expectsReply: true },
    });
    expect(recordB).toMatchObject({ producer: "call-b", seq: 1 });
    const requestId = (recordA!.body as { id: string }).id;

    // Back: the host answers call-a over the real port. A reply resolves its ask and needs
    // no handler. The same reply sent to call-b names an ask call-b never made, so it goes
    // to call-b's handler for its key instead.
    const reply = {
      id: "h-1",
      name: "human.decision",
      payload: { disposition: "allowed", reason: "verified" },
      inReplyTo: requestId,
    };
    expect((await call("/v1/sessions/call-a/messages", "POST", reply)).status).toBe(202);
    expect((await call("/v1/sessions/call-b/messages", "POST", reply)).status).toBe(202);

    await expect(askedA).resolves.toEqual(reply.payload);
    await expect(askedB).rejects.toBeInstanceOf(HostTimeoutError);
    expect(heard.get("call-a")).toEqual([]);
    expect(heard.get("call-b")!.map((m) => m.id)).toEqual(["h-1"]);
  });

  it("times out an ask nobody answers", async () => {
    const { hubs } = await runner();
    await expect(
      hubs.get("call-a")!.send.askHost("human.requested", {}, { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(HostTimeoutError);
  });

  it("publishes toHost as a record that expects no reply", async () => {
    const { hubs } = await runner();
    hubs.get("call-a")!.send.toHost("lead", { score: 0.9 });
    const [record] = hostRecords("call-a");
    expect(JournalRecordSchema.parse(record).body).toMatchObject({ expectsReply: false, name: "lead" });
  });
});
