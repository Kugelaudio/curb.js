import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSiteRuntime, GlobalTools, Instruction, Mcp, Agent } from "../index.js";
import { createLinearDemoServer } from "./demo-server.js";
import {
  MCP_SIGN_IN_HOLD_MS,
  McpManager,
  configureMcp,
  mcpTokenEnvVar,
  preloadMcpTools,
  resolveImplicitAuth,
  setMcpOAuthSignInUrl,
} from "./manager.js";
import { mcpToolToDefinition, namespacedToolName, normalizeMcpResult } from "./to-tool-definition.js";

describe("mcp tool mapping", () => {
  it("namespaces tools and passes the JSON Schema through verbatim", () => {
    const definition = mcpToolToDefinition("linear", {
      name: "create_issue",
      description: "Create an issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, labels: { type: "array" } },
        required: ["title"],
      },
    });

    expect(definition.name).toBe("linear__create_issue");
    expect(definition.id).toBe("mcp:linear:create_issue");
    expect(definition.scope).toBe("global");
    expect(definition.inputSchema.properties.title).toEqual({ type: "string" });
    // Non-flat property (array) is preserved rather than dropped/flattened.
    expect(definition.inputSchema.properties.labels).toEqual({ type: "array" });
  });

  it("normalizes both MCP failure surfaces", () => {
    expect(normalizeMcpResult({ content: [{ type: "text", text: "hi" }] })).toEqual({
      ok: true,
      data: [{ type: "text", text: "hi" }],
    });
    expect(normalizeMcpResult({ structuredContent: { id: "ENG-2" } })).toEqual({
      ok: true,
      data: { id: "ENG-2" },
    });

    const errored = normalizeMcpResult({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(errored.ok).toBe(false);
    expect(errored.message).toBe("boom");
  });

});

describe("mcp manager (in-memory server)", () => {
  it("connects, lists tools, and round-trips callTool", async () => {
    const manager = new McpManager([
      { id: "linear", createServer: createLinearDemoServer },
    ]);

    await manager.connectAll();

    const state = manager.resolve("linear");
    expect(state.status).toBe("ready");

    const toolNames = manager.allDefinitions().map((definition) => definition.name);
    expect(toolNames).toContain("linear__create_issue");
    expect(toolNames).toContain("linear__list_issues");

    const created = await manager.callTool("linear", "create_issue", { title: "Wire up MCP" });
    expect(created.ok).toBe(true);

    const listed = await manager.callTool("linear", "list_issues", {});
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.data)).toContain("Wire up MCP");

    await manager.close();
  });

  it("reports a configured server that fails to connect (no silent failure)", async () => {
    const manager = new McpManager([
      { id: "broken", url: "http://127.0.0.1:9/not-real", auth: { kind: "none" } },
    ]);

    await manager.connectAll();

    const state = manager.resolve("broken");
    expect(state.status).toBe("error");
  });

  it("treats an unconfigured server as absent, not an error", () => {
    const manager = new McpManager();
    expect(manager.resolve("unknown").status).toBe("absent");
  });
});

