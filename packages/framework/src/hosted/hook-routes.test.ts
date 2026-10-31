import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCallEvent } from "../testing/hooks.js";
import { HookRuns } from "./hook-runs.js";
import { MAX_HOOK_BODY_BYTES, startManagementServer, type ManagementServer } from "./management-server.js";
import { DrainResponse, ErrorBody, HookRunResponse, HookRunStatus, RunnerStatus, type ErrorCode } from "./protocol.js";
import { SessionRegistry } from "./session-registry.js";

/**
 * The hook routes as a host drives them: over the real port, every answer parsed with the schema
 * it claims to be.
 */

const TOKEN = "hook-routes-token";

let server: ManagementServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** A hook runner as `runManaged` builds one: managed, with no `startCall`. */
function hookRegistry(): SessionRegistry {
  return new SessionRegistry({ identity: { maxSessions: 1, role: "hooks" } });
}

async function serve(registry: SessionRegistry | null, hooks?: HookRuns): Promise<void> {
  server = await startManagementServer(registry, {
    address: "127.0.0.1:0",
    token: TOKEN,
    ...(hooks === undefined ? {} : { hooks }),
  });
}

function hookRuns(hooks: ConstructorParameters<typeof HookRuns>[0]["hooks"]): HookRuns {
  return new HookRuns({ hooks, log: () => {}, env: {} });
}

