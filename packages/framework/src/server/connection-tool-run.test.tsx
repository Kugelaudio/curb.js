import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { Agent, AgentSiteRuntime, Tool, defineTool, z } from "../index.js";
import { unexpectedToolFailureMessage } from "../runtime.js";
import { createInsuranceDemoRuntime } from "../test-fixtures/insurance-runtime.js";
import { ConnectionController } from "./connection.js";
import type { PreviewAgent, ServerMessage, ToolRun } from "./protocol.js";

/**
 * The preview's "Try" dialog shows what a test run of a tool returned. The run happens on the
 * connection's inspector runtime, so the frame that answers `call_tool` has to carry it: the
 * page has no other way to learn the tool's result.
 */

const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });
const preview = (id: string): PreviewAgent => ({ id, source: "", preview: {}, skills: [] });

afterEach(() => {
  vi.restoreAllMocks();
});

function controllerFor(createRuntime: () => AgentSiteRuntime) {
  const runtime = createRuntime();
  const session = new AgentSession(runtime, idleLlm);
  const sent: ServerMessage[] = [];
  const controller = new ConnectionController((message) => sent.push(message), {
    runtime,
    session,
    agentHost: {
      ids: ["agent"],
      initialId: "agent",
      create: async () => ({ runtime, session }),
      createRuntime: async () => createRuntime(),
      preview,
    },
  });
  controller.start();
  return { controller, session, sent };
}

function inspectFrames(sent: readonly ServerMessage[]) {
  return sent.flatMap((message) => (message.type === "inspect_context" ? [message] : []));
}

function lastToolRun(sent: readonly ServerMessage[]): ToolRun | undefined {
  return inspectFrames(sent).at(-1)?.toolRun;
}

describe("a tool's test run", () => {
  it("answers with the result the tool returned and how long it took", async () => {
    const { controller, session, sent } = controllerFor(createInsuranceDemoRuntime);

    await controller.handle({
      type: "call_tool",
      name: "request_callback",
      input: { name: "Ada", phone: "0301234", topic: "My claim" },
    });

    const run = lastToolRun(sent);
    expect(run).toMatchObject({
      name: "request_callback",
      result: { ok: true, data: { name: "Ada", phone: "0301234", topic: "My claim" } },
    });
    expect(run).not.toHaveProperty("error");
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    // The conversation never sees a test run.
    expect(session.messages).toEqual([]);
  });

  it("reports a tool that throws as an error, with no result", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const explode = defineTool({
      name: "explode",
      description: "Always throws.",
      schema: z.object({}),
      onSubmit: async () => {
        throw new Error("database is down");
      },
    });
    const { controller, sent } = controllerFor(
      () =>
        new AgentSiteRuntime(
          (
            <Agent>
              <Tool def={explode} />
            </Agent>
          ),
        ),
    );

    await controller.handle({ type: "call_tool", name: "explode", input: {} });

    const run = lastToolRun(sent);
    expect(run).toMatchObject({ name: "explode", error: unexpectedToolFailureMessage("explode") });
    expect(run).not.toHaveProperty("result");
    expect(run?.durationMs).toBeGreaterThanOrEqual(0);
    // The raw error stays in the developer's log; it is not what the page shows.
    expect(consoleError).toHaveBeenCalled();
    expect(JSON.stringify(run)).not.toContain("database is down");
  });

  it("puts a run only on the frame that answers it, never on browsing", async () => {
    const { controller, sent } = controllerFor(createInsuranceDemoRuntime);

    await controller.handle({ type: "inspect_skill", skill: "/policy-questions" });

    expect(inspectFrames(sent).map((frame) => frame.toolRun)).toEqual([undefined]);
  });
});
