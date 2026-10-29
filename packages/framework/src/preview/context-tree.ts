import type { McpServerSummary } from "../mcp/manager.js";
import type { CompiledContext, ToolDefinition } from "../types.js";
import { staticToolCalls } from "./agent-graph-model.js";
import type { SkillBlueprint } from "./skill-blueprint.js";

/**
 * The Context tab as a tree that mirrors `src/agent/`: what the agent module declares is
 * always available; what a skill declares works only while that skill is in use, so its
 * tools sit under it. Built only from what every Curb agent has (skill paths, the source
 * blueprints, the conversation's compiled context, MCP status), never from one agent's
 * names.
 */

/** Where a skill stands in the conversation: the one the agent is on, one it read
 * earlier, one it cannot open yet, or none of these. */
export type SkillState = "in-use" | "read" | "locked" | null;

export type TreeTool = {
  name: string;
  description?: string;
  /** Authored lucide icon name. */
  icon?: string;
  /** The skill that declares it; absent for a tool that is always available. */
  skillPath?: string;
  /** The compiled definition, when the conversation's context has the tool right now. */
  definition?: ToolDefinition;
  /** The agent could not call it before the caller's last message. */
  isNew: boolean;
};

export type SkillNode = {
  path: string;
  label: string;
  description?: string;
  icon?: string;
  /** The skill's source has state, tools, blocks or links (agent-outline's `interactivePaths`). */
  interactive: boolean;
  state: SkillState;
  /** The agent read it after the caller's last message. */
  isNew: boolean;
  tools: TreeTool[];
  children: SkillNode[];
};

export type McpGroup = {
  server: McpServerSummary;
  tools: ToolDefinition[];
};

export type ContextTreeInput = {
  /** The conversation's own compiled context. */
  live: CompiledContext;
  skillPaths: readonly string[];
  metadata: ReadonlyMap<string, { title?: string; description?: string; icon?: string }>;
  blueprints: ReadonlyMap<string, SkillBlueprint>;
  agentBlueprint: SkillBlueprint;
  interactivePaths: ReadonlySet<string>;
  gatedPaths: ReadonlySet<string>;
  newSkillPaths: ReadonlySet<string>;
  newToolNames: ReadonlySet<string>;
};

export function isMcpTool(tool: Pick<ToolDefinition, "id">): boolean {
  return tool.id.startsWith("mcp:");
}

/** `mcp:<server>:<tool>` -> `<server>`. */
export function mcpServerOf(tool: Pick<ToolDefinition, "id">): string {
  return tool.id.split(":")[1] ?? "";
}

/** A tool name the source states literally. The blueprint falls back to "tool" for a
 * `<Tool def={...}>` and to the expression for a computed name; neither names a tool, so
 * those tools show once the compiled context has them. */
function isStaticToolName(name: string): boolean {
  return name !== "tool" && /^[A-Za-z_][\w-]*$/.test(name);
}