describe("mcp manager lifecycle (dashboard actions)", () => {
  it("keeps enabled:false servers disconnected until connectServer, then disconnects again", async () => {
    const manager = new McpManager([
      { id: "linear", createServer: createLinearDemoServer, enabled: false },
    ]);
    const changes: string[] = [];
    manager.onChange(() => changes.push(manager.summaries()[0].status));

    await manager.connectAll();
    expect(manager.summaries()[0]).toMatchObject({ id: "linear", status: "disconnected", removable: false });

    await manager.connectServer("linear");
    expect(manager.summaries()[0]).toMatchObject({ status: "ready", toolCount: expect.any(Number) });
    expect(changes).toContain("connecting");
    expect(changes).toContain("ready");

    await manager.disconnectServer("linear");
    expect(manager.summaries()[0].status).toBe("disconnected");
  });

  it("adds user servers with validation, persists them, and only removes those", async () => {
    const manager = new McpManager([
      { id: "linear", createServer: createLinearDemoServer },
    ]);
    const persisted: string[][] = [];
    manager.onPersistUserServers = (configs) => persisted.push(configs.map((config) => config.id));

    expect(() => manager.addServer({ id: "bad id!", url: "https://x.dev/mcp" })).toThrow(
      /Invalid MCP server id/,
    );
    expect(() => manager.addServer({ id: "linear", url: "https://x.dev/mcp" })).toThrow(
      /already exists/,
    );
    expect(() => manager.addServer({ id: "notion", url: "not a url" })).toThrow();

    manager.addServer({ id: "notion", url: "https://mcp.notion.com/mcp" });
    expect(manager.summaries().map((summary) => summary.id)).toEqual(["linear", "notion"]);
    expect(manager.summaries()[1]).toMatchObject({ removable: true, status: "disconnected" });
    expect(persisted).toEqual([["notion"]]);

    await expect(manager.removeServer("linear")).rejects.toThrow(/configured in code/);
    await manager.removeServer("notion");
    expect(manager.summaries().map((summary) => summary.id)).toEqual(["linear"]);
    expect(persisted).toEqual([["notion"], []]);
  });
});

describe("an MCP sign-in in progress", () => {
  afterEach(() => {
    setMcpOAuthSignInUrl(null);
    vi.useRealTimers();
  });

  /** A manager holding what `connect` leaves behind when the server asks for a sign-in: the
   * parked flow, and the provider's authorization URL. Staged, because the real flow needs an
   * OAuth provider on the network. */
  function waitingForSignIn() {
    const manager = new McpManager([{ id: "linear", url: "https://mcp.linear.app/mcp" }]);
    const finishAuth = vi.fn(async () => {});
    const internals = manager as unknown as {
      pendingAuth: Map<string, unknown>;
      states: Map<string, unknown>;
    };
    internals.pendingAuth.set("linear", {
      transport: { finishAuth },
      provider: { consumeState: (state: string) => state === "linear.nonce" },
    });
    internals.states.set("linear", { status: "auth_required", authUrl: "https://linear.app/oauth/authorize?state=linear.nonce" });
    manager.connectServer = vi.fn(async () => {});
    return { manager, finishAuth };
  }

  it("sends Sign in through the host's page, which counts it until the provider calls back", async () => {
    setMcpOAuthSignInUrl("http://127.0.0.1:4000/oauth/sign-in");
    const { manager, finishAuth } = waitingForSignIn();
    const counts: number[] = [];
    manager.onChange(() => counts.push(manager.signInsInProgress().length));

    expect(manager.summaries()[0]).toMatchObject({ status: "auth_required", authUrl: "http://127.0.0.1:4000/oauth/sign-in?server=linear" });
    expect(manager.signInsInProgress()).toEqual([]);
    expect(manager.openSignIn("notion")).toBeNull();

    expect(manager.openSignIn("linear")).toBe("https://linear.app/oauth/authorize?state=linear.nonce");
    expect(manager.signInsInProgress()).toEqual(["linear"]);

    // A forged callback ends nothing; the real one does, whether the exchange works or not.
    await expect(manager.finishOAuth("linear.forged", "code")).rejects.toThrow(/state mismatch/);
    expect(manager.signInsInProgress()).toEqual(["linear"]);
    await manager.finishOAuth("linear.nonce", "code");
    expect(finishAuth).toHaveBeenCalledWith("code");
    expect(manager.signInsInProgress()).toEqual([]);
    expect(counts).toEqual([1, 0]);
  });

  it("gives a sign-in up after 5 minutes, and tells its listeners", () => {
    vi.useFakeTimers();
    setMcpOAuthSignInUrl("http://127.0.0.1:4000/oauth/sign-in");
    const { manager } = waitingForSignIn();
    const opened = Date.now();
    manager.openSignIn("linear", opened);
    const counts: number[] = [];
    manager.onChange(() => counts.push(manager.signInsInProgress(Date.now()).length));

    expect(manager.signInsInProgress(opened + MCP_SIGN_IN_HOLD_MS - 1)).toEqual(["linear"]);
    expect(manager.signInsInProgress(opened + MCP_SIGN_IN_HOLD_MS)).toEqual([]);
    vi.advanceTimersByTime(MCP_SIGN_IN_HOLD_MS);
    expect(counts).toEqual([0]);
  });

  it("hands out the provider's URL itself on a host without a sign-in page", () => {
    const { manager } = waitingForSignIn();
    expect(manager.summaries()[0].authUrl).toBe("https://linear.app/oauth/authorize?state=linear.nonce");
  });
});

