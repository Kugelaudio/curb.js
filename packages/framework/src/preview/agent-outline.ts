import { blockComponentNames } from "../blocks/registry.js";
import type { PreviewAgent } from "../server/protocol.js";
import { parseSkillBlueprint, skillLinkAvailability, type SkillBlueprint } from "./skill-blueprint.js";

/**
 * Does the skill SOURCE use interactive framework features — hooks
 * (state/templating), tools, pattern blocks, or links to other skills?
 * Source-based on purpose: a compiled snapshot only shows the CURRENT state,
 * so a conditionally rendered tool (e.g. an intake gated behind a procedure)
 * would misclassify as static text. Block component names come from the
 * block registry, so a new block is picked up here automatically.
 */
const INTERACTIVE_COMPONENTS = ["Tool", "Skill", ...blockComponentNames()];
const INTERACTIVE_SOURCE = new RegExp(
  `\\buse[A-Z]\\w*\\s*\\(|<(${INTERACTIVE_COMPONENTS.join("|")})\\b`,
);

/** What the preview shows of the active agent beyond its compiled context, all of it
 * derived from the source text the server sends ({@link PreviewAgent}). Static and
 * best-effort, like any source analysis: it shows what exists, not what is open now. */
export type AgentOutline = {
  /** Every skill's route path, sorted. */
  skillPaths: string[];
  /** Skills whose pages are interactive (state, tools, procedures, sub-skill links)
   * rather than static text: the skill's icon. */
  interactivePaths: ReadonlySet<string>;
  /** Skills only ever linked from inside conditional areas (a block section such as a
   * gate's unlocked content, or a source condition), never unconditionally: shown as
   * locked until the conversation opens them. */
  gatedPaths: ReadonlySet<string>;
  /** Each skill's static blueprint (every affordance and its gate, inactive branches
   * included): the tree's tools, the lock reasons and the graph. */
  blueprints: ReadonlyMap<string, SkillBlueprint>;
  /** The agent module's blueprint: the tools that are always available. */
  agentBlueprint: SkillBlueprint;
  skillMetadata: ReadonlyMap<string, { title?: string; description?: string; icon?: string }>;
  suggestedPrompts: string[];
  chatPlaceholder: string;
};

export function agentOutline(agent: PreviewAgent): AgentOutline {
  const blueprints = new Map(agent.skills.map((skill) => [skill.path, parseSkillBlueprint(skill.source)]));
  const conditional = new Set<string>();
  const unconditional = new Set<string>();
  for (const blueprint of blueprints.values()) {
    const links = skillLinkAvailability(blueprint.nodes);
    for (const to of links.conditional) conditional.add(to);
    for (const to of links.unconditional) unconditional.add(to);
  }
  return {
    skillPaths: agent.skills.map((skill) => skill.path),
    interactivePaths: new Set(
      agent.skills.filter((skill) => INTERACTIVE_SOURCE.test(skill.source)).map((skill) => skill.path),
    ),
    gatedPaths: new Set([...conditional].filter((path) => !unconditional.has(path))),
    blueprints,
    agentBlueprint: parseSkillBlueprint(agent.source),
    skillMetadata: new Map(
      agent.skills.map((skill) => [
        skill.path,
        {
          title: skill.meta?.title,
          description: skill.meta?.description,
          ...(skill.meta?.icon ? { icon: skill.meta.icon } : {}),
        },
      ]),
    ),
    suggestedPrompts: agent.preview.suggestedPrompts ?? [],
    chatPlaceholder: agent.preview.chatPlaceholder ?? "Message your agent…",
  };
}