function call(path: string, method = "GET", body?: unknown, token = TOKEN): Promise<{ status: number; body: string }> {
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
          authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function expectRefused(answer: { status: number; body: string }, status: number, code: ErrorCode): void {
  expect(answer.status).toBe(status);
  expect(ErrorBody.parse(JSON.parse(answer.body)).error).toBe(code);
}

const ended = buildCallEvent("call.ended");
const evaluated = buildCallEvent("call.evaluated");
const after = (runId: string, event: unknown = ended) => ({ runId, event, deadlineMs: 1_000 });

async function runStatus(runId: string) {
  const answer = await call(`/v1/hooks/runs/${encodeURIComponent(runId)}`);
  expect(answer.status).toBe(200);
  return HookRunStatus.parse(JSON.parse(answer.body));
}

describe("POST /v1/hooks/{name}", () => {
  it("accepts, runs the hook once however often it is sent, and reads succeeded", async () => {
    const hook = vi.fn(async () => {});
    await serve(hookRegistry(), hookRuns({ afterCall: hook }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = await call("/v1/hooks/afterCall", "POST", after("run-1"));
      expect(answer.status).toBe(202);
      expect(HookRunResponse.parse(JSON.parse(answer.body))).toEqual({ runId: "run-1", accepted: true });
    }

    await vi.waitFor(async () => expect((await runStatus("run-1")).state).toBe("succeeded"));
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("reads failed with the message when the hook throws, and stays up", async () => {
    await serve(
      hookRegistry(),
      hookRuns({
        afterCall: async () => {
          throw new Error("crm down");
        },
      }),
    );
    await call("/v1/hooks/afterCall", "POST", after("run-1"));
    await vi.waitFor(async () => expect((await runStatus("run-1")).state).toBe("failed"));
    expect((await runStatus("run-1")).error).toEqual({ message: "crm down" });
    expect((await call("/health")).status).toBe(200);
  });

  it("hands the hook fields this build does not know, as a webhook would receive them", async () => {
    const hook = vi.fn(async () => {});
    await serve(hookRegistry(), hookRuns({ afterCall: hook }));
    const event = { ...ended, added_later: 1, data: { object: { ...ended.data.object, added_too: 2 } } };

    await call("/v1/hooks/afterCall", "POST", after("run-1", event));
    await vi.waitFor(async () => expect((await runStatus("run-1")).state).toBe("succeeded"));
    expect(hook).toHaveBeenCalledWith(event.data.object, event);
  });

  it("refuses a hook this build does not declare, and a name no hook has", async () => {
    await serve(hookRegistry(), hookRuns({ afterCall: async () => {} }));
    expectRefused(await call("/v1/hooks/afterEvaluation", "POST", after("run-1", evaluated)), 404, "hook_not_declared");
    expectRefused(await call("/v1/hooks/afterHours", "POST", after("run-2")), 404, "hook_not_declared");
  });

  it("says a hook is not declared before it looks at which event came", async () => {
    await serve(hookRegistry(), hookRuns({ afterCall: async () => {} }));
    expectRefused(await call("/v1/hooks/afterEvaluation", "POST", after("run-1", ended)), 404, "hook_not_declared");
  });

  it("refuses a body that is not a run", async () => {
    await serve(hookRegistry(), hookRuns({ afterCall: async () => {} }));
    expectRefused(await call("/v1/hooks/afterCall", "POST", "{not json"), 400, "invalid_request");
    expectRefused(await call("/v1/hooks/afterCall", "POST", { runId: "run-1" }), 400, "invalid_request");
    expectRefused(await call("/v1/hooks/afterCall", "POST", { ...after("run-1"), deadlineMs: 0 }), 400, "invalid_request");
    expectRefused(await call("/v1/hooks/afterCall", "POST", { ...after("run-1"), deadlineMs: 2 ** 31 }), 400, "invalid_request");
  });

  it("refuses the other hook's event, which would hand it goals it does not expect", async () => {
    const hook = vi.fn(async () => {});
    await serve(hookRegistry(), hookRuns({ afterCall: hook }));
    const answer = await call("/v1/hooks/afterCall", "POST", after("run-1", evaluated));
    expectRefused(answer, 400, "invalid_request");
    expect(answer.body).toContain("afterCall receives call.ended");
    expect(hook).not.toHaveBeenCalled();
  });

  it("takes a body of exactly the limit and answers 413 one byte past it", async () => {
    const hook = vi.fn(async () => {});
    await serve(hookRegistry(), hookRuns({ afterCall: hook }));
    const padded = (size: number, runId: string) => {
      const body = JSON.stringify(after(runId));
      return `${body.slice(0, -1)}${" ".repeat(size - body.length)}}`;
    };

    expect(Buffer.byteLength(padded(MAX_HOOK_BODY_BYTES, "fits"))).toBe(MAX_HOOK_BODY_BYTES);
    expect((await call("/v1/hooks/afterCall", "POST", padded(MAX_HOOK_BODY_BYTES, "fits"))).status).toBe(202);
    expectRefused(await call("/v1/hooks/afterCall", "POST", padded(MAX_HOOK_BODY_BYTES + 1, "over")), 413, "payload_too_large");
    expectRefused(await call("/v1/hooks/runs/over"), 404, "hook_run_not_found");
  });

  it("answers an oversized body sent in many chunks, then still serves", async () => {
    await serve(hookRegistry(), hookRuns({ afterCall: async () => {} }));
    const chunk = "x".repeat(64 * 1024);
    const [host, port] = server!.address.split(":");
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { host, port: Number(port), path: "/v1/hooks/afterCall", method: "POST", headers: { authorization: `Bearer ${TOKEN}` } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (data: Buffer) => chunks.push(data));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      for (let index = 0; index < 40; index += 1) req.write(chunk);
      req.end();
    });
    expectRefused(answer, 413, "payload_too_large");
    expect((await call("/health")).status).toBe(200);
  });

  it("refuses a new run on a draining runner", async () => {
    const runs = hookRuns({ afterCall: async () => {} });
    runs.drain();
    await serve(hookRegistry(), runs);
    expectRefused(await call("/v1/hooks/afterCall", "POST", after("run-1")), 503, "runner_draining");
  });

  it("requires the token", async () => {
    const hook = vi.fn(async () => {});
    await serve(hookRegistry(), hookRuns({ afterCall: hook }));
    expectRefused(await call("/v1/hooks/afterCall", "POST", after("run-1"), "wrong"), 401, "unauthorized");
    expectRefused(await call("/v1/hooks/runs/run-1", "GET", undefined, "wrong"), 401, "unauthorized");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("GET /v1/hooks/runs/{id}", () => {
  it("answers 404 for a run this runner does not hold", async () => {
    await serve(hookRegistry(), hookRuns({ afterCall: async () => {} }));
    expectRefused(await call("/v1/hooks/runs/nobody"), 404, "hook_run_not_found");
  });

  it("decodes the id, and reads a malformed one as no route", async () => {
    await serve(hookRegistry(), hookRuns({ afterCall: async () => {} }));
    await call("/v1/hooks/afterCall", "POST", after("a/b c"));
    expect((await runStatus("a/b c")).runId).toBe("a/b c");
    expectRefused(await call("/v1/hooks/runs/%zz"), 404, "not_found");
  });
});

describe("a runner that takes calls", () => {
  it("answers both routes with 501, with or without a registry", async () => {
    for (const registry of [new SessionRegistry({ startCall: async () => ({}) as never }), null]) {
      await serve(registry);
      expectRefused(await call("/v1/hooks/afterCall", "POST", after("run-1")), 501, "runner_takes_no_hooks");
      expectRefused(await call("/v1/hooks/runs/run-1"), 501, "runner_takes_no_hooks");
      await server?.close();
      server = null;
    }
  });

  it("reports no role in its status", async () => {
    await serve(new SessionRegistry({ startCall: async () => ({}) as never }));
    const answer = await call("/v1/runner");
    expect(answer.status).toBe(200);
    expect(RunnerStatus.parse(JSON.parse(answer.body))).not.toHaveProperty("role");
  });
});

describe("a hook runner", () => {
  it("refuses calls but is managed like any runner", async () => {
    const registry = hookRegistry();
    await serve(registry, hookRuns({}));

    expectRefused(await call("/v1/sessions", "POST", { sessionId: "s" }), 501, "runner_takes_no_calls");

    const status = await call("/v1/runner");
    expect(status.status).toBe(200);
    expect(RunnerStatus.parse(JSON.parse(status.body)).role).toBe("hooks");

    const drained = await call("/v1/runner/drain", "POST");
    expect(drained.status).toBe(202);
    expect(DrainResponse.parse(JSON.parse(drained.body))).toEqual({ draining: true, activeSessions: 0 });
    await registry.drained;
  });
});
