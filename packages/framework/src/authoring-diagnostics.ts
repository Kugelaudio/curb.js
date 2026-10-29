import { parse } from "@babel/parser";
import type { AgentDefinition } from "./config.js";
import {
  AUTHORING_DIAGNOSTIC_CODES,
  AgentAuthoringError,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
  type AuthoringLocation,
} from "./authoring.js";
import { diagnoseAgentRouterLeftovers } from "./agent-router-migration.js";
import type { BlueprintNode } from "./blocks/types.js";
import {
  HOME_SKILL_PATH,
  diagnoseHomeSkillLeftovers,
  homeSkillLinkTargets,
  type HomeSkillFile,
} from "./home-skill-migration.js";
import { diagnoseLiteralDates } from "./literal-date-diagnostics.js";
import { renderComponentStack } from "./reconciler.js";
import { AgentSiteRuntime } from "./runtime.js";
import { agentAppElement, type AgentRoute } from "./routing.js";
import type { SemanticNode } from "./types.js";
import { parseSkillBlueprint } from "./preview/skill-blueprint.js";
import { diagnoseVoiceLanguage } from "./voice-language-diagnostics.js";

export type DiagnosableAgent = {
  id: string;
  definition: AgentDefinition;
  routes: readonly AgentRoute[];
  source?: string;
  /** Absolute project root. With it, a render error is located in the project's own
   * `src/` and shown relative to the root. */
  projectRoot?: string;
  /** The agent folder's own `skill.tsx`, left over from before the agent level: not a skill,
   * reported with what to move (`home-skill-migration.ts`). */
  homeSkill?: HomeSkillFile;
};

type LinkOccurrence = {
  from: string | null;
  to: string;
  description?: string;
  conditional: boolean;
  source?: string;
};

type ToolOccurrence = {
  name: string;
  path: string | null;
  source?: string;
};

/**
 * Analyze the complete authored agent rather than only the currently loaded
 * skill. Runtime rendering catches generated/default block tools; source
 * blueprints catch inactive conditional branches that React has not rendered.
 */
export function diagnoseAgentAuthoring(agent: DiagnosableAgent): AuthoringDiagnostic[] {
  const diagnostics: AuthoringDiagnostic[] = [];
  const knownPaths = new Set(agent.routes.map((route) => route.path));
  const routeByPath = new Map(agent.routes.map((route) => [route.path, route] as const));

  diagnoseRouteRegistry(agent, diagnostics);
  diagnostics.push(
    ...diagnoseHomeSkillLeftovers({
      agentId: agent.id,
      definition: agent.definition,
      agentFile: agentSourceLabel(agent.id),
      agentSource: agent.source,
      skills: agent.routes.map((route) => ({
        path: route.path,
        file: routeSourceLabel(agent.id, route.moduleId),
        source: route.source,
      })),
      ...(agent.homeSkill
        ? {
            homeSkill: {
              file: routeSourceLabel(agent.id, agent.homeSkill.moduleId) ?? agent.homeSkill.moduleId,
              source: agent.homeSkill.source,
            },
          }
        : {}),
    }),
  );
  diagnostics.push(
    ...diagnoseAgentRouterLeftovers(agent.id, [
      { file: agentSourceLabel(agent.id), source: agent.source },
      ...agent.routes.map((route) => ({ file: routeSourceLabel(agent.id, route.moduleId), source: route.source })),
    ]),
  );

  const occurrences: LinkOccurrence[] = [];
  const tools: ToolOccurrence[] = [];
  collectSourceOccurrences(agent, occurrences, tools, diagnostics);
  const tree = collectRenderedOccurrences(agent, occurrences, tools, diagnostics);
  // A link to "/" has its own diagnostic above, which says what to do with it.
  const links = occurrences.filter((link) => link.to !== HOME_SKILL_PATH);

  diagnoseLinks(agent.id, links, routeByPath, knownPaths, diagnostics);
  diagnoseReachability(agent.id, knownPaths, links, homeSkillLinkTargets(agent.homeSkill), diagnostics);
  diagnoseDuplicateTools(agent.id, tools, diagnostics);
  diagnoseLockedBranches(agent.id, links, tools, diagnostics);
  if (tree) {
    // Only over a complete render: an agent that does not render lists only the tools its
    // source names statically, and its render error comes first.
    diagnoseGoalTools(agent, tools, diagnostics);
    diagnostics.push(
      ...diagnoseVoiceLanguage({
        agentId: agent.id,
        tree,
        skillPaths: [...knownPaths],
        agentSource: agentSourceLabel(agent.id),
      }),
      ...diagnoseLiteralDates({
        agentId: agent.id,
        tree,
        agentFile: agentSourceLabel(agent.id),
        agentText: agent.source,
        skills: agent.routes.map((route) => ({
          path: route.path,
          file: routeSourceLabel(agent.id, route.moduleId),
          text: route.source,
          description: route.meta?.description,
        })),
        firstTurn: agent.definition.firstTurn,
      }),
    );
  }

  return mergeAuthoringDiagnostics(diagnostics);
}

