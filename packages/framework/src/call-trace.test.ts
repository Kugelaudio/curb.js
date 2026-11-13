import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { attachCallTrace, callTraceOf, startCallTrace } from "./call-trace.js";
import type { AgentRunResponse, AgentTurnStreamEvent } from "./llm/types.js";
import { createInsuranceDemoRuntime } from "./test-fixtures/insurance-runtime.js";

/**
 * A call is one trace: the call is its root span, and each stay in a skill, each procedure,
 * each transfer and each tool run is a span under it.
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

const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().find((span) => span.name === name)!;
const attributes = () => ({ "gen_ai.agent.name": "insurance" });

describe("a call's trace", () => {
  it("is one root span named after the agent, ended once, with what is known by then", () => {
    let conversationId: string | undefined;
    const call = startCallTrace(
      () => ({ "gen_ai.agent.name": "insurance", ...(conversationId ? { "gen_ai.conversation.id": conversationId } : {}) }),
      { "curb.call.channel": "phone" },
    );
    conversationId = "conv-1";
    call.end();
    call.end();

    expect(spans()).toHaveLength(1);
    const root = named("invoke_agent insurance");
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "insurance",
      "gen_ai.conversation.id": "conv-1",
      "curb.call.channel": "phone",
    });
  });

  it("makes each stay in a skill a span under the call, ended by the next skill or the call", () => {
    const call = startCallTrace(attributes);
    call.skill({ action: "loaded", path: "/booking", title: "Booking" });
    call.skill({ action: "loaded", path: "/refunds", title: "Refunds" });
    expect(spans().map((span) => span.name)).toEqual(["curb.skill /booking"]);
    call.skill({ action: "exited", path: "/refunds", title: "Refunds" });
    call.skill({ action: "loaded", path: "/booking", title: "Booking" });
    call.end();

    const root = named("invoke_agent insurance");
    const stays = spans().filter((span) => span.name.startsWith("curb.skill"));
    expect(stays.map((span) => span.name)).toEqual(["curb.skill /booking", "curb.skill /refunds", "curb.skill /booking"]);
    for (const stay of stays) expect(stay.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(stays[0]!.attributes).toMatchObject({ "curb.skill.path": "/booking", "curb.skill.title": "Booking", "gen_ai.agent.name": "insurance" });
  });

  it("follows a procedure from its start to its completion, each step an event", () => {
    const call = startCallTrace(attributes);
    call.procedure({ action: "started", title: "Claim", step: 1, steps: 2 });
    call.procedure({ action: "step_completed", title: "Claim", step: 1, steps: 2, stepTitle: "Safety" });
    call.procedure({ action: "step_completed", title: "Claim", step: 2, steps: 2, stepTitle: "Evidence" });
    call.procedure({ action: "completed", title: "Claim", step: 2, steps: 2 });
    call.end();

    const procedure = named("curb.procedure Claim");
    expect(procedure.attributes).toMatchObject({ "curb.procedure.title": "Claim", "curb.procedure.steps": 2, "curb.procedure.step": 2, "curb.procedure.completed": true });
    expect(procedure.events.map((event) => [event.name, event.attributes])).toEqual([
      ["step_completed", { "curb.procedure.step": 1, "curb.procedure.step.title": "Safety" }],
      ["step_completed", { "curb.procedure.step": 2, "curb.procedure.step.title": "Evidence" }],
    ]);
  });

  it("ends a procedure nobody finished as not completed, at the step it stopped on", () => {
    const call = startCallTrace(attributes);
    call.procedure({ action: "started", title: "Left", step: 1, steps: 3 });
    call.procedure({ action: "step_completed", title: "Left", step: 1, steps: 3 });
    call.procedure({ action: "left", title: "Left", step: 2, steps: 3 });
    call.procedure({ action: "started", title: "Open", step: 1, steps: 3 });
    call.end();

    expect(named("curb.procedure Left").attributes).toMatchObject({ "curb.procedure.completed": false, "curb.procedure.step": 2 });
    expect(named("curb.procedure Open").attributes).toMatchObject({ "curb.procedure.completed": false, "curb.procedure.step": 1 });
  });

  it("ends a transfer nobody answered with its outcome", () => {
    const call = startCallTrace(attributes);
    call.transfer().outcome("no_answer");
    expect(named("curb.transfer").attributes).toMatchObject({ "curb.transfer.outcome": "no_answer" });
    expect(named("curb.transfer").attributes).not.toHaveProperty("curb.transfer.ended");
    call.end();
  });

  it("keeps an answered transfer open until the agent has the call back", () => {
    const call = startCallTrace(attributes);
    const transfer = call.transfer();
    // The target can join before the dial's result arrives.
    call.transferHandedOff();
    transfer.outcome("answered");
    expect(spans()).toEqual([]);
    call.transferEnded("resumed");
    call.end();

    const span = named("curb.transfer");
    expect(span.attributes).toMatchObject({ "curb.transfer.outcome": "answered", "curb.transfer.ended": "resumed" });
    expect(span.events.map((event) => event.name)).toEqual(["handed_off"]);
    expect(span.parentSpanContext?.spanId).toBe(named("invoke_agent insurance").spanContext().spanId);
  });

  it("ends a transfer still on the line with the call", () => {
    const call = startCallTrace(attributes);
    call.transfer().outcome("answered");
    call.end();
    expect(named("curb.transfer").attributes).toMatchObject({ "curb.transfer.outcome": "answered", "curb.transfer.ended": "call_ended" });
  });

  it("tells its observer what each transfer came to and how long the dial took", () => {
    vi.useFakeTimers();
    try {
      const outcomes: Array<[string, number]> = [];
      const call = startCallTrace(attributes, {}, { transfer: (outcome, durationMs) => outcomes.push([outcome, durationMs]) });
      const first = call.transfer();
      vi.advanceTimersByTime(7000);
      first.outcome("answered");
      // Asked for again while the first is under way: its host refuses it at once.
      call.transfer().outcome("refused");
      call.end();
      expect(outcomes).toEqual([["answered", 7000], ["refused", 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts nothing once the call has ended", () => {
    const call = startCallTrace(attributes);
    call.end();
    exporter.reset();
    call.skill({ action: "loaded", path: "/booking", title: "Booking" });
    call.procedure({ action: "started", title: "Claim", step: 1, steps: 2 });
    call.transfer().outcome("no_answer");
    call.end();
    expect(spans()).toEqual([]);
  });
});

async function turn(session: AgentSession) {
  const events: AgentTurnStreamEvent[] = [];
  for await (const event of session.runTurnStream("My roof is damaged")) events.push(event);
  return events;
}

function sessionOnCall(responses: AgentRunResponse[]) {
  let step = 0;
  const llm = vi.fn<AgentLlmClient>(async () => responses[step++] ?? { text: "", toolCalls: [] });
  const runtime = createInsuranceDemoRuntime();
  const session = new AgentSession(runtime, llm, { traceAttributes: attributes });
  const call = startCallTrace(() => session.spanAttributes());
  attachCallTrace(runtime.info, call);
  return { session, runtime, call };
}

describe("a session on a call", () => {
  it("puts its tool runs, skills and procedures into the call's trace, and reports the procedure", async () => {
    const stage = { name: "complete_claim_procedure_stage", input: {} };
    const { session, runtime, call } = sessionOnCall([
      { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/claim-procedure" } }] },
      { text: "", toolCalls: [stage] },
      { text: "", toolCalls: [stage] },
      { text: "", toolCalls: [stage] },
      { text: "All done.", toolCalls: [] },
    ]);
    expect(callTraceOf(runtime.info)).toBe(call);

    const events = await turn(session);
    call.end();

    const title = "Three-step claim reporting order";
    const procedure = events.flatMap((event) => (event.type === "procedure" ? [`${event.action} ${event.step}/${event.steps}`] : []));
    expect(procedure).toEqual(["started 1/3", "step_completed 1/3", "step_completed 2/3", "step_completed 3/3", "completed 3/3"]);
    expect(events.find((event) => event.type === "procedure")).toMatchObject({ title });

    const root = named("invoke_agent insurance");
    const inCall = spans().filter((span) => span.parentSpanContext?.spanId === root.spanContext().spanId).map((span) => span.name);
    expect(inCall).toEqual([
      "execute_tool read_skill",
      "execute_tool complete_claim_procedure_stage",
      "execute_tool complete_claim_procedure_stage",
      "execute_tool complete_claim_procedure_stage",
      `curb.procedure ${title}`,
      "curb.skill /claim-procedure",
    ]);
    expect(named(`curb.procedure ${title}`).attributes).toMatchObject({ "curb.procedure.completed": true, "curb.procedure.steps": 3 });
    expect(new Set(spans().map((span) => span.spanContext().traceId)).size).toBe(1);
  });

  it("keeps a tool run under the span that asked for it when that span is in the call's trace", async () => {
    const { session, call } = sessionOnCall([
      { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
      { text: "Is everyone safe?", toolCalls: [] },
    ]);
    await call.run(() =>
      trace.getTracer("pipeline").startActiveSpan("llm_node", async (pipeline) => {
        await turn(session);
        pipeline.end();
      }),
    );
    call.end();

    expect(named("execute_tool read_skill").parentSpanContext?.spanId).toBe(named("llm_node").spanContext().spanId);
    expect(named("llm_node").parentSpanContext?.spanId).toBe(named("invoke_agent insurance").spanContext().spanId);
  });

  it("puts a tool run under the call when the active span belongs to another trace", async () => {
    const { session, call } = sessionOnCall([
      { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
      { text: "Is everyone safe?", toolCalls: [] },
    ]);
    await trace.getTracer("elsewhere").startActiveSpan("unrelated", async (other) => {
      await turn(session);
      other.end();
    });
    call.end();

    const tool = named("execute_tool read_skill");
    expect(tool.parentSpanContext?.spanId).toBe(named("invoke_agent insurance").spanContext().spanId);
    expect(tool.spanContext().traceId).not.toBe(named("unrelated").spanContext().traceId);
  });
});
