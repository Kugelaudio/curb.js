import type { CompiledContext, ContextLink } from "../types.js";
import type { BlueprintNode, SkillBlueprint } from "./skill-blueprint.js";

export type AvailableSkill = Pick<ContextLink, "to" | "label" | "description" | "scope">;

export type StaticSkillLink = {
  to: string;
  label: string;
  description?: string;
  /** The link only renders in some block section (a conditional branch, a
   * procedure step), so it is not always reachable. */
  locked: boolean;
  /**
   * Which side of a boolean reveals this link, when a boolean is involved at
   * all. Taken from the INNERMOST enclosing section that declares a polarity:
   * that is the condition which actually distinguishes this link from its
   * sibling, while outer conditions are preconditions shared by both.
   *
   * Only `polarity` is read here, never a section's label, so this stays free
   * of block-specific knowledge.
   */
  polarity?: "positive" | "negative";
  /**
   * Identifies WHICH decision the polarity belongs to, so the two sides of one
   * condition can be shown as a pair when a skill has several. This is the
   * deciding block's own label, which for a source `if` is the condition
   * exactly as the author wrote it (`lookup.hasOpenClaim`). Always paired with
   * `polarity` and taken from the same section.
   */
  decision?: string;
};

export type GraphToolCall = {
  name: string;
  description?: string;
  ownerPath?: string;
};

export type SkillGraphNode = {
  path: string;
  label: string;
  description?: string;
  state: "available" | "known" | "locked";
};

export type SkillGraphEdge = {
  source: string;
  target: string;
  label: string;
  state: "available" | "known" | "locked";
  /** Which side of a boolean opens this path, when one is involved. Drives the
   * graph's true/false colouring. */
  polarity?: "positive" | "negative";
  /** The condition this branch belongs to, so both sides of one decision can
   * be shown as a pair when a skill has several. */
  decision?: string;
};

export type SkillGraphMeta = {
  title?: string;
  description?: string;
  /** Authored lucide icon name, overriding the state-derived default. */
  icon?: string;
};

/**
 * The graph is a view of the live model surface, so its edges come from the
 * compiled context rather than the route registry or source blueprint.
 *
 * A skill can be declared globally and again on the active page. In that
 * case, the page declaration is the more specific description of the same
 * destination and wins. The stable ordering keeps the graph from jumping as
 * unrelated context state changes.
 */
export function availableSkills(
  context: Pick<CompiledContext, "links">,
): AvailableSkill[] {
  const byPath = new Map<string, AvailableSkill>();

  for (const link of context.links) {
    const existing = byPath.get(link.to);
    if (!existing || (existing.scope === "global" && link.scope === "page")) {
      byPath.set(link.to, link);
    }
  }

  return [...byPath.values()].sort(
    (left, right) => left.label.localeCompare(right.label) || left.to.localeCompare(right.to),
  );
}

/** Skill links authored in one source module, including links inside block
 * sections that do not exist in the current render. Each link carries the
 * branch that reveals it. An unconditional copy of the same destination wins
 * over a conditional one. */
export function staticSkillLinks(blueprint: SkillBlueprint | null): StaticSkillLink[] {
  if (!blueprint) return [];
  const byPath = new Map<string, StaticSkillLink>();

  type Branch = { polarity: StaticSkillLink["polarity"]; decision?: string };

  const collect = (nodes: BlueprintNode[], locked: boolean, branch: Branch) => {
    for (const node of nodes) {
      if (node.kind === "skill" && node.to) {
        const candidate: StaticSkillLink = {
          to: node.to,
          label: node.label,
          description: node.description,
          locked,
          ...(branch.polarity ? { polarity: branch.polarity } : {}),
          ...(branch.decision ? { decision: branch.decision } : {}),
        };
        const existing = byPath.get(node.to);
        if (!existing || (existing.locked && !locked)) byPath.set(node.to, candidate);
      }
      collect(node.children, locked, branch);
      // Every section is one state of its block, so anything inside it is
      // reachable only in that state. A section that declares a polarity
      // replaces the inherited branch, carrying its block's label along: the
      // nearest boolean is the distinguishing one, and a section without
      // polarity leaves the inherited branch untouched.
      for (const section of node.sections ?? []) {
        const nested: Branch = section.polarity
          ? { polarity: section.polarity, decision: node.label }
          : branch;
        collect(section.children, true, nested);
      }
    }
  };

  collect(blueprint.nodes, false, { polarity: undefined });
  return [...byPath.values()];
}

/** Tool names present anywhere in a source module, including inactive
 * conditions and pattern-block sections. */
export function staticToolCalls(blueprint: SkillBlueprint | null): string[] {
  if (!blueprint) return [];
  const names = new Set<string>();

  const collect = (nodes: BlueprintNode[]) => {
    for (const node of nodes) {
      if (node.kind === "tool") names.add(node.label);
      collect(node.children);
      for (const section of node.sections ?? []) collect(section.children);
    }
  };

  collect(blueprint.nodes);
  return [...names];
}