function diagnoseRouteRegistry(agent: DiagnosableAgent, diagnostics: AuthoringDiagnostic[]): void {
  const seen = new Set<string>();
  for (const route of agent.routes) {
    const source = routeSourceLabel(agent.id, route.moduleId);
    if (!route.path.startsWith("/") || (route.path.length > 1 && route.path.endsWith("/"))) {
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
        severity: "error",
        message: `Skill route ${JSON.stringify(route.path)} is not canonical. Routes must start with "/" and must not end with "/".`,
        location: location(agent.id, route.path, source, "skill route"),
        fix: `Rename the skill directory or route to a canonical path such as ${JSON.stringify(canonicalPath(route.path))}.`,
      });
    }
    if (seen.has(route.path)) {
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
        severity: "error",
        message: `Skill route ${JSON.stringify(route.path)} is registered more than once.`,
        location: location(agent.id, route.path, source, "skill route"),
        fix: "Keep one skill module for this path or move one module to a unique directory.",
      });
    }
    seen.add(route.path);
  }
}

function collectSourceOccurrences(
  agent: DiagnosableAgent,
  links: LinkOccurrence[],
  tools: ToolOccurrence[],
  diagnostics: AuthoringDiagnostic[],
): void {
  if (agent.source) {
    const source = agentSourceLabel(agent.id);
    const blueprint = parseSkillBlueprint(agent.source);
    diagnoseParseError(agent.id, null, source, blueprint.parseError, diagnostics);
    collectBlueprintOccurrences(blueprint.nodes, null, source, links, tools, diagnostics, agent.id, false);
    if (!blueprint.parseError) diagnoseProse(agent.id, null, source, agent.source, diagnostics);
  }
  for (const route of agent.routes) {
    if (!route.source) continue;
    const source = routeSourceLabel(agent.id, route.moduleId);
    const blueprint = parseSkillBlueprint(route.source);
    diagnoseParseError(agent.id, route.path, source, blueprint.parseError, diagnostics);
    collectBlueprintOccurrences(blueprint.nodes, route.path, source, links, tools, diagnostics, agent.id, false);
    if (!blueprint.parseError) diagnoseProse(agent.id, route.path, source, route.source, diagnostics);
  }
}

function collectBlueprintOccurrences(
  nodes: readonly BlueprintNode[],
  path: string | null,
  source: string | undefined,
  links: LinkOccurrence[],
  tools: ToolOccurrence[],
  diagnostics: AuthoringDiagnostic[],
  agentId: string,
  insideConditional: boolean,
): void {
  for (const node of nodes) {
    if (node.kind === "skill" && isStaticRouteTarget(node.to)) {
      links.push({
        from: path,
        to: node.to,
        description: node.description,
        conditional: insideConditional,
        source,
      });
    }
    if (node.kind === "tool" && isStaticToolName(node.label)) {
      tools.push({ name: node.label, path, source });
    }
    collectBlueprintOccurrences(
      node.children,
      path,
      source,
      links,
      tools,
      diagnostics,
      agentId,
      insideConditional,
    );
    // Anything inside a section only exists in that state, so it is
    // conditional. A section the parser proved constant is dead code.
    for (const section of node.sections ?? []) {
      if (section.unreachable) {
        diagnostics.push({
          code: AUTHORING_DIAGNOSTIC_CODES.possiblyLockedBranch,
          severity: "error",
          message: `The branch containing ${JSON.stringify(firstAffordanceLabel(section.children) ?? node.label)} can never render because its condition is constant.`,
          location: location(agentId, path ?? undefined, source, node.kind),
          fix: "Remove the constant condition or replace it with state that can actually change at runtime.",
        });
      }
      collectBlueprintOccurrences(
        section.children,
        path,
        source,
        links,
        tools,
        diagnostics,
        agentId,
        true,
      );
    }
  }
}

