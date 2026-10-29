import { skillPathFromUrl, skillUrl } from "./skill-url.js";

/**
 * The page's URL. Every view someone may want to send a link to has one, and back and
 * forward move between them:
 *
 *   /                          the conversation and the agent's context
 *   /graph                     the graph of the agent's skills
 *   /tools, /mcp               the agent's context (both name its tools)
 *   /system-prompt             the Instructions dialog
 *   /diagnostics               the problems dialog
 *   /skill/<path>              a skill's sheet
 *
 * The `/skill` prefix is web-only: the skill path the model sees never carries it. A page
 * served under a path (a browser dev session, `/agents/session/<id>`) has every route under
 * that base: `pageBase()`.
 */
export type PreviewRoute =
  | { kind: "home" }
  | { kind: "graph" }
  | { kind: "tools" }
  | { kind: "instructions" }
  | { kind: "diagnostics" }
  | { kind: "skill"; path: string };

/** What is open over the two columns. */
export type PreviewOverlay =
  | { kind: "skill"; path: string }
  | { kind: "graph" }
  | { kind: "instructions" }
  | { kind: "diagnostics" };

/** The page's view state, which the URL mirrors: what is open over the two columns. */
export type PreviewView = { overlay: PreviewOverlay | null };

const NAMED_ROUTES: ReadonlyArray<readonly [string, Exclude<PreviewRoute["kind"], "skill">]> = [
  ["/graph", "graph"],
  ["/tools", "tools"],
  ["/mcp", "tools"],
  ["/system-prompt", "instructions"],
  ["/diagnostics", "diagnostics"],
];

/** The path the page is served under (`<html data-curb-base>`, set by the browser dev page), "" at the root. */
export function pageBase(root: { dataset: DOMStringMap } = document.documentElement): string {
  return root.dataset.curbBase ?? "";
}

/** The route for a URL path under `base`. A skill the agent does not have opens nothing. */
export function routeFromPath(pathname: string, skillPaths: readonly string[], base = ""): PreviewRoute {
  const local = base && (pathname === base || pathname.startsWith(`${base}/`)) ? pathname.slice(base.length) : pathname;
  const path = local.length > 1 && local.endsWith("/") ? local.slice(0, -1) : local;
  if (path === "" || path === "/") return { kind: "home" };
  const named = NAMED_ROUTES.find(([url]) => url === path)?.[1];
  if (named) return { kind: named };
  const skill = skillPathFromUrl(path);
  if (skill !== null && skillPaths.includes(skill)) return { kind: "skill", path: skill };
  return { kind: "home" };
}

/** The URL path of `route` under `base`. */
export function pathForRoute(route: PreviewRoute, base = ""): string {
  const path = localPath(route);
  return base ? `${base}${path === "/" ? "" : path}` : path;
}

function localPath(route: PreviewRoute): string {
  switch (route.kind) {
    case "home":
      return "/";
    case "graph":
      return "/graph";
    case "tools":
      return "/tools";
    case "instructions":
      return "/system-prompt";
    case "diagnostics":
      return "/diagnostics";
    case "skill":
      return skillUrl(route.path);
  }
}

/** The view a route opens: the graph, a dialog or a skill's sheet over the two columns. */
export function viewForRoute(route: PreviewRoute): PreviewView {
  switch (route.kind) {
    case "home":
    case "tools":
      return { overlay: null };
    case "graph":
    case "instructions":
    case "diagnostics":
      return { overlay: { kind: route.kind } };
    case "skill":
      return { overlay: { kind: "skill", path: route.path } };
  }
}

/** The route a view is reached by. */
export function routeForView(view: PreviewView): PreviewRoute {
  return view.overlay ?? { kind: "home" };
}
