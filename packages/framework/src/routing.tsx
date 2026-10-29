import { createContext, useContext, type ComponentType, type ReactElement, type ReactNode } from "react";
import type { AgentAppProps } from "./config.js";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { RouteProvider, RoutesMetaProvider } from "./route-context.js";

/**
 * A skill module's optional `meta` export — Next.js-style static metadata:
 *
 *   export const meta = { title: "Member portal", description: "…" };
 *   export default function MemberPortal() { return <>…</>; }
 *
 * `title` heads the skill's compiled context (falls back to a name derived
 * from the route path); `description` is what links and the skills index tell
 * the model about this skill (a `<Skill>` link's own `description` prop wins).
 */
export type SkillMeta = {
  title?: string;
  description?: string;
  /** Optional lucide icon name for the preview's graph node and sidebar row
   * ("lock", "shield-check"). Presentation only: never seen by the model.
   * Without it the preview keeps deriving an icon from the skill's state. */
  icon?: string;
};

export type AgentRoute = {
  path: string;
  Component: ComponentType;
  meta?: SkillMeta;
  /** Authoring-only source text used for static diagnostics and branch maps. */
  source?: string;
  /** Source module identifier or absolute filename for actionable diagnostics. */
  moduleId?: string;
};

export type SkillModule = {
  default: ComponentType;
  meta?: SkillMeta;
  source?: string;
};

/**
 * The agent folder's own `skill.tsx`, as discovery keys it. It is not a skill: a conversation
 * starts at the agent level (`agent.tsx`), so discovery leaves the file out and `curb check`
 * says where its content goes.
 */
export const AGENT_FOLDER_SKILL_MODULE = "./skill.tsx";

/** `./claims/skill.tsx` → `/claims`. Every skill lives in a folder of its own under the agent
 * folder; the agent folder's own `skill.tsx` derives no route. */
export function skillPathFromModuleId(moduleId: string): string {
  const normalized = moduleId.replace(/\\/g, "/");
  const match = normalized.match(/^\.\/(.+)\/skill\.tsx$/);
  if (!match) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
      severity: "error",
      message: `Cannot derive a skill route from module ${JSON.stringify(moduleId)}.`,
      location: { source: moduleId, component: "skill module" },
      fix: "Name the file skill.tsx and place it in a folder of its own under src/agent/, such as claims/skill.tsx.",
    });
  }

  return `/${match[1]}`;
}

/** "/member-portal/priority-claim" → "Priority claim" — the title fallback
 * when a skill module exports no `meta.title`. */
export function titleFromSkillPath(path: string): string {
  const segment = path.split("/").filter(Boolean).pop();
  if (!segment) return path;
  const words = segment.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function createSkillRoutes(
  modules: Record<string, SkillModule>,
): AgentRoute[] {
  return Object.entries(modules)
    .map(([moduleId, module]) => ({
      path: skillPathFromModuleId(moduleId),
      Component: module.default,
      meta: module.meta,
      ...(module.source === undefined ? {} : { source: module.source }),
      ...(module.source === undefined ? {} : { moduleId }),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Skill path → its module's `meta`, as `RoutesMetaProvider` serves it to `<Skill>` links. */
function metaByPathOf(routes: readonly AgentRoute[]): ReadonlyMap<string, SkillMeta> {
  return new Map(routes.flatMap((route) => (route.meta ? [[route.path, route.meta] as const] : [])));
}

/** The skills the host renders the app with (see `agentAppElement`). Null outside a host's
 * render, and inside the `<Agent>` that renders them. */
const OpenedSkillsContext = createContext<AgentAppProps | null>(null);

/**
 * The agent app as every host renders it. The routes' `meta` is in context for the whole tree,
 * so a `<Skill>` link anywhere defaults its description to the target skill's
 * `meta.description`, and the loaded skills are in context for `<Agent>`, which renders them.
 * The app itself needs none of the props it is still passed.
 */
export function agentAppElement(App: ComponentType<AgentAppProps>, props: AgentAppProps): ReactElement {
  return (
    <RoutesMetaProvider metaByPath={metaByPathOf(props.routes)}>
      <OpenedSkillsContext.Provider value={props}>
        <App {...props} />
      </OpenedSkillsContext.Provider>
    </RoutesMetaProvider>
  );
}

/**
 * What `<Agent>` renders: `children` (the agent level), then every loaded skill, least recently
 * used first. A skill module's default export is pure content; the `agent-page` around it
 * carries its path and its title (the module's `meta.title`, else derived from the path). With
 * no skill loaded, or outside a host's render, only `children` render. Nothing below renders the
 * skills again, so an `<Agent>` nested in them or in `children` cannot render a skill twice.
 */
export function WithOpenedSkills({ children }: { children?: ReactNode }) {
  const opened = useContext(OpenedSkillsContext);
  const routes = opened?.routes ?? [];
  const paths = opened ? (opened.loadedPaths ?? (opened.path ? [opened.path] : [])) : [];
  const missing = paths.find((loaded) => !routes.some((entry) => entry.path === loaded));
  if (missing !== undefined) {
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidRoute,
      severity: "error",
      message: `<Agent> cannot open ${JSON.stringify(missing)} because no skill module defines that route.`,
      location: { skillPath: missing, component: "Agent" },
      fix: `Create the matching skill module or navigate to one of: ${routes.map((route) => JSON.stringify(route.path)).join(", ")}.`,
    });
  }

  return (
    <OpenedSkillsContext.Provider value={null}>
      {children}
      {paths.map((loadedPath) => {
        const route = routes.find((entry) => entry.path === loadedPath)!;
        const LoadedSkill = route.Component;
        return (
          <RouteProvider key={loadedPath} path={loadedPath}>
            <agent-page
              path={loadedPath}
              title={route.meta?.title ?? titleFromSkillPath(loadedPath)}
            >
              <LoadedSkill />
            </agent-page>
          </RouteProvider>
        );
      })}
    </OpenedSkillsContext.Provider>
  );
}