/** Label of the first affordance in a dead branch, to name it in the
 * diagnostic the way the author sees it in the source. */
function firstAffordanceLabel(nodes: readonly BlueprintNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind !== "block") return node.label;
    for (const section of node.sections ?? []) {
      const nested = firstAffordanceLabel(section.children);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Returns the tree rendered with every skill loaded, or null when the agent did not render
 * (its diagnostic is pushed). */
function collectRenderedOccurrences(
  agent: DiagnosableAgent,
  links: LinkOccurrence[],
  tools: ToolOccurrence[],
  diagnostics: AuthoringDiagnostic[],
): SemanticNode | null {
  const paths = agent.routes.map((route) => route.path);
  let runtime: AgentSiteRuntime;
  try {
    // The agent level, then every skill on top of it, all loaded at once.
    runtime = new AgentSiteRuntime(
      ({ path, loadedPaths }) => agentAppElement(agent.definition.app, { path, loadedPaths, routes: agent.routes }),
      { maxLoadedSkills: Math.max(paths.length, 1) },
    );
    for (const path of paths) runtime.loadSkill(path);
  } catch (error) {
    diagnostics.push(renderFailureDiagnostic(agent, error));
    return null;
  }
  const tree = runtime.tree();
  if (!tree) {
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
      severity: "error",
      message: "The complete agent context rendered no semantic tree.",
      location: location(agent.id, undefined, agentSourceLabel(agent.id), "Agent"),
      fix: "Return an <Agent> tree containing the discovered skills.",
    });
    return null;
  }

  walkSemanticTree(tree, null, (node, path) => {
    if (node.type === "agent-skill") {
      const to = node.props.to;
      if (typeof to === "string" && isStaticRouteTarget(to)) {
        const description =
          typeof node.props.description === "string" && node.props.description.trim()
            ? node.props.description
            : undefined;
        addLinkIfMissing(links, { from: path, to, description, conditional: false });
      }
    }
    if (node.type === "agent-tool" || node.type === "agent-form") {
      const name = node.props.name;
      if (typeof name === "string" && isStaticToolName(name)) {
        const alreadyFromSource = tools.some(
          (tool) => tool.name === name && tool.path === path && tool.source !== undefined,
        );
        if (!alreadyFromSource) tools.push({ name, path });
      }
    }
  });
  return tree;
}

function walkSemanticTree(
  node: SemanticNode,
  currentPath: string | null,
  visit: (node: SemanticNode, path: string | null) => void,
): void {
  const path =
    node.type === "agent-page" && typeof node.props.path === "string"
      ? node.props.path
      : currentPath;
  visit(node, path);
  for (const child of node.children) walkSemanticTree(child, path, visit);
}

