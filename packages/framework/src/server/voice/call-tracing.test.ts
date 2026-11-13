import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSession } from "../../agent-session.js";
import { callTraceOf } from "../../call-trace.js";
import { createInsuranceDemoRuntime } from "../../test-fixtures/insurance-runtime.js";
import type { AgentSessionBundle } from "../connection.js";
import { traceCall } from "./call-tracing.js";
import type { VoiceSessionHandle } from "./orchestration.js";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});

afterAll(() => {
  trace.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

function bundle(): AgentSessionBundle {
  const runtime = createInsuranceDemoRuntime();
  const session = new AgentSession(runtime, async () => ({ text: "", toolCalls: [] }), {
    traceAttributes: () => ({ "gen_ai.agent.name": "insurance" }),
  });
  return { runtime, session };
}

function handle(): VoiceSessionHandle {
  return { close: vi.fn(async () => {}), clips: {} as VoiceSessionHandle["clips"], sendText: vi.fn(async () => {}), setBundle: vi.fn(), interrupt: vi.fn() };
}

describe("a traced call", () => {
  it("writes what a transfer came to, and the number it went to, in the call's record", async () => {
    const call = bundle();
    const event = vi.fn();
    const reporter = { turn: vi.fn(), event, finish: vi.fn(async () => {}), undelivered: 0 };
    await traceCall({ bundle: call, reporter }, async () => handle());

    callTraceOf(call.runtime.info)!.transfer("+493012345678").outcome("no_answer");

    expect(event).toHaveBeenCalledTimes(1);
    const [name, payload, durationMs] = event.mock.calls[0]!;
    expect([name, payload]).toEqual(["transfer", { outcome: "no_answer", to: "+493012345678" }]);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("spans the session from before it starts until it has closed", async () => {
    const call = bundle();
    call.runtime.updateInfo({ "caller.phoneNumber": "+491701234567", "call.direction": "inbound" });
    const onClosed = vi.fn();
    let closed = () => {};
    let activeAtStart: string | undefined;

    await traceCall({ bundle: call, onClosed }, async (options) => {
      activeAtStart = trace.getSpan(context.active())?.spanContext().traceId;
      closed = options.onClosed!;
      return handle();
    });

    expect(callTraceOf(call.runtime.info)).toBeDefined();
    expect(exporter.getFinishedSpans()).toEqual([]);
    closed();

    const [root] = exporter.getFinishedSpans();
    expect(root!.name).toBe("invoke_agent insurance");
    expect(root!.spanContext().traceId).toBe(activeAtStart);
    expect(root!.attributes).toMatchObject({ "curb.call.channel": "phone", "curb.call.direction": "inbound" });
    // Whether the caller is on a phone, never the number.
    expect(JSON.stringify(root!.attributes)).not.toContain("491701234567");
    expect(callTraceOf(call.runtime.info)).toBeUndefined();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("moves with the call onto a rebuilt runtime", async () => {
    const first = bundle();
    const next = bundle();
    const inner = handle();
    const traced = await traceCall({ bundle: first }, async () => inner);
    const callTrace = callTraceOf(first.runtime.info);

    traced.setBundle(next);

    expect(callTraceOf(first.runtime.info)).toBeUndefined();
    expect(callTraceOf(next.runtime.info)).toBe(callTrace);
    expect(inner.setBundle).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("ends the trace of a session that could not start", async () => {
    const call = bundle();
    await expect(traceCall({ bundle: call }, async () => Promise.reject(new Error("no room")))).rejects.toThrow("no room");
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["invoke_agent insurance"]);
    expect(callTraceOf(call.runtime.info)).toBeUndefined();
  });
});
