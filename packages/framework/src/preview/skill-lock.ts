import type { BlueprintNode, BlueprintSection, SkillBlueprint } from "./skill-blueprint.js";

/**
 * Why a locked skill is locked: every place in the agent's source that links to it, and the
 * state that link waits for. Read from the source blueprints, so it covers branches that are
 * not rendered right now, and it says only what the source says: a condition as its author
 * wrote it, or the name of the part of a block the link sits in.
 */
export type LockReason = {
  /** The skill whose source holds the link. */
  from: string;
  when:
    | { kind: "condition"; source: string; holds: boolean }
    | { kind: "section"; label: string };
};

export function lockReasons(path: string, blueprints: ReadonlyMap<string, SkillBlueprint>): LockReason[] {
  const reasons: LockReason[] = [];
  const seen = new Set<string>();
  const add = (reason: LockReason) => {
    const key = JSON.stringify(reason);
    if (seen.has(key)) return;
    seen.add(key);
    reasons.push(reason);
  };
  for (const [from, blueprint] of blueprints) {
    const walk = (nodes: readonly BlueprintNode[], within: { block: BlueprintNode; section: BlueprintSection } | null) => {
      for (const node of nodes) {
        if (node.kind === "skill" && node.to === path && within) add({ from, when: whenOf(within.block, within.section) });
        walk(node.children, within);
        // The innermost section decides: it is what this link waits for, while outer
        // sections are what its whole area waits for.
        for (const section of node.sections ?? []) walk(section.children, { block: node, section });
      }
    };
    walk(blueprint.nodes, null);
  }
  return reasons;
}

function whenOf(block: BlueprintNode, section: BlueprintSection): LockReason["when"] {
  if (section.polarity) return { kind: "condition", source: block.label, holds: section.polarity === "positive" };
  return { kind: "section", label: section.label };
}