function diagnoseLinks(
  agentId: string,
  links: readonly LinkOccurrence[],
  routeByPath: ReadonlyMap<string, AgentRoute>,
  knownPaths: ReadonlySet<string>,
  diagnostics: AuthoringDiagnostic[],
): void {
  for (const link of links) {
    if (!knownPaths.has(link.to)) {
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
        severity: "error",
        message: `Skill link targets ${JSON.stringify(link.to)}, but no skill module defines that route.`,
        location: location(agentId, link.from ?? undefined, link.source, "Skill"),
        fix: `Create the matching skill module or change path to one of: ${[...knownPaths].map((path) => JSON.stringify(path)).join(", ")}.`,
      });
      continue;
    }
    const targetDescription = routeByPath.get(link.to)?.meta?.description?.trim();
    if (!link.description?.trim() && !targetDescription) {
      diagnostics.push({
        code: AUTHORING_DIAGNOSTIC_CODES.missingDescription,
        severity: "warning",
        message: `Skill link to ${JSON.stringify(link.to)} has no routing description, so the model only sees its label.`,
        location: location(agentId, link.from ?? undefined, link.source, "Skill"),
        fix: `Add meta.description to ${JSON.stringify(link.to)}'s skill module or pass description on this <Skill> link.`,
      });
    }
  }
}

/**
 * Every skill must be reachable from the agent level: from a `<Skill>` link the agent itself
 * renders (its `<Skills>` list), then through the links of skills already reached. `pending`
 * paths count as reached: the links of a skill file left in the agent folder itself, which its
 * own diagnostic says to move into the `<Skills>` list.
 */
function diagnoseReachability(
  agentId: string,
  knownPaths: ReadonlySet<string>,
  links: readonly LinkOccurrence[],
  pending: readonly string[],
  diagnostics: AuthoringDiagnostic[],
): void {
  const reachable = new Set<string>(pending.filter((path) => knownPaths.has(path)));
  for (const link of links) {
    if (link.from === null && knownPaths.has(link.to)) reachable.add(link.to);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (link.from === null || !reachable.has(link.from) || !knownPaths.has(link.to)) continue;
      if (!reachable.has(link.to)) {
        reachable.add(link.to);
        changed = true;
      }
    }
  }
  for (const path of knownPaths) {
    if (reachable.has(path)) continue;
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.unreachableSkill,
      severity: "warning",
      message: `Skill ${JSON.stringify(path)} cannot be reached from the agent's <Skills> list through any authored <Skill> link.`,
      location: location(agentId, path, undefined, "skill route"),
      fix: `Add it to the agent's <Skills> list in ${agentSourceLabel(agentId)}, link it with <Skill> from a reachable skill, or remove the orphaned skill module.`,
    });
  }
}

function diagnoseDuplicateTools(
  agentId: string,
  tools: readonly ToolOccurrence[],
  diagnostics: AuthoringDiagnostic[],
): void {
  const byName = new Map<string, ToolOccurrence[]>();
  for (const tool of tools) {
    const occurrences = byName.get(tool.name) ?? [];
    occurrences.push(tool);
    byName.set(tool.name, occurrences);
  }
  for (const [name, occurrences] of byName) {
    if (occurrences.length < 2) continue;
    const paths = [...new Set(occurrences.map((tool) => tool.path ?? "global"))];
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.duplicateTool,
      severity: "error",
      message: `Tool name ${JSON.stringify(name)} is authored ${occurrences.length} times (${paths.join(", ")}). Tool names must be unique across skills that can coexist.`,
      location: location(agentId, occurrences[0]?.path ?? undefined, occurrences[0]?.source, `Tool name=${JSON.stringify(name)}`),
      fix: "Rename each tool for its specific intent; do not rely on load order to select a handler.",
    });
  }
}

/**
 * A tool goal (`defineAgent({ goals: { booked: { tool: "book_slot" } } })`) counts as reached when
 * the agent ran that tool, so one naming a tool no `<Tool>` declares can never be reached. A
 * warning, not an error: an MCP server's tool is only known once it is connected, and a goal may
 * name one.
 */
