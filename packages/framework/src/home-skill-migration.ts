import { parse } from "@babel/parser";
import { AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "./authoring.js";
import type { AgentDefinition } from "./config.js";

/**
 * What a project from before the agent level moves, and where to.
 *
 * A conversation used to start in a home skill: `src/agent/skill.tsx`, path "/", loaded first
 * (`defineAgent({ initialPath: "/" })`) and linked from the skills index with `<Skill path="/">`.
 * Now `agent.tsx` is the agent level: its system prompt, skills index, global tools and MCP
 * servers are in context from the first turn, with no skill loaded, and every skill opens only
 * when needed. None of the three leftovers does anything any more, so each one is an error with
 * ONE diagnostic that names its file and says what to move. An old project fails `curb check`
 * (and shows it in `curb dev` and a build's render check) instead of quietly losing what its
 * home skill told the model.
 */

/** The agent folder's own skill file: its discovery key (`./skill.tsx`) and its text. */
export type HomeSkillFile = { moduleId: string; source: string };

/** The `defineAgent` option that named the skill a conversation started in. */
const REMOVED_OPTION = "initialPath";

/** The home skill's path. No skill has it now. */
export const HOME_SKILL_PATH = "/";

export type HomeSkillLeftovers = {
  agentId: string;
  definition: AgentDefinition;
  /** `agent.tsx` from the project root, e.g. `src/agent/agent.tsx`, and its text. */
  agentFile: string;
  agentSource?: string;
  /** Every skill module's file from the project root and its text. */
  skills: ReadonlyArray<{ path: string; file?: string; source?: string }>;
  /** The agent folder's own skill file from the project root and its text, when there is one. */
  homeSkill?: { file: string; source: string };
};

/** One error per leftover of the home skill: the file, the `initialPath` option, and every
 * `<Skill path="/">` link. */
export function diagnoseHomeSkillLeftovers(project: HomeSkillLeftovers): AuthoringDiagnostic[] {
  const { agentId, agentFile } = project;
  const diagnostics: AuthoringDiagnostic[] = [];
  if (project.homeSkill) diagnostics.push(homeSkillFileDiagnostic(agentId, agentFile, project.homeSkill));
  if (Object.prototype.hasOwnProperty.call(project.definition, REMOVED_OPTION)) {
    diagnostics.push(removedOptionDiagnostic(project));
  }
  const sources = [
    { file: agentFile, source: project.agentSource },
    ...project.skills.map(({ file, source }) => ({ file, source })),
  ];
  for (const { file, source } of sources) {
    if (!file || !source) continue;
    for (const at of homeLinksIn(source)) {
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved,
        severity: "error",
        message:
          '<Skill path="/"> links the home skill, which is gone: a conversation starts at the agent level, and the agent level is not a skill to read.',
        location: { agentId, source: file, ...at, component: "Skill" },
        fix: 'Delete this <Skill path="/"> link. What the agent level holds (agent.tsx) is in context on every turn, so there is nothing to open.',
      });
    }
  }
  return diagnostics;
}

/** The skill paths the home skill file links: they are about to move into the agent's
 * `<Skills>` list, so reachability counts them as reached instead of warning a second time. */
export function homeSkillLinkTargets(homeSkill: { source: string } | undefined): string[] {
  if (!homeSkill) return [];
  return affordancesOf(homeSkill.source).links;
}

/** Whether a TypeScript error is the type check's view of the removed `initialPath` option, which
 * {@link diagnoseHomeSkillLeftovers} already reports with what to do. */
export function isRemovedOptionTypeError(code: number, message: string): boolean {
  // TS2353 "Object literal may only specify known properties, and 'x' does not exist in type
  // 'Y'"; TS2561 is the same with a "Did you mean" suggestion.
  return (code === 2353 || code === 2561) && message.includes(`'${REMOVED_OPTION}'`);
}

function homeSkillFileDiagnostic(
  agentId: string,
  agentFile: string,
  homeSkill: { file: string; source: string },
): AuthoringDiagnostic {
  const { tools, links } = affordancesOf(homeSkill.source);
  const named = (names: readonly string[]) => (names.length > 0 ? ` (${names.join(", ")})` : "");
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved,
    severity: "error",
    message:
      `${homeSkill.file} is no longer a skill, so nothing in it reaches the model: a conversation starts ` +
      `at the agent level, ${agentFile}, and opens skills only when needed.`,
    location: { agentId, source: homeSkill.file },
    fix:
      `Move its instructions into the <SystemPrompt> of ${agentFile}, its tools into <GlobalTools>${named(tools)}, ` +
      `and its <Skill> links into the agent's <Skills> list${named(links)}, then delete ${homeSkill.file}.`,
  };
}

