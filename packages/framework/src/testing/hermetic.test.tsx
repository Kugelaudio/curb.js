import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../agent-session.js";
import { Agent, AgentSiteRuntime, GlobalTools, Mcp } from "../index.js";
import { configureMcp, offerMcpToolsFrom, preloadMcpTools } from "../mcp/manager.js";
import { mcpToolsSnapshot } from "../mcp/snapshot.js";
import { addTask, calls, sendSummary, says, steps, tasksBundle } from "../test-fixtures/tasks.js";
import { converse, scriptedCaller, startCall, type TestHost } from "./index.js";
import type { AgentRunResponse } from "../llm/types.js";

/** A host on the task agent playing `script` afresh on every bundle; `send` is its `send_summary`'s handler. */
function tasksHost(script: () => AgentRunResponse[]) {
  const send = vi.fn(async () => ({ ok: true, message: "Sent." }));
  const host: TestHost = {
    async createBundle() {
      return tasksBundle(steps(script()), send);
    },
    simulator: () => async () => says(""),
  };
  return { host, send };
}

afterEach(() => {
  offerMcpToolsFrom(null);
  configureMcp([]);
  vi.unstubAllGlobals();
});

describe("fakes for tools the agent does not have", () => {
  it("are an error before turn 1, naming the tools it has; a fake that exists but is unused stays a note", async () => {
    const { host } = tasksHost(() => [says("Hello.")]);
    await expect(startCall({ host, fakes: { send_email: { ok: true } } })).rejects.toThrow(
      'startCall: [CURB_TEST_UNKNOWN_FAKE] fakes.send_email: the agent has no tool "send_email" (it has "add_task", "send_summary")',
    );

    const call = await startCall({ host, fakes: { send_summary: { ok: true } } });
    await call.say("Hi");
    expect(call.record().unusedFakes).toEqual(["send_summary"]);
  });
});

describe("a hermetic call", () => {
  it("stops at a tool without a fake, as an error, before the tool's onSubmit runs", async () => {
    const { host, send } = tasksHost(() => [calls(sendSummary("sam@example.com")), says("Sent it to Sam."), says("Anything else?")]);
    const call = await startCall({ host, hermetic: true });
    const played = await converse(call, scriptedCaller(["Send my list to Sam.", "Thanks."]));

    expect(send).not.toHaveBeenCalled();
    expect(played.ending).toMatchObject({ by: "error" });
    expect(played.ending.reason).toContain('[CURB_TEST_UNFAKED_TOOL] hermetic: the agent called "send_summary", which has no fake');
    expect(played.turns).toHaveLength(1);
    expect(played.turns[0]!.toolCalls).toMatchObject([{ name: "send_summary", ok: false }]);
    // The turn was cut off at the call: the model was not asked again.
    expect(played.turns[0]!.reply).not.toContain("Sent it to Sam.");
    expect(call.ended).toBe(true);
    await expect(call.say("Hello?")).rejects.toThrow("call.say: the call has ended: [CURB_TEST_UNFAKED_TOOL]");
  });

  it("runs faked tools and the agent's state as usual", async () => {
    const { host, send } = tasksHost(() => [calls(addTask("milk"), sendSummary("sam@example.com")), says("Done.")]);
    const call = await startCall({ host, hermetic: true, fakes: { add_task: { ok: true }, send_summary: { ok: true, message: "Sent (fake)." } } });
    const turn = await call.say("Add milk and send the list to Sam.");

    expect(turn.errors).toEqual([]);
    expect(turn.reply).toBe("Done.");
    expect(send).not.toHaveBeenCalled();
    expect(call.record().ending.by).toBe("caller");
  });

  it("without hermetic, a tool without a fake still runs for real", async () => {
    const { host, send } = tasksHost(() => [calls(sendSummary("sam@example.com")), says("Sent.")]);
    const call = await startCall({ host });
    expect((await call.say("Send my list to Sam.")).errors).toEqual([]);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("a hermetic call with an MCP tool", () => {
  const snapshot = mcpToolsSnapshot({
    orders: [
      {
        name: "find_order",
        description: "Find an order by its id.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    ],
  });
  const mcpHost = (script: () => AgentRunResponse[]): TestHost => ({
    async createBundle() {
      const runtime = new AgentSiteRuntime(
        <Agent>
          <GlobalTools>
            <Mcp id="orders" />
          </GlobalTools>
        </Agent>,
      );
      return { runtime, session: new AgentSession(runtime, steps(script())) };
    },
    simulator: () => async () => says(""),
  });

  it("offers the tools of mcp.tools.json and passes with the network off", async () => {
    // Nothing listens there, and no request may leave the process.
    const fetch = vi.fn(async () => {
      throw new Error("network is off");
    });
    vi.stubGlobal("fetch", fetch);
    offerMcpToolsFrom(snapshot);
    configureMcp([{ id: "orders", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } }]);
    await preloadMcpTools();

    const call = await startCall({
      host: mcpHost(() => [calls({ name: "orders__find_order", input: { id: "A-1042" } }), says("Order A-1042 is paid.")]),
      hermetic: true,
      fakes: { orders__find_order: { ok: true, data: { id: "A-1042", paid: 49 } } },
    });
    const turn = await call.say("Where is my order A-1042?");

    expect(turn.errors).toEqual([]);
    expect(turn.toolCalls).toMatchObject([{ name: "orders__find_order", ok: true }]);
    expect(turn.reply).toBe("Order A-1042 is paid.");
    expect(call.record().tools?.map((tool) => tool.name)).toContain("orders__find_order");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is refused before turn 1 when the server is not in mcp.tools.json", async () => {
    offerMcpToolsFrom(mcpToolsSnapshot({}));
    configureMcp([{ id: "orders", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } }]);
    await preloadMcpTools();
    await expect(startCall({ host: mcpHost(() => []), hermetic: true })).rejects.toThrow(
      'startCall: [MCP_TOOLS_MISSING] MCP server "orders" is not in mcp.tools.json',
    );
  });
});