function diagnoseGoalTools(
  agent: DiagnosableAgent,
  tools: readonly ToolOccurrence[],
  diagnostics: AuthoringDiagnostic[],
): void {
  const declared = [...new Set(tools.map((tool) => tool.name))].sort();
  for (const [name, goal] of Object.entries(agent.definition.goals ?? {})) {
    if (typeof goal.tool !== "string" || declared.includes(goal.tool)) continue;
    const line = lineOfLiteral(agent.source, goal.tool);
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.goalToolNotDeclared,
      severity: "warning",
      message: `Goal ${JSON.stringify(name)} is reached when the agent runs tool ${JSON.stringify(goal.tool)}, but no <Tool> in the agent or its skills is named that, so no call can reach it.`,
      location: {
        ...location(agent.id, undefined, agentSourceLabel(agent.id), "defineAgent goals"),
        ...(line === undefined ? {} : { line }),
      },
      fix:
        declared.length > 0
          ? `Name one of the agent's tools (${declared.map((tool) => JSON.stringify(tool)).join(", ")}) in goals.${name}.tool, or rename the tool it means. A tool of an MCP server is not checked: keep the goal if one provides it.`
          : `The agent declares no <Tool>: add the tool goals.${name} counts, or make it a judge goal ({ judge: "<criterion>" }). A tool of an MCP server is not checked: keep the goal if one provides it.`,
    });
  }
}

/** The 1-based line of the first string literal `value` in `source`, in any quotes. */
function lineOfLiteral(source: string | undefined, value: string): number | undefined {
  if (!source) return undefined;
  const quoted = ['"', "'", "`"].map((quote) => `${quote}${value}${quote}`);
  const index = source.split("\n").findIndex((text) => quoted.some((literal) => text.includes(literal)));
  return index < 0 ? undefined : index + 1;
}

function diagnoseLockedBranches(
  agentId: string,
  links: readonly LinkOccurrence[],
  tools: readonly ToolOccurrence[],
  diagnostics: AuthoringDiagnostic[],
): void {
  for (const link of links) {
    if (!link.conditional || link.from === null) continue;
    const hasOpenPath = links.some(
      (candidate) => candidate.to === link.to && !candidate.conditional,
    );
    const sourceHasTool = tools.some((tool) => tool.path === link.from);
    if (hasOpenPath || sourceHasTool) continue;
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.possiblyLockedBranch,
      severity: "warning",
      message: `Skill ${JSON.stringify(link.to)} is only linked from a conditional branch in ${JSON.stringify(link.from)}, and the source skill exposes no authored tool that can unlock the branch.`,
      location: location(agentId, link.from, link.source, "conditional Skill"),
      fix: "Add an explicit tool/state transition that can satisfy the condition, or provide an unconditional route to the target skill.",
    });
  }
}

function diagnoseParseError(
  agentId: string,
  skillPath: string | null,
  source: string | undefined,
  parseError: string | undefined,
  diagnostics: AuthoringDiagnostic[],
): void {
  if (!parseError) return;
  diagnostics.push({
    code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
    severity: "error",
    message: `Static authoring analysis could not parse the source: ${parseError}`,
    location: location(agentId, skillPath ?? undefined, source, "skill source"),
    fix: "Fix the reported JSX/TypeScript syntax error so inactive branches can be validated.",
  });
}

function addLinkIfMissing(links: LinkOccurrence[], occurrence: LinkOccurrence): void {
  const duplicate = links.some(
    (link) =>
      link.from === occurrence.from &&
      link.to === occurrence.to &&
      link.conditional === occurrence.conditional,
  );
  if (!duplicate) links.push(occurrence);
}

function isStaticRouteTarget(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("/");
}

function isStaticToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

function location(
  agentId: string,
  skillPath?: string,
  source?: string,
  component?: string,
): AuthoringDiagnostic["location"] {
  return { agentId, skillPath, source, component };
}