/** "policy-questions" -> "Policy questions": the last resort for a skill's label. */
export function labelFromPath(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1) ?? path;
  const words = segment.replace(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A skill's label: what its parent's link calls it, else its own `meta.title`, else its path. */
export function skillLabel(input: Pick<ContextTreeInput, "live" | "metadata">, path: string): string {
  return (
    input.live.links.find((link) => link.to === path)?.label ??
    input.metadata.get(path)?.title ??
    labelFromPath(path)
  );
}

/** Tool rows from the names a source states plus the compiled tools the context has now:
 * source order first, then compiled tools the source did not name. */
function treeTools(
  staticNames: readonly string[],
  compiled: readonly ToolDefinition[],
  newToolNames: ReadonlySet<string>,
  skillPath?: string,
): TreeTool[] {
  const byName = new Map(compiled.map((tool) => [tool.name, tool]));
  const names = [...new Set([...staticNames.filter(isStaticToolName), ...compiled.map((tool) => tool.name)])];
  return names.map((name) => {
    const definition = byName.get(name);
    return {
      name,
      description: definition?.description,
      icon: definition?.icon,
      skillPath,
      definition,
      isNew: newToolNames.has(name),
    };
  });
}

/** The agent module's own tools: always available, whatever skill is in use. */
export function alwaysAvailableTools(input: ContextTreeInput): TreeTool[] {
  const compiled = input.live.tools.filter((tool) => tool.scope === "global" && !isMcpTool(tool));
  return treeTools(staticToolCalls(input.agentBlueprint), compiled, input.newToolNames);
}

/** A skill's own tools: what its source names, and what its compile carries now. */
export function skillTools(input: ContextTreeInput, path: string): TreeTool[] {
  const compiled = input.live.tools.filter(
    (tool) => tool.scope === "page" && tool.skillPath === path && !isMcpTool(tool),
  );
  return treeTools(staticToolCalls(input.blueprints.get(path) ?? null), compiled, input.newToolNames, path);
}

export function skillState(input: Pick<ContextTreeInput, "live" | "gatedPaths">, path: string): SkillState {
  if (input.live.path === path) return "in-use";
  if (input.live.loadedSkills.some((skill) => skill.path === path)) return "read";
  if (input.gatedPaths.has(path)) return "locked";
  return null;
}

/** The skill a path sits under, as its folder does: the nearest folder above it that has a
 * skill. Null for a top-level skill folder, which is a root of the tree. */
function parentPath(path: string, known: ReadonlySet<string>): string | null {
  const segments = path.split("/").filter(Boolean);
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const candidate = `/${segments.slice(0, length).join("/")}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Siblings in path order. */
function byPath(left: SkillNode, right: SkillNode): number {
  return left.path.localeCompare(right.path);
}

/** Every skill as a tree of the folders they live in: the top-level skill folders are the
 * roots, nested folders sit under their parent. */
export function skillTree(input: ContextTreeInput): SkillNode[] {
  const known = new Set(input.skillPaths);
  const nodes = new Map<string, SkillNode>(
    input.skillPaths.map((path) => [
      path,
      {
        path,
        label: skillLabel(input, path),
        description:
          input.metadata.get(path)?.description ?? input.live.links.find((link) => link.to === path)?.description,
        icon: input.metadata.get(path)?.icon,
        interactive: input.interactivePaths.has(path),
        state: skillState(input, path),
        isNew: input.newSkillPaths.has(path),
        tools: skillTools(input, path),
        children: [],
      },
    ]),
  );
  const roots: SkillNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentPath(node.path, known);
    if (parent) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  const sort = (list: SkillNode[]) => {
    list.sort(byPath);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/**
 * Which skills start expanded: the one in use, and every parent that has to be open for a
 * child's state to show. Everything else starts collapsed.
 */
export function initiallyExpanded(roots: readonly SkillNode[]): Set<string> {
  const expanded = new Set<string>();
  const visit = (node: SkillNode): boolean => {
    let showsState = false;
    for (const child of node.children) showsState = visit(child) || showsState;
    if (showsState) expanded.add(node.path);
    if (node.state === "in-use" && (node.tools.length > 0 || node.children.length > 0)) expanded.add(node.path);
    return showsState || node.state !== null;
  };
  for (const root of roots) visit(root);
  return expanded;
}

/** Every MCP server the agent has, with the tools the conversation's context has from it. */
export function mcpGroups(servers: readonly McpServerSummary[], live: CompiledContext): McpGroup[] {
  const tools = live.tools.filter(isMcpTool);
  const groups = servers.map((server) => ({
    server,
    tools: tools.filter((tool) => mcpServerOf(tool) === server.id),
  }));
  // A server whose tools are in the context but not in the status list is still connected.
  for (const id of new Set(tools.map(mcpServerOf))) {
    if (groups.some((group) => group.server.id === id)) continue;
    groups.push({
      server: { id, status: "ready", removable: false },
      tools: tools.filter((tool) => mcpServerOf(tool) === id),
    });
  }
  return groups;
}

/** What the framework's own tools let the agent do, in a few words each. */
const BUILT_IN_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["end_call", "ending the call"],
  ["read_skill", "opening a skill"],
  ["skip_turn", "staying silent"],
];

/** The built-in tools the agent has right now, as the one muted line under the tree. */
export function builtInAbilities(live: CompiledContext): string[] {
  const names = live.tools.filter((tool) => tool.scope === "runtime").map((tool) => tool.name);
  const known = BUILT_IN_PHRASES.filter(([name]) => names.includes(name)).map(([, phrase]) => phrase);
  const other = names.filter((name) => !BUILT_IN_PHRASES.some(([known]) => known === name)).sort();
  return [...known, ...other];
}

/**
 * The Instructions row's summary of the system prompt: its first sentence, and its size as
 * the reader sees it, in sections when the author used markdown headings, else in lines.
 */
export function instructionsSummary(prompt: string): { firstSentence: string; size: string } {
  const lines = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headings = lines.filter((line) => /^#{1,6}\s+\S/.test(line));
  const prose = lines.find((line) => !/^#{1,6}\s/.test(line)) ?? headings[0] ?? "";
  const plain = prose
    .replace(/^#{1,6}\s+/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`]/g, "");
  const sentence = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  const size =
    headings.length > 0
      ? `${headings.length} ${headings.length === 1 ? "section" : "sections"}`
      : `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
  return { firstSentence: sentence, size };
}
