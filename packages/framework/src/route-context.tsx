import { createContext, useContext } from "react";
import type { SkillMeta } from "./routing.js";

const RoutePathContext = createContext<string | null>(null);

export function RouteProvider({ path, children }: { path: string; children: React.ReactNode }) {
  return <RoutePathContext.Provider value={path}>{children}</RoutePathContext.Provider>;
}

export function useRoutePath() {
  return useContext(RoutePathContext);
}

/**
 * Programmatic navigation, Next.js-style: `useRouter().push(path)` loads a
 * skill from code — e.g. a tool handler that finishes intake and moves the
 * agent to the follow-up skill. Provided by the runtime itself, so it works
 * in any skill without setup. Inside a tool call the navigation lands in the
 * SAME context diff the tool result carries, so the model sees the new
 * skill's instructions as the outcome of its call.
 */
export type AgentRouterApi = {
  /** Load `path` and make it the active skill (same semantics as the model's
   * `read_skill`: LRU window, eviction past `maxLoadedSkills`). */
  push: (path: string) => void;
};

const RouterContext = createContext<AgentRouterApi | null>(null);

/** Mounted automatically by `AgentSiteRuntime` — authors never render this. */
export function RouterProvider({
  router,
  children,
}: {
  router: AgentRouterApi;
  children: React.ReactNode;
}) {
  return <RouterContext.Provider value={router}>{children}</RouterContext.Provider>;
}

export function useRouter(): AgentRouterApi {
  const router = useContext(RouterContext);
  if (!router) {
    throw new Error(
      "useRouter must run inside an agent runtime (RouterProvider is mounted automatically by AgentSiteRuntime).",
    );
  }
  return router;
}

/** Skill path → its module's `meta` export. Provided around the whole app by the
 * host (`agentAppElement`) and around the opened skills by `<Agent>`, so a
 * `<Skill>` link anywhere defaults its description to the TARGET skill's
 * `meta.description` — the description lives with the skill, not per link. */
const RoutesMetaContext = createContext<ReadonlyMap<string, SkillMeta>>(new Map());

export function RoutesMetaProvider({
  metaByPath,
  children,
}: {
  metaByPath: ReadonlyMap<string, SkillMeta>;
  children: React.ReactNode;
}) {
  return <RoutesMetaContext.Provider value={metaByPath}>{children}</RoutesMetaContext.Provider>;
}

export function useSkillMeta(path: string): SkillMeta | undefined {
  return useContext(RoutesMetaContext).get(path);
}