function canonicalPath(path: string): string {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function agentDirLabel(agentId: string): string {
  return agentId === "agent" ? "src/agent" : `src/agents/${agentId}`;
}

function agentSourceLabel(agentId: string): string {
  return `${agentDirLabel(agentId)}/agent.tsx`;
}

/** A skill module's path from the project root. Discovery keys modules relative to the agent
 * folder ("./claims/skill.tsx"); any other id is already a path and is kept. */
function routeSourceLabel(agentId: string, moduleId: string | undefined): string | undefined {
  if (!moduleId?.startsWith("./")) return moduleId;
  return `${agentDirLabel(agentId)}/${moduleId.slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- render failures ----------------------------------------------------------------------

const UPDATE_LOOP = /Maximum update depth exceeded|Too many re-renders/;

/**
 * The diagnostic for an agent that threw while rendering: the component's own error at the
 * project line it came from, never the empty tree a failed render leaves behind.
 */
function renderFailureDiagnostic(agent: DiagnosableAgent, error: unknown): AuthoringDiagnostic {
  // The module each authored component comes from, for component frames React could not
  // place (a component that calls no hook has no frame of its own in the component stack).
  const modules = new Map<string, string>();
  for (const route of agent.routes) {
    const source = routeSourceLabel(agent.id, route.moduleId);
    if (route.Component.name && source && !modules.has(route.Component.name)) {
      modules.set(route.Component.name, source);
    }
  }
  if (agent.definition.app.name) modules.set(agent.definition.app.name, agentSourceLabel(agent.id));

  const origin = renderErrorOrigin(error, agent.projectRoot ?? projectRootFromEnv(), {
    raisedBy: error instanceof AgentAuthoringError ? error.diagnostic.location.component : undefined,
    moduleOf: (component) => modules.get(component),
  });
  const at: AuthoringLocation = origin
    ? {
        agentId: agent.id,
        source: origin.file,
        ...(origin.line === undefined ? {} : { line: origin.line, column: origin.column }),
        component: origin.component,
      }
    : location(agent.id, undefined, agentSourceLabel(agent.id), "Agent");
  if (error instanceof AgentAuthoringError) {
    // A framework component refused its props: its own code and fix, placed where it is used.
    const own = error.diagnostic;
    if (own.location.source) return { ...own, location: { agentId: agent.id, ...own.location } };
    return {
      ...own,
      location: { ...own.location, ...at, component: own.location.component ?? at.component },
    };
  }
  const message = errorMessage(error);
  const who = origin?.component ? `<${origin.component}>` : "A component";
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
    severity: "error",
    message: `${who} threw while the agent rendered: ${message}`,
    location: at,
    fix: UPDATE_LOOP.test(message)
      ? "This component changes state every time it renders: a store action, setState or info update called while rendering. Call it from a tool's onSubmit instead."
      : "Fix the error at this line. A call fails the same way when it renders this component, and check can validate the rest of the agent only once it renders.",
  };
}

export type RenderErrorOrigin = {
  /** Project-relative when the frame is inside `projectRoot`, else absolute. */
  file: string;
  /** Absent when only the module is known. */
  line?: number;
  column?: number;
  /** The component React was rendering. */
  component?: string;
};

/**
 * Where a render error came from in the project's own code: the first such frame of the
 * error's stack (the line that threw), else of React's component stack (the component it was
 * rendering, which also covers errors raised inside the framework or React on its behalf).
 * With `projectRoot`, only frames under its `src/` count; without, any frame outside
 * node_modules and the framework itself.
 *
 * `raisedBy` names the component that raised an authoring error about how it is used (`Text`
 * refusing its props): that error belongs to the component rendering it, so neither the line
 * that raised it nor the raising component's own frame counts. `moduleOf` places a component
 * frame that has no location (React cannot place a component that calls no hook).
 */
export function renderErrorOrigin(
  error: unknown,
  projectRoot?: string,
  options: { raisedBy?: string; moduleOf?: (component: string) => string | undefined } = {},
): RenderErrorOrigin | undefined {
  const isProject = projectFrameFilter(projectRoot);
  const { raisedBy, moduleOf } = options;
  const components = stackFrames(renderComponentStack(error) ?? "").filter(
    (frame) => frame.name !== raisedBy,
  );
  const component = components.find((frame) => frame.name && !isHostElement(frame.name))?.name;
  const relative = (file: string) => {
    const root = projectRoot === undefined ? undefined : `${toPosix(projectRoot).replace(/\/+$/, "")}/`;
    return root && file.startsWith(root) ? file.slice(root.length) : file;
  };

  if (raisedBy === undefined) {
    const thrown = stackFrames(error instanceof Error ? (error.stack ?? "") : "").find(isProject);
    if (thrown?.file) {
      return { file: relative(thrown.file), line: thrown.line, column: thrown.column, component };
    }
  }
  for (const frame of components) {
    if (frame.file !== undefined) {
      if (isProject(frame)) {
        return { file: relative(frame.file), line: frame.line, column: frame.column, component: frame.name };
      }
      continue;
    }
    const module = frame.name === undefined ? undefined : moduleOf?.(frame.name);
    if (module) return { file: module, component: frame.name };
  }
  return undefined;
}

type StackFrame = { name?: string; file?: string; line?: number; column?: number };

/** "    at Name (file:line:col)" and "    at file:line:col". */
const LOCATED_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
/** "    at Name" and "    at Name (<anonymous>)": a component React could not place. */
const NAMED_FRAME = /^\s*at ([^\s()]+)(?: \(<anonymous>\))?\s*$/;

function stackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const located = LOCATED_FRAME.exec(line);
    if (located) {
      const [, name, file, lineNumber, column] = located;
      frames.push({
        ...(name ? { name: name.replace(/^async /, "") } : {}),
        file: toPosix(file.startsWith("file://") ? decodeURIComponent(file.slice("file://".length)) : file),
        line: Number(lineNumber),
        column: Number(column),
      });
      continue;
    }
    const named = NAMED_FRAME.exec(line);
    if (named) frames.push({ name: named[1] });
  }
  return frames;
}

/** `agent-page`, `agent-site`: the framework's host elements, never an authored component. */
function isHostElement(name: string): boolean {
  return name.includes("-");
}

/** This module's directory, which holds the framework's own source; "" where it has no path. */
const FRAMEWORK_SOURCE_DIR = (() => {
  const here = new URL("./", import.meta.url);
  return here.protocol === "file:" ? toPosix(decodeURIComponent(here.pathname)) : "";
})();

function projectFrameFilter(projectRoot: string | undefined): (frame: StackFrame) => boolean {
  const projectSource =
    projectRoot === undefined ? undefined : `${toPosix(projectRoot).replace(/\/+$/, "")}/src/`;
  return ({ file }) => {
    if (file === undefined || file.includes("/node_modules/") || file.startsWith("node:")) return false;
    if (projectSource !== undefined) return file.startsWith(projectSource);
    return file.startsWith("/") && !(FRAMEWORK_SOURCE_DIR && file.startsWith(FRAMEWORK_SOURCE_DIR));
  };
}

/** The project root a CLI-started host exports; none in the browser. */
function projectRootFromEnv(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env.AGENT_PROJECT_DIR || undefined;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

// --- prose written as JSX text ------------------------------------------------------------

/** Components whose children are prose the model reads. */
const PROSE_COMPONENTS = new Set(["SystemPrompt", "Instruction", "Text"]);
/** Lines of a suggested rewrite shown before the rest is elided. */
const REWRITE_PREVIEW_LINES = 8;

type AstNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
};

/**
 * Warn on prose written as JSX text across several lines inside `<SystemPrompt>`,
 * `<Instruction>` or `<Text>`. JSX joins those lines with single spaces, so whatever structure
 * the author typed (paragraphs, lists, headings) never reaches the model. The fix is one
 * template-literal child, which the compiler dedents and keeps line by line.
 */
function diagnoseProse(
  agentId: string,
  skillPath: string | null,
  source: string | undefined,
  code: string,
  diagnostics: AuthoringDiagnostic[],
): void {
  let ast: AstNode;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] }) as unknown as AstNode;
  } catch {
    // KEEP-JUSTIFIED: the blueprint parse of this same source already reported the syntax error.
    return;
  }
  walkAst(ast, (node) => {
    if (node.type !== "JSXElement") return;
    const name = proseComponentName(node);
    if (!name) return;
    const children = node.children as AstNode[];
    const lines = proseLines(children);
    if (lines.length < 2) return;
    const rewrite = templateLiteralRewrite(name, children, code);
    diagnostics.push({
      code: AUTHORING_DIAGNOSTIC_CODES.proseJsxText,
      severity: "warning",
      message: `<${name}> has prose on ${lines.length} lines written as JSX text. JSX joins those lines with spaces before the model reads them, so line breaks, paragraphs, lists and headings are lost.`,
      location: {
        agentId,
        ...(skillPath === null ? {} : { skillPath }),
        source,
        line: lines[0],
        component: name,
      },
      fix: rewrite
        ? `Write the prose as one template-literal child; curb removes the common indentation and keeps the line breaks:\n${rewrite}`
        : `Write the prose as one template-literal child, <${name}>{\`...\`}</${name}>; curb removes the common indentation and keeps the line breaks. Keep JSX elements outside the template literal.`,
    });
  });
}

