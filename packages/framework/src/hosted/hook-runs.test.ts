import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CallEvent, CallHook } from "../hooks.js";
import { buildCallEvent } from "../testing/hooks.js";
import { HookRuns, hookErrorMessage, invokeHook, type HookRunsOptions } from "./hook-runs.js";
import type { HookRunRequest } from "./protocol.js";

/**
 * Customer code runs here, so every way it can end has to land on a status a host can read, and
 * none of them may reach the process.
 */

const ended = buildCallEvent("call.ended");

function request(runId: string, event: CallEvent = ended, deadlineMs = 1_000): HookRunRequest {
  return { runId, event, deadlineMs };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runsOf(hook: CallHook, options: Partial<HookRunsOptions> = {}) {
  const logs: string[] = [];
  const runs = new HookRuns({
    hooks: { afterCall: hook },
    log: (message) => logs.push(message),
    env: {},
    ...options,
  });
  return { runs, logs };
}

describe("invokeHook", () => {
  it("calls the hook with the call and the event it came from", async () => {
    const hook = vi.fn(async () => {});
    await expect(invokeHook(hook, ended, 1_000)).resolves.toEqual({ state: "succeeded" });
    expect(hook).toHaveBeenCalledWith(ended.data.object, ended);
    expect(hook.mock.calls[0]).toHaveLength(2);
  });

  it("reads a throw before the first await as a failure, not as a crash", async () => {
    const boom = new Error("boom");
    await expect(
      invokeHook(
        () => {
          throw boom;
        },
        ended,
        1_000,
      ),
    ).resolves.toEqual({ state: "failed", timedOut: false, cause: boom });
  });

  it("does not mistake what a hook returns for its deadline", async () => {
    const hook = (async () => "timeout") as unknown as CallHook;
    await expect(invokeHook(hook, ended, 1_000)).resolves.toEqual({ state: "succeeded" });
  });

  it("reports a hook past its deadline, and what became of it later", async () => {
    const late = deferred();
    const heard: unknown[] = [];
    const outcome = await invokeHook(() => late.promise, ended, 5, (cause) => heard.push(cause));
    expect(outcome).toMatchObject({ state: "failed", timedOut: true });

    const gone = new Error("crm down");
    late.reject(gone);
    await vi.waitFor(() => expect(heard).toEqual([gone]));
  });
});

describe("hookErrorMessage", () => {
  const SECRET = "not-a-real-value-for-redaction";

  it("is the message of an Error, or a thrown string", () => {
    expect(hookErrorMessage(new Error("crm down"), {})).toBe("crm down");
    expect(hookErrorMessage("crm down", {})).toBe("crm down");
  });

  it("carries no stack, even one an error holds in its message", () => {
    const inner = new Error("crm down");
    expect(hookErrorMessage(new Error(inner.stack), {})).toBe("Error: crm down");
    expect(hookErrorMessage(new Error(`crm down\n    at fetch (node:internal)`), {})).toBe("crm down");
  });

  it("carries no value of the environment", () => {
    const message = hookErrorMessage(new Error(`401 with key ${SECRET} on /calls`), { CRM_KEY: SECRET });
    expect(message).toBe("401 with key [redacted] on /calls");
  });

  it("takes out the longest value first, so a value inside another leaves no tail", () => {
    const env = { SHORT: "abcdef", LONG: "abcdefghij" };
    expect(hookErrorMessage(new Error("key abcdefghij"), env)).toBe("key [redacted]");
  });

  it("leaves a short value alone: it is more likely a word than a secret", () => {
    expect(hookErrorMessage(new Error("it is true"), { FLAG: "true" })).toBe("it is true");
  });

  it("says nothing of a thrown object, which could hold anything", () => {
    expect(hookErrorMessage({ apiKey: SECRET }, {})).toBe("the hook threw a value of type object, not an Error");
    expect(hookErrorMessage(null, {})).toBe("the hook threw null, not an Error");
    expect(hookErrorMessage(undefined, {})).toBe("the hook threw a value of type undefined, not an Error");
  });

  it("survives a message that cannot be read", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("no");
      },
    });
    expect(hookErrorMessage(hostile, {})).toBe("the hook threw a value that cannot be read");
  });

  it("is bounded, and never empty", () => {
    expect(hookErrorMessage(new Error("x".repeat(5_000)), {})).toHaveLength(1024);
    expect(hookErrorMessage(new Error(""), {})).toBe("the hook failed with no message");
  });
});

