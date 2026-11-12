import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import type { AgentRunResponse, AgentTurnStreamEvent } from "./llm/types.js";
import { createInsuranceDemoRuntime } from "./test-fixtures/insurance-runtime.js";

/**
 * A project that sets up an OpenTelemetry SDK sees every tool run as a span, nested under whatever
 * span was active when the turn ran (the voice pipeline's `llm_node` on a LiveKit call). The
 * turn's tool event carries the same run time, which is what a call's record stores.
 */

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

async function turn(responses: AgentRunResponse[]) {
  let step = 0;
  const llm = vi.fn<AgentLlmClient>(async () => responses[step++] ?? { text: "", toolCalls: [] });
  const session = new AgentSession(createInsuranceDemoRuntime(), llm);
  const events: AgentTurnStreamEvent[] = [];
  for await (const event of session.runTurnStream("My roof is damaged")) events.push(event);
  return events.flatMap((event) => (event.type === "tool" ? [event] : []));
}

describe("tool spans", () => {
  it("makes each tool run a span under the active one, timed like its tool event", async () => {
    const tools = await trace.getTracer("test").startActiveSpan("llm_node", async (parent) => {
      try {
        return await turn([
          { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
          { text: "Is everyone safe?", toolCalls: [] },
        ]);
      } finally {
        parent.end();
      }
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]!.ok).toBe(true);
    expect(tools[0]!.durationMs).toBeGreaterThanOrEqual(0);

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === "llm_node")!;
    const tool = spans.find((span) => span.name === "execute_tool read_skill")!;
    expect(tool.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "read_skill",
      "gen_ai.tool.type": "function",
      "curb.tool.ok": true,
    });
    // Never the caller's data: no arguments, no result.
    expect(Object.keys(tool.attributes).some((key) => key.includes("argument") || key.includes("result"))).toBe(false);
    expect(tool.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it("marks a failed tool result on its span", async () => {
    const tools = await turn([
      { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/no-such-skill" } }] },
      { text: "Sorry.", toolCalls: [] },
    ]);

    expect(tools[0]!.ok).toBe(false);
    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes).toMatchObject({ "curb.tool.ok": false, "error.type": "tool_error" });
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("gives a call that never ran no span and no run time", async () => {
    const tools = await turn([
      { text: "", toolCalls: [{ name: "no_such_tool", input: {} }] },
      { text: "Sorry.", toolCalls: [] },
    ]);

    expect(tools[0]!.ok).toBe(false);
    expect(tools[0]).not.toHaveProperty("durationMs");
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