function proseComponentName(element: AstNode): string | undefined {
  const name = (element.openingElement as AstNode).name as AstNode;
  const identifier =
    name.type === "JSXIdentifier"
      ? name.name
      : name.type === "JSXMemberExpression"
        ? (name.property as AstNode).name
        : undefined;
  return typeof identifier === "string" && PROSE_COMPONENTS.has(identifier) ? identifier : undefined;
}

/** Source lines (ascending) holding non-whitespace JSX text among these children. */
function proseLines(children: readonly AstNode[]): number[] {
  const lines = new Set<number>();
  for (const child of children) {
    if (child.type !== "JSXText" || !child.loc) continue;
    const raw = (child.extra as { raw?: string } | undefined)?.raw ?? String(child.value);
    raw.split("\n").forEach((text, offset) => {
      if (text.trim()) lines.add(child.loc!.start.line + offset);
    });
  }
  return [...lines].sort((left, right) => left - right);
}

/** The element rewritten with its children as one template literal, or null when a child is
 * JSX, which a template literal cannot hold. */
function templateLiteralRewrite(name: string, children: readonly AstNode[], code: string): string | null {
  let body = "";
  for (const child of children) {
    if (child.type === "JSXText") {
      body += escapeTemplateText(String(child.value));
      continue;
    }
    if (child.type !== "JSXExpressionContainer") return null;
    const expression = child.expression as AstNode;
    if (expression.type === "JSXEmptyExpression") continue;
    if (expression.type === "StringLiteral") {
      body += escapeTemplateText(String(expression.value));
      continue;
    }
    if (containsJsx(expression) || expression.start == null || expression.end == null) return null;
    body += "${" + code.slice(expression.start, expression.end) + "}";
  }
  const lines = dedent(body);
  const shown =
    lines.length > REWRITE_PREVIEW_LINES
      ? [
          ...lines.slice(0, REWRITE_PREVIEW_LINES),
          `(... ${lines.length - REWRITE_PREVIEW_LINES} more lines, unchanged)`,
        ]
      : lines;
  return [`<${name}>{\``, ...shown.map((line) => (line ? `  ${line}` : "")), `\`}</${name}>`].join("\n");
}

