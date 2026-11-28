import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSession } from "../agent-session.js";
import { Agent, AgentSiteRuntime, GlobalTools, Mcp } from "../index.js";
import { configureMcp, getMcpManager, preloadMcpTools } from "../mcp/manager.js";
import { formatMcpToolsSnapshot, MCP_TOOLS_FILE, mcpToolsSnapshot, type McpToolsSnapshot } from "../mcp/snapshot.js";
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

const roots: string[] = [];
/** A project of its own for the call, with `snapshot` as its mcp.tools.json (none when left out). */
function project(snapshot?: McpToolsSnapshot): void {
  const root = mkdtempSync(join(tmpdir(), "curb-hermetic-"));
  roots.push(root);
  if (snapshot) writeFileSync(join(root, MCP_TOOLS_FILE), formatMcpToolsSnapshot(snapshot));
  vi.stubEnv("AGENT_PROJECT_DIR", root);
}

afterEach(() => {
  configureMcp([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  /** A host whose agent shows the tools of the "orders" server, and of `inline` when given. */
  const mcpHost = (script: () => AgentRunResponse[], inline?: { id: string; url: string }): TestHost => ({
    async createBundle(options) {
      const runtime = new AgentSiteRuntime(
        <Agent>
          <GlobalTools>
            <Mcp id="orders" />
            {inline ? <Mcp id={inline.id} url={inline.url} /> : null}
          </GlobalTools>
        </Agent>,
        { mcpTools: options?.mcpTools },
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
    project(snapshot);
    configureMcp([{ id: "orders", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } }]);

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
    // The process's own manager was never asked to connect.
    expect(getMcpManager().resolve("orders").status).toBe("disconnected");
  });

  it("is refused before turn 1 when the server is not in mcp.tools.json", async () => {
    project(mcpToolsSnapshot({}));
    configureMcp([{ id: "orders", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } }]);
    await expect(startCall({ host: mcpHost(() => []), hermetic: true })).rejects.toThrow(
      'startCall: [MCP_TOOLS_MISSING] MCP server "orders" is not in mcp.tools.json',
    );
  });

  it("is refused when the host builds an agent that leaves mcp.tools.json out while a server is known", async () => {
    project(snapshot);
    configureMcp([{ id: "orders", url: "http://127.0.0.1:9/mcp", auth: { kind: "none" } }]);
    const host: TestHost = {
      async createBundle() {
        const runtime = new AgentSiteRuntime(<Agent />);
        return { runtime, session: new AgentSession(runtime, steps([])) };
      },
      simulator: () => async () => says(""),
    };
    await expect(startCall({ host, hermetic: true })).rejects.toThrow("startCall: [CURB_TEST_HOST_NOT_HERMETIC]");
  });
});

describe("a hermetic call beside live ones", () => {
  /** The live "orders" server, in process: it lists list_refunds, which the snapshot does not. */
  function ordersServer(): McpServer {
    const server = new McpServer({ name: "orders", version: "0.0.0" });
    server.registerTool("list_refunds", { description: "List the open refunds.", inputSchema: { since: z.string().optional() } }, async () => ({
      content: [{ type: "text", text: "No open refunds." }],
    }));
    return server;
  }
  const snapshot = mcpToolsSnapshot({
    orders: [{ name: "find_order", description: "Find an order by its id.", inputSchema: { type: "object", properties: { id: { type: "string" } } } }],
  });
  const host = (script: () => AgentRunResponse[], inline?: string): TestHost => ({
    async createBundle(options) {
      const runtime = new AgentSiteRuntime(
        <Agent>
          <GlobalTools>
            <Mcp id="orders" />
            {inline ? <Mcp id="billing" url={inline} /> : null}
          </GlobalTools>
        </Agent>,
        { mcpTools: options?.mcpTools },
      );
      return { runtime, session: new AgentSession(runtime, steps(script())) };
    },
    simulator: () => async () => says(""),
  });
  const mcpToolsOf = (call: Awaited<ReturnType<typeof startCall>>) => (call.record().tools ?? []).map((tool) => tool.name).filter((name) => name.includes("__"));
  const live = async () => {
    configureMcp([{ id: "orders", createServer: ordersServer }]);
    await preloadMcpTools();
  };
  const refunds = () => [calls({ name: "orders__list_refunds", input: {} }), says("You have no open refunds.")];

  it("leaves a live call after it on the live server's tools, which run", async () => {
    project(snapshot);
    await live();
    const hermetic = await startCall({ host: host(() => []), hermetic: true });
    expect(mcpToolsOf(hermetic)).toEqual(["orders__find_order"]);

    const after = await startCall({ host: host(refunds) });
    expect(mcpToolsOf(after)).toEqual(["orders__list_refunds"]);
    const turn = await after.say("Any refunds?");
    expect(turn.errors).toEqual([]);
    expect(turn.toolCalls).toMatchObject([{ name: "orders__list_refunds", ok: true }]);
  });

  it("offers only the snapshot's tools after a live call connected the server", async () => {
    project(snapshot);
    await live();
    const before = await startCall({ host: host(refunds) });
    expect((await before.say("Any refunds?")).toolCalls).toMatchObject([{ name: "orders__list_refunds", ok: true }]);

    const hermetic = await startCall({ host: host(() => []), hermetic: true });
    expect(mcpToolsOf(hermetic)).toEqual(["orders__find_order"]);
    expect(getMcpManager().resolve("orders")).toMatchObject({ status: "ready", tools: [{ name: "list_refunds" }] });
  });

  it("keeps calls that run at the same time apart", async () => {
    project(snapshot);
    await live();
    const [hermetic, other] = await Promise.all([
      startCall({ host: host(() => [calls({ name: "orders__list_refunds", input: {} }), says("Done.")]), hermetic: true }),
      startCall({ host: host(refunds) }),
    ]);
    const [stopped, ran] = await Promise.all([hermetic.say("Any refunds?"), other.say("Any refunds?")]);

    expect(mcpToolsOf(hermetic)).toEqual(["orders__find_order"]);
    expect(mcpToolsOf(other)).toEqual(["orders__list_refunds"]);
    // The hermetic agent does not have the live tool, so its call fails there; the live one runs.
    expect(stopped.toolCalls).toMatchObject([{ name: "orders__list_refunds", ok: false }]);
    expect(ran.toolCalls).toMatchObject([{ name: "orders__list_refunds", ok: true }]);
  });

  it("does not register an inline server it renders first with the process's manager", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network is off");
    });
    vi.stubGlobal("fetch", fetch);
    project(snapshot);
    await live();
    await expect(startCall({ host: host(() => [], "http://127.0.0.1:9/mcp"), hermetic: true })).rejects.toThrow(
      '[MCP_TOOLS_MISSING] MCP server "billing" is not in mcp.tools.json',
    );
    expect(getMcpManager().serverIds()).toEqual(["orders"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
