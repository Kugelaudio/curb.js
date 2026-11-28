import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredAgent } from "../agent.node.js";
import type { AuthoringDiagnostic } from "../authoring.js";
import { toolLikeNames } from "../instruction-tool-diagnostics.js";
import { configureMcp } from "../mcp/manager.js";
import { checkProject, listReachableMcpTools } from "./check.js";
import { createTestProject } from "./test-project.js";

const noTypeCheck = async () => ({ diagnostics: [], checkedFiles: 0, unlisted: 0 });

const AGENT = [
  'import { Agent, Skill, Skills, SystemPrompt, defineAgent } from "curb";',
  "",
  "export function App() {",
  "  return (",
  "    <Agent>",
  "      <SystemPrompt>{`",
  "        You help with orders.",
  "        Call lookup_ordr before you answer a question about an order.",
  "      `}</SystemPrompt>",
  "      <Skills>",
  '        <Skill path="/orders" description="Use for anything about an order.">Orders</Skill>',
  "      </Skills>",
  "    </Agent>",
  "  );",
  "}",
  "",
  "export const agent = defineAgent({ app: App });",
  "",
].join("\n");

const ORDERS = [
  'import { Instruction, Tool, defineTool, z, type SkillMeta } from "curb";',
  "",
  "export const meta = {",
  '  title: "Orders",',
  '  description: "Looks orders up.",',
  '  info: z.object({ "order.id": z.string() }),',
  "} satisfies SkillMeta;",
  "",
  "export const lookupOrder = defineTool({",
  '  name: "lookup_order",',
  '  description: "Look an order up by its number.",',
  '  schema: z.object({ order_number: z.string().describe("The order number.") }),',
  '  onSubmit: async () => ({ ok: true, message: "Found." }),',
  "});",
  "",
  "export default function Orders() {",
  "  return (",
  "    <>",
  "      <Instruction>{`",
  "        Ask for the order_number, then use lookup_order.",
  "        Use the tool cancel_order only when the caller asks to cancel.",
  "        Read the details from order_notes.md when the caller asks.",
  "      `}</Instruction>",
  "      <Tool {...lookupOrder} />",
  "    </>",
  "  );",
  "}",
  "",
].join("\n");

const FAULTY_SCENARIO = [
  'import { fake, scenario } from "curb/testing";',
  'import * as Orders from "./skill.js";',
  'import { lookupOrder } from "./skill.js";',
  "",
  "export default scenario({",
  '  start: { skills: [Orders, "/ordrs"], info: {} },',
  '  turns: ["Where is my order?"],',
  '  fakes: [fake(lookupOrder, { ok: true, message: "Found." }), fake("issue_refnd", { ok: true })],',
  "  expect: ({ called, opened, transcript }) => [",
  "    called(lookupOrder),",
  '    called("lookup_ordr"),',
  '    opened("/ordrs"),',
  '    ...(transcript.length > 3 ? [called("refund_all")] : []),',
  "  ],",
  "});",
  "",
].join("\n");

const CLEAN_SCENARIO = [
  'import { fake, scenario } from "curb/testing";',
  'import * as Orders from "./skill.js";',
  'import { lookupOrder } from "./skill.js";',
  "",
  "export default scenario({",
  '  start: { skills: [Orders], info: { "order.id": "A-1042" } },',
  '  turns: ["Where is my order?"],',
  '  fakes: [fake(lookupOrder, { ok: true, message: "Found." })],',
  "  expect: ({ called, calledInOrder, opened, notOpened, transcript }) => [",
  "    called(lookupOrder, { order_number: transcript[0]!.reply }),",
  '    calledInOrder("lookup_order", ["end_call", {}]),',
  "    opened(Orders),",
  '    notOpened("/orders"),',
  "  ],",
  "});",
  "",
].join("\n");

const summary = (diagnostics: readonly AuthoringDiagnostic[], prefix: string) =>
  diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith(prefix))
    .map((diagnostic) => `${diagnostic.code} ${diagnostic.severity} ${diagnostic.location.source}:${diagnostic.location.line ?? "-"} ${diagnostic.message}`);