/** Complete author-facing catalog. Current compiled definitions win over
 * source-only names, while blueprints keep unloaded tools visible. */
export function buildToolCatalog(
  context: CompiledContext,
  blueprints: ReadonlyMap<string, SkillBlueprint | null>,
  agentBlueprint: SkillBlueprint | null,
): GraphToolCall[] {
  const tools = new Map<string, GraphToolCall>();
  const addStatic = (name: string, ownerPath?: string) => {
    if (!tools.has(name)) tools.set(name, { name, ownerPath });
  };

  for (const name of staticToolCalls(agentBlueprint)) addStatic(name);
  for (const [path, blueprint] of blueprints) {
    for (const name of staticToolCalls(blueprint)) addStatic(name, path);
  }

  for (const tool of context.tools) {
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      ownerPath: tool.skillPath,
    });
  }

  return [...tools.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function pathLabel(path: string): string {
  const segment = path.split("/").filter(Boolean).at(-1) ?? "skill";
  const words = segment.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The graph's first node: the agent itself, whose instructions and tools every skill
 * shares and whose skills index (`<Skills>` in the agent module) names the skills it can
 * open. A skill path always starts with "/", so this id never names a skill. */
export const AGENT_NODE_ID = "agent";

/** Merge runtime availability with the authored route graph. Runtime edges win;
 * source-only edges remain visible as known or locked future states. The graph starts at
 * the agent ({@link AGENT_NODE_ID}): its links lead to the skills it can open, and each
 * skill's links lead on from there. */
export function buildSkillGraph(
  context: CompiledContext,
  blueprints: ReadonlyMap<string, SkillBlueprint | null>,
  agentBlueprint: SkillBlueprint | null,
  metadata: ReadonlyMap<string, SkillGraphMeta> = new Map(),
): { nodes: SkillGraphNode[]; edges: SkillGraphEdge[] } {
  const nodes = new Map<string, SkillGraphNode>();
  const edges = new Map<string, SkillGraphEdge>();
  const titleOf = (path: string, fallback?: string) =>
    metadata.get(path)?.title ??
    context.loadedSkills.find((skill) => skill.path === path)?.title ??
    fallback ??
    pathLabel(path);

  const ensureNode = (
    path: string,
    label: string,
    state: SkillGraphNode["state"],
    description?: string,
  ) => {
    const existing = nodes.get(path);
    const priority = { locked: 0, known: 1, available: 2 } as const;
    if (!existing || priority[state] > priority[existing.state]) {
      nodes.set(path, { path, label, description: description ?? existing?.description, state });
    } else if (!existing.description && description) {
      nodes.set(path, { ...existing, description });
    }
  };

  const setEdge = (edge: SkillGraphEdge) => {
    if (edge.source === edge.target) return;
    const key = `${edge.source}->${edge.target}`;
    const existing = edges.get(key);
    const priority = { locked: 0, known: 1, available: 2 } as const;
    if (!existing || priority[edge.state] > priority[existing.state]) edges.set(key, edge);
  };

  const authoredLinks = [
    { source: AGENT_NODE_ID, links: staticSkillLinks(agentBlueprint) },
    ...[...blueprints].map(([source, blueprint]) => ({ source, links: staticSkillLinks(blueprint) })),
  ];
  const unconditionalTargets = new Set(
    authoredLinks.flatMap(({ links }) => links.filter((link) => !link.locked).map((link) => link.to)),
  );
  const conditionalTargets = new Set(
    authoredLinks.flatMap(({ links }) => links.filter((link) => link.locked).map((link) => link.to)),
  );
  const sourceState = (path: string): SkillGraphNode["state"] =>
    conditionalTargets.has(path) && !unconditionalTargets.has(path) ? "locked" : "known";

  for (const { source, links } of authoredLinks) {
    if (source !== AGENT_NODE_ID) {
      ensureNode(source, titleOf(source), sourceState(source), metadata.get(source)?.description);
    }
    for (const link of links) {
      ensureNode(
        link.to,
        titleOf(link.to, link.label),
        sourceState(link.to),
        link.description ?? metadata.get(link.to)?.description,
      );
      setEdge({
        source,
        target: link.to,
        label: link.label,
        state: link.locked ? "locked" : "known",
        ...(link.polarity ? { polarity: link.polarity } : {}),
        ...(link.decision ? { decision: link.decision } : {}),
      });
    }
  }

  for (const link of availableSkills(context)) {
    // The agent module's links are its skills index; a skill's own links lead on from it.
    const source = link.scope === "global" ? AGENT_NODE_ID : context.path;
    if (source !== AGENT_NODE_ID) {
      ensureNode(source, titleOf(source), "available", metadata.get(source)?.description);
    }
    ensureNode(
      link.to,
      titleOf(link.to, link.label),
      "available",
      link.description ?? metadata.get(link.to)?.description,
    );
    setEdge({ source, target: link.to, label: link.label, state: "available" });
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