describe("mcp tools in the runtime", () => {
  it("exposes MCP tools globally and routes calls through the registry", async () => {
    configureMcp([{ id: "linear", createServer: createLinearDemoServer }]);
    await preloadMcpTools();

    const runtime = new AgentSiteRuntime(() => (
      <Agent>
        <GlobalTools>
          <Mcp server="linear" only={["create_issue"]} />
        </GlobalTools>
        <agent-page path="/support" title="Support">
          <Instruction>Help the user.</Instruction>
        </agent-page>
      </Agent>
    ));

    const tool = runtime.snapshot().context.tools.find((entry) => entry.name === "linear__create_issue");
    expect(tool).toBeDefined();
    expect(tool?.scope).toBe("global");

    const result = await runtime.callTool("linear__create_issue", { title: "From runtime" });
    expect(result.result.ok).toBe(true);
  });

  it("scopes MCP tools to the page when <Mcp> is placed inside a Page", async () => {
    configureMcp([{ id: "linear", createServer: createLinearDemoServer }]);
    await preloadMcpTools();

    const runtime = new AgentSiteRuntime(() => (
      <Agent>
        <agent-page path="/support" title="Support">
          <Instruction>Help the user.</Instruction>
          <Mcp server="linear" only={["create_issue"]} />
        </agent-page>
      </Agent>
    ));
    runtime.loadSkill("/support");

    const tool = runtime.snapshot().context.tools.find((entry) => entry.name === "linear__create_issue");
    expect(tool).toBeDefined();
    // Availability follows placement (see the <Mcp> docstring): inside a Page
    // the tool is page-scoped, not global.
    expect(tool?.scope).toBe("page");
  });
});

describe("implicit MCP credentials", () => {
  const KEY = mcpTokenEnvVar("linear");
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("derives the token env var from the id by convention", () => {
    expect(mcpTokenEnvVar("linear")).toBe("MCP_LINEAR_TOKEN");
    expect(mcpTokenEnvVar("my-server.v2")).toBe("MCP_MY_SERVER_V2_TOKEN");
  });

  it("an explicit auth prop always wins", () => {
    process.env[KEY] = "should-be-ignored";
    expect(resolveImplicitAuth("linear", { kind: "none" })).toEqual({ kind: "none" });
  });

  it("uses MCP_<ID>_TOKEN as a bearer token when set", () => {
    process.env[KEY] = "  lin_abc123  ";
    expect(resolveImplicitAuth("linear")).toEqual({ kind: "bearer", token: "lin_abc123" });
  });

  it("falls back to OAuth when no token and no explicit auth", () => {
    expect(resolveImplicitAuth("linear")).toEqual({ kind: "oauth" });
  });
});

describe("inline <Mcp url> declaration", () => {
  it("ensureServer registers a new server once and is idempotent", () => {
    const manager = new McpManager();
    expect(manager.serverIds()).toEqual([]);
    // enabled:false so the test never opens a network connection.
    manager.ensureServer({ id: "linear", url: "https://example.test/mcp", enabled: false });
    expect(manager.serverIds()).toEqual(["linear"]);
    // A second call (a re-render) does not duplicate or reset it.
    manager.ensureServer({ id: "linear", url: "https://changed.test/mcp", enabled: false });
    expect(manager.serverIds()).toEqual(["linear"]);
    expect(manager.summaries()[0]).toMatchObject({ id: "linear", status: "disconnected" });
  });
});
