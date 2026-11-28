import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../agent-session.js";
import { mcpCommand, connectWithin } from "../cli/mcp.js";
import { Agent, AgentSiteRuntime, GlobalTools, Mcp } from "../index.js";
import { configureMcp, getMcpManager } from "../mcp/manager.js";
import { MCP_TOOLS_FILE, parseMcpToolsSnapshot } from "../mcp/snapshot.js";
import { calls, says, steps } from "../test-fixtures/tasks.js";
import { startCall, type TestHost } from "./index.js";

const SERVER = fileURLToPath(new URL("../test-fixtures/mcp-orders-server.mjs", import.meta.url));

/** The in-repo orders MCP server in a child process: its URL and every request it has answered. */
async function startOrdersServer(): Promise<{ child: ChildProcess; url: string; requests: string[] }> {
  const child = spawn(process.execPath, [SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  const requests: string[] = [];
  const url = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the orders MCP server exited with ${code}`)));
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (line.startsWith("listening ")) resolve(`http://127.0.0.1:${line.slice("listening ".length)}/mcp`);
        else if (line.startsWith("request ")) requests.push(line.slice("request ".length));
      }
    });
  });
  return { child, url, requests };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  configureMcp([]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("curb mcp snapshot, then a hermetic call", () => {
  it("snapshots a real local MCP server, then offers its tool from mcp.tools.json without connecting to it", async () => {
    const server = await startOrdersServer();
    cleanups.push(() => void server.child.kill());
    const root = mkdtempSync(join(tmpdir(), "curb-mcp-roundtrip-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    vi.stubEnv("AGENT_PROJECT_DIR", root);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // `curb mcp snapshot`: the agent declares the server; the command connects it for real.
    configureMcp([{ id: "orders", url: server.url, auth: { kind: "none" } }]);
    const printed: string[] = [];
    const code = await mcpCommand(["snapshot"], root, {
      connect: () => connectWithin(() => getMcpManager().connectAll(), getMcpManager, 10_000),
      out: (text) => void printed.push(text),
    });

    expect(code).toBe(0);
    expect(printed.join("")).toBe("Wrote mcp.tools.json: orders (1 tool). Commit it.\n");
    const written = parseMcpToolsSnapshot(readFileSync(join(root, MCP_TOOLS_FILE), "utf8"));
    expect(written.servers.orders!.tools).toMatchObject([{ name: "find_order", description: "Find an order by its id." }]);
    expect(server.requests.some((request) => request.includes("tools/list"))).toBe(true);

    // A fresh test process: the server is declared again but not connected.
    await getMcpManager().close();
    configureMcp([]);
    configureMcp([{ id: "orders", url: server.url, auth: { kind: "none" } }]);

    // A hermetic call of an agent showing that server: its tool comes from the file.
    const answered = server.requests.length;
    const fetch = vi.spyOn(globalThis, "fetch");
    const host: TestHost = {
      async createBundle(options) {
        const runtime = new AgentSiteRuntime(
          <Agent>
            <GlobalTools>
              <Mcp id="orders" url={server.url} />
            </GlobalTools>
          </Agent>,
          { mcpTools: options?.mcpTools },
        );
        return { runtime, session: new AgentSession(runtime, steps([calls({ name: "orders__find_order", input: { id: "A-1042" } }), says("Order A-1042 is paid.")])) };
      },
      simulator: () => async () => says(""),
    };
    const call = await startCall({ host, hermetic: true, fakes: { orders__find_order: { ok: true, data: { id: "A-1042", paid: true } } } });
    const turn = await call.say("Where is my order A-1042?");

    expect(turn.errors).toEqual([]);
    expect(turn.toolCalls).toMatchObject([{ name: "orders__find_order", ok: true }]);
    expect(turn.reply).toBe("Order A-1042 is paid.");
    expect(call.record().tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "orders__find_order", description: expect.stringContaining("Find an order by its id.") })]),
    );
    // Nothing reached the server, nor left the process, while the call ran.
    expect(server.requests.length).toBe(answered);
    expect(fetch).not.toHaveBeenCalled();
    await call.close?.();
  });
});
