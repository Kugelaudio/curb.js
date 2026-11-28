import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMcpManager } from "../mcp/manager.js";
import { startOrdersMcpServer } from "../test-fixtures/orders-mcp-process.js";
import { projectHost, startCall } from "./index.js";

/** A project whose one skill shows the orders server inline, with its mcp.tools.json. */
const PROJECT = fileURLToPath(new URL("../test-fixtures/inline-mcp-project", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

describe("a hermetic call on a cold project host", () => {
  it("connects no inline <Mcp url> while the host discovers the agent and checks its authoring", async () => {
    const server = await startOrdersMcpServer();
    cleanups.push(() => void server.child.kill());
    vi.stubEnv("ORDERS_MCP_URL", server.url);
    // The agent needs a key to start; nothing here reaches the model.
    vi.stubEnv("KUGELAUDIO_API_KEY", "test-key");
    // The host prepares the project itself and sets AGENT_PROJECT_DIR outside the stub.
    const before = process.env.AGENT_PROJECT_DIR;
    cleanups.push(() => void (process.env.AGENT_PROJECT_DIR = before));
    vi.stubEnv("AGENT_PROJECT_DIR", PROJECT);

    // The first call builds the project's agent: discovery, the authoring diagnostics (which
    // render every skill, /orders with its inline server too), then the call's own runtime.
    const call = await startCall({ host: projectHost(), hermetic: true });
    expect(call.ended).toBe(false);
    // A connect would have sent its initialize request by now.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.requests).toEqual([]);
    expect(getMcpManager().serverIds()).not.toContain("orders");
  });
});