function removedOptionDiagnostic(project: HomeSkillLeftovers): AuthoringDiagnostic {
  const value: unknown = (project.definition as Record<string, unknown>)[REMOVED_OPTION];
  const shown = JSON.stringify(value) ?? String(value);
  const skill = typeof value === "string" && value !== HOME_SKILL_PATH ? value : null;
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.homeSkillRemoved,
    severity: "error",
    message: `defineAgent({ ${REMOVED_OPTION}: ${shown} }) does nothing any more: every conversation starts at the agent level, with no skill loaded.`,
    location: {
      agentId: project.agentId,
      source: project.agentFile,
      ...(project.agentSource ? optionIn(project.agentSource) : {}),
      component: "defineAgent",
    },
    fix:
      `Delete the ${REMOVED_OPTION} line from defineAgent in ${project.agentFile}.` +
      (skill
        ? ` ${skill} stays a skill and opens when needed; move what the model must know from the first turn into the <SystemPrompt>.`
        : ""),
  };
}

// --- reading the source -------------------------------------------------------------------

type AstNode = {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

type Position = { line: number; column: number };

function parseModule(source: string): AstNode | null {
  try {
    return parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] }) as unknown as AstNode;
  } catch {
    // KEEP-JUSTIFIED: a source that does not parse is reported by the authoring analysis
    // (AGENT_AUTHORING_RENDER_FAILED) and the type check; this scan only adds line numbers.
    return null;
  }
}

/** Where `source` writes `<Skill path="/">`, 1-based. */
function homeLinksIn(source: string): Position[] {
  const found: Position[] = [];
  walk(parseModule(source), (node) => {
    if (node.type === "JSXElement" && elementName(node) === "Skill" && attribute(node, "path") === HOME_SKILL_PATH) {
      found.push(position(node));
    }
  });
  return found;
}

/** Where `source` sets the removed option in an object literal, 1-based; nothing when it is not
 * written there (spread in from another module, say). */
function optionIn(source: string): Partial<Position> {
  let found: Position | undefined;
  walk(parseModule(source), (node) => {
    if (found || node.type !== "ObjectProperty") return;
    const key = node.key as AstNode;
    if ((key.type === "Identifier" && key.name === REMOVED_OPTION) || (key.type === "StringLiteral" && key.value === REMOVED_OPTION)) {
      found = position(node);
    }
  });
  return found ?? {};
}

/** The tool names and link targets a skill module writes as literals, in source order. */
function affordancesOf(source: string): { tools: string[]; links: string[] } {
  const tools = new Set<string>();
  const links = new Set<string>();
  walk(parseModule(source), (node) => {
    if (node.type !== "JSXElement") return;
    const name = elementName(node);
    const tool = name === "Tool" ? attribute(node, "name") : undefined;
    if (tool) tools.add(tool);
    const link = name === "Skill" ? attribute(node, "path") : undefined;
    if (link && link !== HOME_SKILL_PATH) links.add(link);
  });
  return { tools: [...tools], links: [...links] };
}

function elementName(element: AstNode): string | undefined {
  const name = (element.openingElement as AstNode).name as AstNode;
  if (name.type === "JSXIdentifier") return name.name as string;
  if (name.type === "JSXMemberExpression") return (name.property as AstNode).name as string;
  return undefined;
}

/** A JSX attribute's value when it is a literal string: `x="..."`, `x={"..."}` or
 * ``x={`...`}`` without `${}`. */
function attribute(element: AstNode, key: string): string | undefined {
  for (const candidate of (element.openingElement as AstNode).attributes as AstNode[]) {
    if (candidate.type !== "JSXAttribute" || (candidate.name as AstNode).name !== key) continue;
    const value = candidate.value as AstNode | null;
    if (!value) return undefined;
    if (value.type === "StringLiteral") return value.value as string;
    if (value.type !== "JSXExpressionContainer") return undefined;
    const expression = value.expression as AstNode;
    if (expression.type === "StringLiteral") return expression.value as string;
    if (expression.type === "TemplateLiteral" && (expression.expressions as unknown[]).length === 0) {
      return ((expression.quasis as AstNode[])[0]?.value as { cooked?: string } | undefined)?.cooked;
    }
    return undefined;
  }
  return undefined;
}

function position(node: AstNode): Position {
  const start = node.loc?.start;
  return { line: start?.line ?? 1, column: (start?.column ?? 0) + 1 };
}

const SKIPPED_KEYS = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments"]);

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== "object" || typeof (node as AstNode).type !== "string") return;
  visit(node as AstNode);
  for (const [key, value] of Object.entries(node)) {
    if (!SKIPPED_KEYS.has(key) && value && typeof value === "object") walk(value, visit);
  }
}