describe("curb check reads scenarios and instruction text", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports unknown skills, unknown tools and missing start info in a scenario, and unknown tools in instructions", async () => {
    const project = createTestProject({
      "src/agent/agent.tsx": AGENT,
      "src/agent/orders/skill.tsx": ORDERS,
      "src/agent/orders/refund.scenario.ts": FAULTY_SCENARIO,
      "src/agent/orders/clean.scenario.ts": CLEAN_SCENARIO,
    });
    vi.stubEnv("AGENT_PROJECT_DIR", project);
    try {
      const report = await checkProject(project, { env: {}, typeCheck: noTypeCheck });

      expect(summary(report.diagnostics, "SCENARIO_")).toEqual([
        'SCENARIO_INFO_MISSING error src/agent/orders/refund.scenario.ts:6 Scenario "refund" starts in skill /orders, whose meta.info requires call info that start.info does not give: "order.id" is missing. The run fails before turn 1.',
        'SCENARIO_UNKNOWN_SKILL error src/agent/orders/refund.scenario.ts:6 Scenario "refund" names the skill "/ordrs" in start.skills[1], but the agent has no skill at that path.',
        'SCENARIO_UNKNOWN_SKILL error src/agent/orders/refund.scenario.ts:12 Scenario "refund" names the skill "/ordrs" in opened(), but the agent has no skill at that path.',
        'SCENARIO_UNKNOWN_TOOL error src/agent/orders/refund.scenario.ts:8 Scenario "refund" fakes "issue_refnd", but no tool of the agent is named that, so the fake never stands in for a call.',
        'SCENARIO_UNKNOWN_TOOL error src/agent/orders/refund.scenario.ts:11 Scenario "refund" checks called() with "lookup_ordr", but no tool of the agent is named that, so the check can never mean what it says.',
        'SCENARIO_UNKNOWN_TOOL error src/agent/orders/refund.scenario.ts:13 Scenario "refund" checks called() with "refund_all", but no tool of the agent is named that, so the check can never mean what it says.',
      ]);
      const misspelled = report.diagnostics.find((diagnostic) => diagnostic.message.includes('"lookup_ordr", but'));
      expect(misspelled?.fix).toMatch(/^Write "lookup_order" if that is the tool it means\./);

      expect(summary(report.diagnostics, "INSTRUCTION_")).toEqual([
        'INSTRUCTION_UNKNOWN_TOOL warning src/agent/agent.tsx:8 The system prompt tells the model to use "lookup_ordr", but no tool of the agent is named that.',
        'INSTRUCTION_UNKNOWN_TOOL warning src/agent/orders/skill.tsx:21 Skill /orders\'s instruction tells the model to use "cancel_order", but no tool of the agent is named that.',
      ]);
      // The diagnostics there were before are unchanged: this project has none of them.
      expect(report.diagnostics.filter((diagnostic) => !/^(SCENARIO|INSTRUCTION)_/.test(diagnostic.code))).toEqual([]);
      expect(report.notes).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("notes a scenario file that does not load instead of failing the check", async () => {
    const project = createTestProject({
      "src/agent/agent.tsx": AGENT.replace("Call lookup_ordr", "Call lookup_order"),
      "src/agent/orders/skill.tsx": ORDERS.replace("Use the tool cancel_order", "Cancel"),
      "src/agent/orders/broken.scenario.ts": 'throw new Error("not today");\n',
    });
    vi.stubEnv("AGENT_PROJECT_DIR", project);
    try {
      const report = await checkProject(project, { env: {}, typeCheck: noTypeCheck });
      expect(report.diagnostics).toEqual([]);
      expect(report.notes).toEqual([
        'Scenario "broken" was not checked: src/agent/orders/broken.scenario.ts could not be loaded: not today',
      ]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("a tool rendered only once something happened in the call", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is known from the source that writes it, and <Handoff>'s callback tool from its default name", async () => {
    const agent = [
      'import { Agent, GlobalTools, Handoff, SystemPrompt, defineAgent } from "curb";',
      'import { RefundTool } from "./refund-tool.js";',
      "",
      "export function App() {",
      "  return (",
      "    <Agent>",
      "      <SystemPrompt>{`",
      "        You help with orders. Use issue_refund once the order is confirmed.",
      "      `}</SystemPrompt>",
      "      <RefundTool />",
      "      <GlobalTools>",
      '        <Handoff to="+15550100" hours={{ timeZone: "UTC", open: { "mon-fri": "08:00-17:00" } }} />',
      "      </GlobalTools>",
      "    </Agent>",
      "  );",
      "}",
      "",
      "export const agent = defineAgent({ app: App });",
      "",
    ].join("\n");
    const refundTool = [
      'import { useState } from "react";',
      'import { Tool, z } from "curb";',
      "",
      "export function RefundTool() {",
      "  const [confirmed] = useState(false);",
      "  if (!confirmed) return null;",
      "  return (",
      "    <Tool",
      '      name="issue_refund"',
      '      description="Refund the confirmed order."',
      "      schema={z.object({})}",
      '      onSubmit={async () => ({ ok: true, message: "Refunded." })}',
      "    />",
      "  );",
      "}",
      "",
    ].join("\n");
    const scenario = [
      'import { scenario } from "curb/testing";',
      "",
      "export default scenario({",
      '  turns: ["I want my money back"],',
      '  expect: ({ called, notCalled }) => [called("issue_refund"), notCalled("request_callback"), called("handoff")],',
      "});",
      "",
    ].join("\n");
    const project = createTestProject({
      "src/agent/agent.tsx": agent,
      "src/agent/refund-tool.tsx": refundTool,
      "src/agent/refund.scenario.ts": scenario,
    });
    vi.stubEnv("AGENT_PROJECT_DIR", project);
    try {
      const report = await checkProject(project, { env: {}, typeCheck: noTypeCheck });
      expect(report.diagnostics.filter((diagnostic) => /^(SCENARIO|INSTRUCTION)_/.test(diagnostic.code))).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("INSTRUCTION_UNKNOWN_TOOL looks only at names used as a tool", () => {
  it.each([
    ["Call lookup_order before you answer.", ["lookup_order"]],
    ["Use the tool `cancel_order` when asked.", ["cancel_order"]],
    ["Run send_receipt() at the end.", ["send_receipt"]],
    ["The book_slot tool books it.", ["book_slot"]],
    ["Rufe das Tool termin_buchen auf.", ["termin_buchen"]],
    ["Call the caller back if the line drops.", []],
    ["Ask for the policy_number first.", []],
    ["Use order_info.id for the reference.", []],
    ["Read faq_list.md when asked.", []],
    ["The account_status is shown to you.", []],
  ])("%s", (text, names) => {
    expect(toolLikeNames(text)).toEqual(names);
  });
});

describe("MCP_TOOLS_STALE", () => {
  afterEach(() => vi.unstubAllEnvs());

  const snapshot = {
    format: "curb.mcp-tools",
    version: 1,
    servers: {
      tracker: { tools: [{ name: "list_items", description: "List the items." }, { name: "old_tool", description: "Gone." }] },
      offline: { tools: [{ name: "ping" }] },
      same: { tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] },
    },
  };

  it("warns for a reachable server whose tools differ from mcp.tools.json, and not for one it cannot reach", async () => {
    const project = createTestProject({
      "src/agent/agent.tsx": AGENT.replace("Call lookup_ordr", "Answer"),
      "mcp.tools.json": `${JSON.stringify(snapshot, null, 2)}\n`,
    });
    vi.stubEnv("AGENT_PROJECT_DIR", project);
    try {
      const listMcpTools = vi.fn(async () => ({
        tracker: [
          { name: "list_items", description: "List every item." },
          { name: "add_item", description: "Add an item." },
        ],
        // The same schema with its keys in another order is the same.
        same: [{ name: "echo", description: "Echo.", inputSchema: { properties: { text: { type: "string" } }, type: "object" } }],
        fresh: [{ name: "hello" }],
      }));
      const report = await checkProject(project, { env: {}, typeCheck: noTypeCheck, listMcpTools });

      expect(listMcpTools).toHaveBeenCalledTimes(1);
      expect(summary(report.diagnostics, "MCP_")).toEqual([
        'MCP_TOOLS_STALE warning mcp.tools.json:- mcp.tools.json is out of date for MCP server "fresh": the file holds no tools of it, and it lists 1. A hermetic test run offers the file\'s tools, not the server\'s.',
        'MCP_TOOLS_STALE warning mcp.tools.json:- mcp.tools.json is out of date for MCP server "tracker": it lists "add_item", which the file does not; the file holds "old_tool", which it no longer lists; "list_items" has another description or input schema. A hermetic test run offers the file\'s tools, not the server\'s.',
      ]);
      expect(report.diagnostics.find((diagnostic) => diagnostic.code === "MCP_TOOLS_STALE")?.fix).toBe("Run `npx curb mcp snapshot` to write the file again, check that the tests still pass, and commit it.");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("connects to nothing when the project has no mcp.tools.json", async () => {
    const project = createTestProject({ "src/agent/agent.tsx": AGENT.replace("Call lookup_ordr", "Answer") });
    vi.stubEnv("AGENT_PROJECT_DIR", project);
    try {
      const listMcpTools = vi.fn(async () => ({}));
      await checkProject(project, { env: {}, typeCheck: noTypeCheck, listMcpTools });
      expect(listMcpTools).not.toHaveBeenCalled();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);

  it("lists what a server the agent declares lists now, and disconnects it afterwards", async () => {
    const manager = configureMcp([]);
    const createServer = () => {
      const server = new McpServer({ name: "tracker", version: "0.0.0" });
      server.registerTool("list_items", { description: "List the items.", inputSchema: {} }, async () => ({ content: [] }));
      return server;
    };
    const agent = { definition: { mcpServers: [{ id: "tracker", createServer }] } } as unknown as DiscoveredAgent;

    const listed = await listReachableMcpTools(agent);

    expect(Object.keys(listed)).toEqual(["tracker"]);
    expect(listed.tracker?.map((tool) => [tool.name, tool.description])).toEqual([["list_items", "List the items."]]);
    expect(manager.resolve("tracker").status).toBe("disconnected");
  });
});