describe("HookRuns", () => {
  it("reads running until the hook ends, then succeeded", async () => {
    const gate = deferred();
    const { runs } = runsOf(() => gate.promise);
    expect(runs.start("afterCall", request("r1"))).toEqual({ ok: true, runId: "r1" });
    expect(runs.status("r1")).toEqual({ runId: "r1", state: "running" });
    expect(runs.running).toBe(1);

    gate.resolve();
    await runs.settled();
    expect(runs.status("r1")).toEqual({ runId: "r1", state: "succeeded" });
    expect(runs.running).toBe(0);
  });

  it("reads failed with the message, and keeps the stack for its own log", async () => {
    const { runs, logs } = runsOf(async () => {
      throw new Error("crm down");
    });
    runs.start("afterCall", request("r1"));
    await runs.settled();
    expect(runs.status("r1")).toEqual({ runId: "r1", state: "failed", error: { message: "crm down" } });
    expect(logs.join("\n")).toContain("hook-runs.test.ts");
  });

  it("keeps the environment out of its own log too", async () => {
    const { runs, logs } = runsOf(
      async () => {
        throw new Error("key not-a-real-value-for-redaction refused");
      },
      { env: { CRM_KEY: "not-a-real-value-for-redaction" } },
    );
    runs.start("afterCall", request("r1"));
    await runs.settled();
    expect(logs.join("\n")).not.toContain("not-a-real-value-for-redaction");
    expect(runs.status("r1")?.error?.message).toBe("key [redacted] refused");
  });

  it("reads failed with exactly timeout past the deadline, whatever the environment holds", async () => {
    const gate = deferred();
    const { runs } = runsOf(() => gate.promise, { env: { MODE: "timeout" } });
    runs.start("afterCall", request("r1", ended, 5));
    await runs.settled();
    expect(runs.status("r1")).toEqual({ runId: "r1", state: "failed", error: { message: "timeout" } });
  });

  it("stays timed out when the hook finishes after all, and logs that it did", async () => {
    const gate = deferred();
    const { runs, logs } = runsOf(() => gate.promise);
    runs.start("afterCall", request("r1", ended, 5));
    await runs.settled();

    gate.resolve();
    await vi.waitFor(() => expect(logs.join("\n")).toContain("finished after its deadline"));
    expect(runs.status("r1")?.state).toBe("failed");
  });

  it("runs one id once, while running and after it ended", async () => {
    const hook = vi.fn(async () => {});
    const { runs } = runsOf(hook);
    expect(runs.start("afterCall", request("r1"))).toEqual({ ok: true, runId: "r1" });
    expect(runs.start("afterCall", request("r1"))).toEqual({ ok: true, runId: "r1" });
    await runs.settled();
    expect(runs.start("afterCall", request("r1"))).toEqual({ ok: true, runId: "r1" });
    await runs.settled();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("refuses a hook this build does not declare", () => {
    const { runs } = runsOf(async () => {});
    expect(runs.start("afterEvaluation", request("r1", buildCallEvent("call.evaluated")))).toMatchObject({
      ok: false,
      code: "hook_not_declared",
    });
    expect(runs.status("r1")).toBeNull();
  });

  it("refuses a new run while draining, still answers a repeat, and waits for what is running", async () => {
    const gate = deferred();
    const { runs } = runsOf(() => gate.promise);
    runs.start("afterCall", request("r1"));
    runs.drain();
    expect(runs.start("afterCall", request("r2"))).toMatchObject({ ok: false, code: "runner_draining" });
    expect(runs.start("afterCall", request("r1"))).toEqual({ ok: true, runId: "r1" });

    let settled = false;
    const waiting = runs.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    gate.resolve();
    await waiting;
  });

  it("forgets the oldest finished runs, and never one still running", async () => {
    const gate = deferred();
    let calls = 0;
    const { runs } = runsOf(() => (++calls === 1 ? gate.promise : Promise.resolve()));
    runs.start("afterCall", request("held"));
    for (let index = 0; index < 1_100; index += 1) runs.start("afterCall", request(`r${index}`));
    await vi.waitFor(() => expect(runs.running).toBe(1));

    expect(runs.status("r0")).toBeNull();
    expect(runs.status("r1099")?.state).toBe("succeeded");
    expect(runs.status("held")?.state).toBe("running");
    gate.resolve();
  });
});

describe("HookRuns.guardProcess", () => {
  it("keeps a real process alive through a floating rejection and a throw in a timer", () => {
    // In a process of its own, because the test runner handles both failures itself: this is the
    // one check that Node's default, which ends the process, does not get to run.
    const script = `
      const { HookRuns } = await import(${JSON.stringify(fileURLToPath(new URL("./hook-runs.ts", import.meta.url)))});
      const runs = new HookRuns({
        hooks: {
          afterCall: () => {
            void Promise.reject(new Error("floating"));
            setTimeout(() => { throw new Error("in a timer"); }, 1);
            return new Promise(() => {});
          },
        },
        log: () => {},
      });
      runs.guardProcess();
      const event = { type: "call.ended", data: { object: {} } };
      runs.start("afterCall", { runId: "stray", event, deadlineMs: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      runs.start("afterCall", { runId: "next", event, deadlineMs: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      console.log(JSON.stringify(runs.status("stray")));
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ runId: "stray", state: "failed", error: { message: "floating" } });
  });

  /** Stands in for `process`, so the test need not raise a real uncaught exception. */
  const fakeProcess = () => new EventEmitter() as unknown as NodeJS.Process;

  it.each(["uncaughtException", "unhandledRejection"])("takes %s, failing the run in progress", async (signal) => {
    const gate = deferred();
    const { runs, logs } = runsOf(() => gate.promise);
    const target = fakeProcess();
    const remove = runs.guardProcess(target);
    runs.start("afterCall", request("r1"));

    target.emit(signal as "uncaughtException", new Error("thrown in a timer"), "uncaughtException");
    expect(runs.status("r1")).toEqual({ runId: "r1", state: "failed", error: { message: "thrown in a timer" } });
    expect(logs.join("\n")).toContain("thrown in a timer");

    remove();
    expect((target as unknown as EventEmitter).listenerCount(signal)).toBe(0);
    gate.resolve();
  });

  it("leaves a run that already succeeded as it is, and logs what came after", async () => {
    const { runs, logs } = runsOf(async () => {});
    const target = fakeProcess();
    runs.guardProcess(target);
    runs.start("afterCall", request("r1"));
    await runs.settled();

    (target as unknown as EventEmitter).emit("unhandledRejection", new Error("a floating promise"));
    expect(runs.status("r1")?.state).toBe("succeeded");
    expect(logs.join("\n")).toContain("a floating promise");
  });
});
