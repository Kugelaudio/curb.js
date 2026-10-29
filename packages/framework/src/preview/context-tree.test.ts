import { describe, expect, it } from "vitest";
import type { McpServerSummary } from "../mcp/manager.js";
import type { CompiledContext, ToolDefinition } from "../types.js";
import {
  alwaysAvailableTools,
  builtInAbilities,
  initiallyExpanded,
  instructionsSummary,
  mcpGroups,
  skillTree,
  type ContextTreeInput,
  type SkillNode,
} from "./context-tree.js";
import { parseSkillBlueprint } from "./skill-blueprint.js";

function tool(name: string, scope: ToolDefinition["scope"], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: `${scope}:${name}`,
    name,
    description: `Does ${name}.`,
    scope,
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

const live: CompiledContext = {
  path: "/claim-status",
  title: "Claim status",
  loadedSkills: [
    { path: "/policy-questions", title: "Policy questions", characterCount: 100 },
    { path: "/claim-status", title: "Claim status", characterCount: 100 },
  ],
  instructions: [],
  content: [],
  errors: [],
  toolErrors: {},
  links: [
    { to: "/claim-status", label: "Claim status", scope: "global", description: "Existing claims." },
    { to: "/member-portal", label: "Member portal", scope: "global" },
  ],
  blocks: [],
  tools: [
    tool("read_skill", "runtime"),
    tool("skip_turn", "runtime"),
    tool("request_callback", "global"),
    tool("lookup_claim", "page", { skillPath: "/claim-status", icon: "search" }),
    tool("linear_list_issues", "global", { id: "mcp:linear:linear_list_issues" }),
  ],
  diagnostics: [],
};

const blueprints = new Map([
  [
    "/claim-status",
    parseSkillBlueprint(
      `export default function S() { const [found] = useState(false);
        return <>{found ? <Skill path="/claim-status/track-claim">Track claim</Skill> : null}
          <Tool name="lookup_claim" onSubmit={() => ({ ok: true })} />
          <Tool def={fileClaim} /></>; }`,
    ),
  ],
  ["/claim-status/track-claim", parseSkillBlueprint(`export default () => <Text>Tracking</Text>;`)],
  ["/member-portal", parseSkillBlueprint(`export default () => <Tool name="verify_member" onSubmit={v} />;`)],
  ["/policy-questions", parseSkillBlueprint(`export default () => <Text>Policies</Text>;`)],
  ["/policy-questions/coverage", parseSkillBlueprint(`export default () => <Text>Coverage</Text>;`)],
]);

const input: ContextTreeInput = {
  live,
  skillPaths: [...blueprints.keys()].sort(),
  metadata: new Map([["/policy-questions", { title: "Policy questions" }]]),
  blueprints,
  agentBlueprint: parseSkillBlueprint(
    `export function App() { return <Agent><GlobalTools><Tool name="request_callback" onSubmit={r} /></GlobalTools></Agent>; }`,
  ),
  interactivePaths: new Set(["/claim-status", "/member-portal"]),
  gatedPaths: new Set(["/claim-status/track-claim"]),
  newSkillPaths: new Set(["/claim-status"]),
  newToolNames: new Set(["lookup_claim"]),
};

function find(nodes: readonly SkillNode[], path: string): SkillNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = find(node.children, path);
    if (child) return child;
  }
  return undefined;
}

describe("the Context tab's tree", () => {
  const tree = skillTree(input);

  it("mirrors the skill folders: top-level folders are the roots, nested folders sit under them", () => {
    expect(tree.map((node) => node.path)).toEqual(["/claim-status", "/member-portal", "/policy-questions"]);
    expect(find(tree, "/claim-status")?.children.map((node) => node.path)).toEqual(["/claim-status/track-claim"]);
    expect(find(tree, "/policy-questions")?.children.map((node) => node.label)).toEqual(["Coverage"]);
    expect(find(tree, "/member-portal")?.children).toEqual([]);
  });

  it("says where each skill stands in the conversation and what entered it since the last message", () => {
    expect(["/policy-questions", "/claim-status", "/claim-status/track-claim", "/member-portal"].map((path) => find(tree, path)?.state))
      .toEqual(["read", "in-use", "locked", null]);
    expect(find(tree, "/claim-status")?.isNew).toBe(true);
    expect(find(tree, "/member-portal")?.interactive).toBe(true);
  });

  it("puts each skill's own tools under it, the compiled definition where the context has it", () => {
    const claimTools = find(tree, "/claim-status")?.tools ?? [];
    expect(claimTools.map((entry) => [entry.name, entry.definition?.name, entry.icon, entry.isNew])).toEqual([
      ["lookup_claim", "lookup_claim", "search", true],
    ]);
    // Named in source but not loaded: listed, without a definition yet.
    expect(find(tree, "/member-portal")?.tools.map((entry) => [entry.name, entry.definition])).toEqual([
      ["verify_member", undefined],
    ]);
  });

  it("lists the agent module's tools as always available, MCP tools under their server", () => {
    expect(alwaysAvailableTools(input).map((entry) => entry.name)).toEqual(["request_callback"]);
    const servers: McpServerSummary[] = [
      { id: "linear", status: "ready", toolCount: 1, url: "https://mcp.linear.app/sse", removable: false },
      { id: "notion", status: "auth_required", authUrl: "https://notion.so/auth", removable: false },
    ];
    expect(mcpGroups(servers, live).map((group) => [group.server.id, group.tools.map((entry) => entry.name)])).toEqual([
      ["linear", ["linear_list_issues"]],
      ["notion", []],
    ]);
  });

  it("opens the skill in use and every parent whose child has a state, nothing else", () => {
    expect([...initiallyExpanded(tree)].sort()).toEqual(["/claim-status"]);
  });

  it("names the built-in tools the agent has now in a few words", () => {
    expect(builtInAbilities(live)).toEqual(["opening a skill", "staying silent"]);
    expect(builtInAbilities({ ...live, tools: [...live.tools, tool("end_call", "runtime")] })).toEqual([
      "ending the call",
      "opening a skill",
      "staying silent",
    ]);
  });

  it("summarises the instructions by their first sentence and their sections or lines", () => {
    expect(instructionsSummary("You are an insurance agent. Be brief.\n\n## Skills\n- Read silently.\n\n## Tools\n- Ask first.")).toEqual({
      firstSentence: "You are an insurance agent.",
      size: "2 sections",
    });
    expect(instructionsSummary("Help callers book a call.\nAsk one question at a time.")).toEqual({
      firstSentence: "Help callers book a call.",
      size: "2 lines",
    });
    expect(instructionsSummary("## Role\n- **Never** invent a time")).toEqual({
      firstSentence: "Never invent a time",
      size: "1 section",
    });
  });
});
