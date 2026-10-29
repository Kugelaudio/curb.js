import { describe, expect, it } from "vitest";
import { pathForRoute, routeForView, routeFromPath, viewForRoute, type PreviewView } from "./preview-route.js";

const skills = ["/member-portal", "/member-portal/priority-claim"];
const home: PreviewView = { overlay: null };
const graph: PreviewView = { overlay: { kind: "graph" } };

describe("the preview's URL", () => {
  // Links people already have keep working: skill URLs and the old pane routes.
  it("opens a skill's sheet from its skill URL, nested paths included", () => {
    expect(routeFromPath("/skill/member-portal/priority-claim", skills)).toEqual({
      kind: "skill",
      path: "/member-portal/priority-claim",
    });
    expect(routeFromPath("/skill/member-portal/", skills)).toEqual({ kind: "skill", path: "/member-portal" });
  });

  it("maps the old pane routes onto the view or dialog that holds them now", () => {
    expect(routeFromPath("/graph", skills)).toEqual({ kind: "graph" });
    expect(routeFromPath("/system-prompt", skills)).toEqual({ kind: "instructions" });
    expect(routeFromPath("/diagnostics", skills)).toEqual({ kind: "diagnostics" });
    expect(routeFromPath("/tools", skills)).toEqual({ kind: "tools" });
    expect(routeFromPath("/mcp", skills)).toEqual({ kind: "tools" });
  });

  it("keeps every route under the path the page is served under", () => {
    const base = "/agents/session/a1";
    expect(routeFromPath(base, skills, base)).toEqual({ kind: "home" });
    expect(routeFromPath(`${base}/`, skills, base)).toEqual({ kind: "home" });
    expect(routeFromPath(`${base}/graph`, skills, base)).toEqual({ kind: "graph" });
    expect(routeFromPath(`${base}/skill/member-portal`, skills, base)).toEqual({ kind: "skill", path: "/member-portal" });
    expect(routeFromPath("/agents/session/a12/graph", skills, base)).toEqual({ kind: "home" });
    expect(pathForRoute({ kind: "home" }, base)).toBe(base);
    expect(pathForRoute({ kind: "skill", path: "/member-portal" }, base)).toBe(`${base}/skill/member-portal`);
    expect(pathForRoute({ kind: "graph" })).toBe("/graph");
  });

  it("opens nothing for a skill the agent does not have", () => {
    expect(routeFromPath("/skill/claims", skills)).toEqual({ kind: "home" });
    expect(routeFromPath("/skill", skills)).toEqual({ kind: "home" });
    expect(routeFromPath("/nowhere", skills)).toEqual({ kind: "home" });
    expect(routeFromPath("/", skills)).toEqual({ kind: "home" });
  });

  it("writes the URL each view is reached by", () => {
    expect(pathForRoute(routeForView(home))).toBe("/");
    expect(pathForRoute(routeForView(graph))).toBe("/graph");
    expect(pathForRoute(routeForView({ overlay: { kind: "skill", path: "/member-portal" } }))).toBe("/skill/member-portal");
    expect(pathForRoute(routeForView({ overlay: { kind: "instructions" } }))).toBe("/system-prompt");
    expect(pathForRoute(routeForView({ overlay: { kind: "diagnostics" } }))).toBe("/diagnostics");
  });

  it("opens the graph, a dialog or a sheet over the two columns, and the home route closes it", () => {
    expect(viewForRoute({ kind: "skill", path: "/member-portal" })).toEqual({
      overlay: { kind: "skill", path: "/member-portal" },
    });
    expect(viewForRoute({ kind: "graph" })).toEqual(graph);
    expect(viewForRoute({ kind: "instructions" })).toEqual({ overlay: { kind: "instructions" } });
    expect(viewForRoute({ kind: "tools" })).toEqual(home);
    expect(viewForRoute({ kind: "home" })).toEqual(home);
  });
});