function escapeTemplateText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** The lines of `text` without leading and trailing blank lines or their common indentation.
 * Prose that starts right after the opening tag has no indentation of its own on that line. */
function dedent(text: string): string[] {
  const startsOnTagLine = !/^[ \t]*\n/.test(text);
  const lines = text.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && !lines[0]) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  const measured = (startsOnTagLine ? lines.slice(1) : lines).filter(Boolean);
  const indent =
    measured.length > 0 ? Math.min(...measured.map((line) => line.length - line.trimStart().length)) : 0;
  return lines.map((line, index) =>
    index === 0 && startsOnTagLine ? line.trimStart() : line.slice(indent),
  );
}

function containsJsx(node: AstNode): boolean {
  let found = false;
  walkAst(node, (candidate) => {
    if (candidate.type === "JSXElement" || candidate.type === "JSXFragment") found = true;
  });
  return found;
}

const AST_METADATA_KEYS = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments"]);

function walkAst(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkAst(item, visit);
    return;
  }
  if (!node || typeof node !== "object" || typeof (node as AstNode).type !== "string") return;
  visit(node as AstNode);
  for (const [key, value] of Object.entries(node)) {
    if (!AST_METADATA_KEYS.has(key) && value && typeof value === "object") walkAst(value, visit);
  }
}
