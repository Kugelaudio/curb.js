import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import type { AgentRunResponse, AgentTurnStreamEvent } from "./llm/types.js";
import { createInsuranceDemoRuntime } from "./test-fixtures/insurance-runtime.js";
import { traceToolRun } from "./tool-span.js";

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

async function turnEvents(
  responses: AgentRunResponse[],
  options: ConstructorParameters<typeof AgentSession>[2] = {},
  runtime = createInsuranceDemoRuntime(),
) {
  let step = 0;
  const llm = vi.fn<AgentLlmClient>(async () => responses[step++] ?? { text: "", toolCalls: [] });
  // The tracer the server hands its sessions (`server/bootstrap.ts`).
  const session = new AgentSession(runtime, llm, { traceTool: traceToolRun, ...options });
  const events: AgentTurnStreamEvent[] = [];
  for await (const event of session.runTurnStream("My roof is damaged")) events.push(event);
  return events;
}

async function turn(responses: AgentRunResponse[], options: ConstructorParameters<typeof AgentSession>[2] = {}) {
  return (await turnEvents(responses, options)).flatMap((event) => (event.type === "tool" ? [event] : []));
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
    expect(Number.isInteger(tools[0]!.durationMs)).toBe(true);

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

  it("names the agent and the conversation, read when the span starts", async () => {
    let conversationId: string | null = null;
    await turn(
      [
        { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
        { text: "Is everyone safe?", toolCalls: [] },
      ],
      {
        traceAttributes: () => ({
          "gen_ai.agent.name": "insurance",
          ...(conversationId ? { "gen_ai.conversation.id": conversationId } : {}),
        }),
      },
    );
    expect(exporter.getFinishedSpans()[0]!.attributes).not.toHaveProperty("gen_ai.conversation.id");

    exporter.reset();
    conversationId = "conv-1";
    await turn(
      [
        { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
        { text: "Is everyone safe?", toolCalls: [] },
      ],
      { traceAttributes: () => ({ "gen_ai.agent.name": "insurance", "gen_ai.conversation.id": conversationId! }) },
    );
    expect(exporter.getFinishedSpans()[0]!.attributes).toMatchObject({
      "gen_ai.agent.name": "insurance",
      "gen_ai.conversation.id": "conv-1",
      "gen_ai.tool.name": "read_skill",
    });
  });

  it("says which skill a tool run entered, on its span and as a skill event after the tool's", async () => {
    const events = await turnEvents([
      { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
      { text: "Is everyone safe?", toolCalls: [] },
    ]);
    const kinds = events.flatMap((event) => (event.type === "tool" || event.type === "skill" ? [event.type] : []));
    expect(kinds).toEqual(["tool", "skill"]);
    expect(events.find((event) => event.type === "skill")).toMatchObject({ action: "loaded", path: "/property-damage" });
    expect(exporter.getFinishedSpans()[0]!.attributes["curb.skill.entered"]).toBe("/property-damage");
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

  it("names the class of an error a handler threw, and nothing of its message", async () => {
    const runtime = createInsuranceDemoRuntime();
    runtime.fakeTools({
      read_skill: async () => {
        throw new TypeError("no policy for Jane Doe");
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await turnEvents(
        [{ text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] }, { text: "Sorry.", toolCalls: [] }],
        {},
        runtime,
      );
    } finally {
      logged.mockRestore();
    }

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes).toMatchObject({ "curb.tool.ok": false, "error.type": "TypeError" });
    expect(span!.events.map((event) => [event.name, event.attributes])).toEqual([["exception", { "exception.type": "TypeError" }]]);
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(JSON.stringify([span!.attributes, span!.events, span!.status])).not.toContain("Jane");
  });

  it("times a tool run and makes no span in a session that was handed no tracer", async () => {
    const events = await turnEvents(
      [{ text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] }, { text: "Is everyone safe?", toolCalls: [] }],
      { traceTool: undefined },
    );
    const tool = events.find((event) => event.type === "tool");
    expect(tool).toMatchObject({ ok: true, durationMs: expect.any(Number) });
    expect(exporter.getFinishedSpans()).toEqual([]);
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
