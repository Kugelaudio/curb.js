import { describe, expect, it, vi } from "vitest";
import {
  MAX_QUEUED_HOST_MESSAGES,
  SessionRegistry,
  type CallHandle,
  type StartCallSpec,
} from "./session-registry.js";
import type { HostedCallReporter } from "./call-reporter.js";
import type { HostMessage } from "./protocol.js";
import { MessageRefusedError, type MessageRefusalCode } from "../messages.js";

/** `CallHandle.update` for calls whose live settings this file does not exercise. */
const settingsNotUnderTest = async (): Promise<never> => {
  throw new Error("live settings are not under test here");
};

/**
 * The rules a runner serving several calls cannot get wrong.
 *
 * Each is a way one call could damage another: a retry starting a second call into one
 * room, a failure in one conversation unwinding the others, a drain cutting off a call
 * mid-sentence, a stop that leaves a call running untracked, or a call served on a
 * configuration its record will not match.
 */

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

/** A call that runs until something ends it. */
function controllable(): {
  handle: CallHandle;
  delivered: HostMessage[];
  end: () => void;
  closed: string[];
  graces: number[];
} {
  const closed: string[] = [];
  const delivered: HostMessage[] = [];
  const graces: number[] = [];
  let resolve!: () => void;
  const ended = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    closed,
    graces,
    delivered,
    end: () => resolve(),
    handle: {
      ended,
      update: settingsNotUnderTest,
      deliver: async (message) => {
        delivered.push(message);
      },
      close: async (reason: string, graceMs: number) => {
        closed.push(reason);
        graces.push(graceMs);
        resolve();
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function spec(sessionId: string, extra: Partial<StartCallSpec> = {}): StartCallSpec {
  return { sessionId, realtimeUrl: "wss://x", realtimeToken: "t", ...extra };
}

function registry(options: {
  maxSessions?: number;
  deploymentId?: string;
  configurationVersion?: number;
  startCall?: (spec: StartCallSpec) => Promise<CallHandle>;
  onDrain?: (active: number) => void;
  reporters?: HostedCallReporter[];
  warn?: (message: string) => void;
} = {}) {
  const started: string[] = [];
  const reg = new SessionRegistry({
    identity: {
      maxSessions: options.maxSessions ?? 3,
      ...(options.deploymentId === undefined ? {} : { deploymentId: options.deploymentId }),
      ...(options.configurationVersion === undefined
        ? {}
        : { configurationVersion: options.configurationVersion }),
    },
    startCall: async (s) => {
      started.push(s.sessionId);
      return options.startCall ? options.startCall(s) : controllable().handle;
    },
    makeReporter: () => {
      const reporter = fakeReporter();
      options.reporters?.push(reporter);
      return reporter;
    },
    ...(options.onDrain ? { onDrain: options.onDrain } : {}),
    log: () => {},
    ...(options.warn ? { warn: options.warn } : {}),
  });
  return { reg, started };
}

describe("SessionRegistry", () => {
  it("answers a retry with the original acceptance, never a second call", async () => {
    const { reg, started } = registry();

    await reg.start(spec("a"));
    const again = await reg.start(spec("a"));

    // A repeat that started a second call into the same room would put two agents on one
    // caller.
    expect(again).toMatchObject({ ok: true, accepted: false });
    expect(started).toEqual(["a"]);
    expect(reg.status().activeSessions).toBe(1);
  });

  it("treats a retry as a repeat even once it is full", async () => {
    const { reg } = registry({ maxSessions: 1 });
    await reg.start(spec("a"));

    // Idempotence is checked BEFORE capacity. Refusing here would make the host start a
    // second runner for a call this one is already serving.
    expect(await reg.start(spec("a"))).toMatchObject({ ok: true, accepted: false });
    expect(await reg.start(spec("b"))).toMatchObject({ ok: false, code: "runner_at_capacity" });
  });

  it("refuses a call pinned to a different configuration", async () => {
    const { reg, started } = registry({ configurationVersion: 7 });

    const outcome = await reg.start(spec("a", { configurationVersion: 8 }));

    // This runner's environment holds version 7; serving the call would record a
    // configuration that is not what actually served it.
    expect(outcome).toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(outcome.ok === false && outcome.detail).toContain("configurationVersion 7");
    expect(started).toEqual([]);
  });

  it("refuses a call pinned to another deployment even when the version matches", async () => {
    const { reg, started } = registry({ deploymentId: "dep-a", configurationVersion: 7 });

    const outcome = await reg.start(spec("a", { deploymentId: "dep-b", configurationVersion: 7 }));

    // Versions are counted per deployment, so two deployments agreeing on one is ordinary.
    expect(outcome).toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(outcome.ok === false && outcome.detail).toContain("dep-a");
    expect(started).toEqual([]);
  });

  it("compares a deployment only when the runner and the call both name one", async () => {
    const pinned = registry({ deploymentId: "dep-a" });
    expect(await pinned.reg.start(spec("a"))).toMatchObject({ ok: true, accepted: true });
    expect(await pinned.reg.start(spec("b", { deploymentId: "dep-a" }))).toMatchObject({
      ok: true,
      accepted: true,
    });

    // A runner started without an id cannot know it is not the addressed runner.
    const anonymous = registry();
    expect(await anonymous.reg.start(spec("c", { deploymentId: "dep-b" }))).toMatchObject({
      ok: true,
      accepted: true,
    });
  });

  it("frees the slot when a call that never started fails", async () => {
    const { reg } = registry({
      maxSessions: 1,
      startCall: async (s) => {
        if (s.sessionId === "a") throw new Error("the room rejected the token");
        return controllable().handle;
      },
    });

    expect(await reg.start(spec("a"))).toMatchObject({ ok: false, code: "start_failed" });
    // Left in `starting` it would hold the only slot forever.
    expect(reg.status().activeSessions).toBe(0);
    expect(await reg.start(spec("b"))).toMatchObject({ ok: true, accepted: true });
  });

  it("ends one call without touching the others, passing the reason and grace", async () => {
    const a = controllable();
    const b = controllable();
    const calls = new Map([["a", a], ["b", b]]);
    const { reg } = registry({ startCall: async (s) => calls.get(s.sessionId)!.handle });

    await reg.start(spec("a"));
    await reg.start(spec("b"));
    expect(await reg.stop("a", "operator_stop", 2500)).toBe(true);

    expect(a.closed).toEqual(["operator_stop"]);
    expect(a.graces).toEqual([2500]);
    expect(b.closed).toEqual([]);
    expect(reg.list().map((c) => c.sessionId)).toEqual(["b"]);
  });

  it("stops with no grace unless one is given", async () => {
    const a = controllable();
    const { reg } = registry({ startCall: async () => a.handle });
    await reg.start(spec("a"));
    await reg.stop("a", "operator_stop");
    expect(a.graces).toEqual([0]);
  });

  it("survives one call failing, and keeps serving the rest", async () => {
    const a = controllable();
    const failing: CallHandle = {
      ended: Promise.reject(new Error("the agent threw mid-call")),
      update: settingsNotUnderTest,
      deliver: async () => {},
      close: async () => {},
    };
    const calls = new Map<string, CallHandle>([["a", a.handle], ["bad", failing]]);
    const { reg } = registry({ startCall: async (s) => calls.get(s.sessionId)! });

    await reg.start(spec("a"));
    await reg.start(spec("bad"));
    await tick();

    // One conversation failing must cost that conversation only.
    expect(reg.get("bad")).toBeNull();
    expect(reg.get("a")?.state).toBe("connected");
  });

  it("reports the call as ended however it ended", async () => {
    const reporters: HostedCallReporter[] = [];
    const a = controllable();
    const { reg } = registry({ startCall: async () => a.handle, reporters });

    await reg.start(spec("a"));
    a.end();
    await tick();

    expect(reporters[0]!.finish).toHaveBeenCalledWith("completed");
  });
});

describe("a stop that arrives while the call is still starting", () => {
  it("closes the call once it connects, never reports it running, and holds its slot until then", async () => {
    const reporters: HostedCallReporter[] = [];
    const joining = deferred<CallHandle>();
    const a = controllable();
    const { reg, started } = registry({
      maxSessions: 1,
      reporters,
      startCall: (s) => (s.sessionId === "a" ? joining.promise : Promise.resolve(controllable().handle)),
    });

    const starting = reg.start(spec("a"));
    await tick();
    expect(reg.get("a")?.state).toBe("starting");

    const stopping = reg.stop("a", "host_stop", 1500);
    await tick();
    expect(reg.get("a")?.state).toBe("ending");
    // The room join is still in flight, so the slot is still taken: admitting a second
    // call now would put two calls on a runner that allows one.
    expect(await reg.start(spec("b"))).toMatchObject({ ok: false, code: "runner_at_capacity" });

    joining.resolve(a.handle);

    // The call was stopped, so it must not be reported as running.
    expect(await starting).toEqual({
      ok: false,
      code: "start_failed",
      detail: "stopped while starting",
    });
    expect(await stopping).toBe(true);
    expect(a.closed).toEqual(["host_stop"]);
    expect(a.graces).toEqual([1500]);
    expect(reporters[0]!.finish).toHaveBeenCalledTimes(1);
    expect(reporters[0]!.finish).toHaveBeenCalledWith("host_stop");
    expect(reg.status().activeSessions).toBe(0);

    // Only now, with the first call gone, is there room for another.
    expect(await reg.start(spec("b"))).toMatchObject({ ok: true, accepted: true });
    expect(started).toEqual(["a", "b"]);
  });

  it("closes it exactly once when the stop is repeated", async () => {
    const joining = deferred<CallHandle>();
    const a = controllable();
    const { reg } = registry({ startCall: () => joining.promise });

    const starting = reg.start(spec("a"));
    await tick();
    const first = reg.stop("a", "host_stop");
    const second = reg.stop("a", "host_stop_retry");
    joining.resolve(a.handle);

    expect(await starting).toMatchObject({ ok: false, code: "start_failed" });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(a.closed).toEqual(["host_stop"]);
  });

  it("retires the call when the start then fails", async () => {
    const joining = deferred<CallHandle>();
    const { reg } = registry({ startCall: () => joining.promise });

    const starting = reg.start(spec("a"));
    await tick();
    const stopping = reg.stop("a", "host_stop");
    joining.reject(new Error("the room went away"));

    expect(await starting).toMatchObject({ ok: false, code: "start_failed" });
    expect(await stopping).toBe(true);
    expect(reg.status().activeSessions).toBe(0);
  });
});

describe("drain", () => {
  it("drains without cutting off a call in progress", async () => {
    const a = controllable();
    const { reg } = registry({ startCall: async () => a.handle });
    await reg.start(spec("a"));

    let drained = false;
    void reg.drain().then(() => {
      drained = true;
    });
    await tick();

    // The call keeps going and new ones are refused.
    expect(reg.get("a")?.state).toBe("connected");
    expect(drained).toBe(false);
    expect(await reg.start(spec("b"))).toMatchObject({ ok: false, code: "runner_draining" });

    a.end();
    await tick();
    expect(drained).toBe(true);
  });

  it("is idempotent: every call returns the same promise, and all of them resolve", async () => {
    const a = controllable();
    const onDrain = vi.fn();
    const { reg } = registry({ startCall: async () => a.handle, onDrain });
    await reg.start(spec("a"));

    const first = reg.drain();
    const second = reg.drain();
    expect(second).toBe(first);
    expect(reg.drained).toBe(first);
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(onDrain).toHaveBeenCalledWith(1);

    const settled: string[] = [];
    void first.then(() => settled.push("first"));
    void second.then(() => settled.push("second"));
    a.end();
    await tick();
    expect(settled).toEqual(["first", "second"]);
    // And a drain requested after it emptied is already resolved.
    await expect(reg.drain()).resolves.toBeUndefined();
  });

  it("resolves at once on an empty runner", async () => {
    const { reg } = registry();
    await expect(reg.drain()).resolves.toBeUndefined();
  });
});

describe("SessionRegistry.deliver", () => {
  const message = (id: string, extra: Partial<HostMessage> = {}): HostMessage => ({
    id,
    name: "human.decision",
    payload: { disposition: "allowed", reason: "ok" },
    ...extra,
  });

  /** A connected call whose agent refuses every message with `code`. */
  function refusing(code: MessageRefusalCode): CallHandle {
    return {
      ended: new Promise<void>(() => {}),
      update: settingsNotUnderTest,
      deliver: async (m) => {
        throw new MessageRefusedError(code, { key: m.name, from: "host" }, "refused", {
          ...(code === "invalid_payload" ? { issues: [{ path: ["reason"], message: "Required" }] } : {}),
        });
      },
      close: async () => {},
    };
  }

  it("hands a message to its call once, and answers a repeat id as not delivered", async () => {
    const a = controllable();
    const { reg } = registry({ startCall: async () => a.handle });
    await reg.start(spec("a"));

    expect(await reg.deliver("a", message("m-1"))).toEqual({ ok: true, delivered: true });
    expect(await reg.deliver("a", message("m-1"))).toEqual({ ok: true, delivered: false });
    expect(a.delivered.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("answers session_not_found for an unknown or ended call", async () => {
    const a = controllable();
    const { reg } = registry({ startCall: async () => a.handle });
    expect(await reg.deliver("nobody", message("m-1"))).toMatchObject({ ok: false, code: "session_not_found" });

    await reg.start(spec("a"));
    await reg.stop("a", "done");
    expect(await reg.deliver("a", message("m-2"))).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("keeps two calls' messages apart, even with the same message id", async () => {
    const a = controllable();
    const b = controllable();
    const calls = new Map([["a", a.handle], ["b", b.handle]]);
    const { reg } = registry({ startCall: async (s) => calls.get(s.sessionId)! });
    await reg.start(spec("a"));
    await reg.start(spec("b"));

    await reg.deliver("a", message("m-1", { name: "ops.for_a" }));
    expect(await reg.deliver("b", message("m-1", { name: "ops.for_b" }))).toEqual({ ok: true, delivered: true });

    expect(a.delivered.map((m) => m.name)).toEqual(["ops.for_a"]);
    expect(b.delivered.map((m) => m.name)).toEqual(["ops.for_b"]);
  });

  it.each(["no_handler", "invalid_payload", "handler_failed"] as const)(
    "answers the agent's %s refusal with its code, and keeps no id so a retry is delivered",
    async (code) => {
      let handle = refusing(code);
      const { reg } = registry({ startCall: async () => ({ ...handle, deliver: (m) => handle.deliver(m) }) });
      await reg.start(spec("a"));

      const refused = await reg.deliver("a", message("m-1"));
      expect(refused).toMatchObject({ ok: false, code, detail: expect.stringContaining(code) });
      if (code === "invalid_payload") {
        expect(refused).toMatchObject({ issues: [{ path: ["reason"], message: "Required" }] });
      }

      handle = controllable().handle;
      expect(await reg.deliver("a", message("m-1"))).toEqual({ ok: true, delivered: true });
    },
  );

  it("answers handler_failed when the call's delivery itself breaks", async () => {
    const { reg } = registry({
      startCall: async () => ({
        ended: new Promise<void>(() => {}),
        update: settingsNotUnderTest,
        deliver: async () => {
          throw new Error("the runtime is gone");
        },
        close: async () => {},
      }),
    });
    await reg.start(spec("a"));
    expect(await reg.deliver("a", message("m-1"))).toMatchObject({
      ok: false,
      code: "handler_failed",
      detail: expect.stringContaining("the runtime is gone"),
    });
  });

  it("queues messages for a call still starting and delivers them in order once it connects", async () => {
    const a = controllable();
    const connecting = deferred<CallHandle>();
    const { reg } = registry({ startCall: () => connecting.promise });
    const starting = reg.start(spec("a"));
    await tick();
    expect(reg.get("a")?.state).toBe("starting");

    expect(await reg.deliver("a", message("m-1"))).toEqual({ ok: true, delivered: true });
    expect(await reg.deliver("a", message("m-2"))).toEqual({ ok: true, delivered: true });
    expect(await reg.deliver("a", message("m-1"))).toEqual({ ok: true, delivered: false });
    expect(a.delivered).toEqual([]);

    connecting.resolve(a.handle);
    await starting;
    expect(a.delivered.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  it("warns about and counts a queued message the agent refuses once connected", async () => {
    const warnings: string[] = [];
    const connecting = deferred<CallHandle>();
    const reporters: HostedCallReporter[] = [];
    const { reg } = registry({ startCall: () => connecting.promise, warn: (line) => warnings.push(line), reporters });
    const starting = reg.start(spec("a"));
    await tick();

    // Accepted while starting: the host already has its 202.
    expect(await reg.deliver("a", message("m-1"))).toEqual({ ok: true, delivered: true });
    connecting.resolve(refusing("no_handler"));
    await starting;
    await tick();

    // Counted in the call's own record, written as curb.messages when it ends.
    expect(reporters[0]?.count).toHaveBeenCalledWith({ refusedQueuedHostMessages: 1 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("m-1");
    expect(warnings[0]).toContain("no_handler");
  });

  it("refuses rather than drops a message past the starting queue's bound", async () => {
    const connecting = deferred<CallHandle>();
    const { reg } = registry({ startCall: () => connecting.promise });
    void reg.start(spec("a"));
    await tick();

    for (let i = 0; i < MAX_QUEUED_HOST_MESSAGES; i += 1) {
      expect(await reg.deliver("a", message(`m-${i}`))).toMatchObject({ ok: true, delivered: true });
    }
    const refused = await reg.deliver("a", message("m-over"));
    expect(refused).toMatchObject({ ok: false, code: "runner_at_capacity" });

    // The refused id was not taken, so a retry after connect is delivered.
    const a = controllable();
    connecting.resolve(a.handle);
    await tick();
    expect(await reg.deliver("a", message("m-over"))).toEqual({ ok: true, delivered: true });
    expect(a.delivered).toHaveLength(MAX_QUEUED_HOST_MESSAGES + 1);
  });
});
