import { describe, expect, it } from "vitest";
import {
  AGENT_NODE_ID,
  availableSkills,
  buildSkillGraph,
  buildToolCatalog,
  staticSkillLinks,
  staticToolCalls,
} from "./agent-graph-model.js";
import type { CompiledContext } from "../types.js";
import type { SkillBlueprint } from "./skill-blueprint.js";

describe("available skill graph", () => {
  it("uses the current compiled links and orders them stably", () => {
    expect(
      availableSkills({
        links: [
          { to: "/support", label: "Support", scope: "global" },
          { to: "/account", label: "Account", scope: "page" },
        ],
      }),
    ).toEqual([
      { to: "/account", label: "Account", scope: "page" },
      { to: "/support", label: "Support", scope: "global" },
    ]);
  });

  it("prefers a page declaration when the same skill is also global", () => {
    expect(
      availableSkills({
        links: [
          {
            to: "/support",
            label: "General support",
            description: "Available everywhere",
            scope: "global",
          },
          {
            to: "/support",
            label: "Contact support",
            description: "Help for this page",
            scope: "page",
          },
        ],
      }),
    ).toEqual([
      {
        to: "/support",
        label: "Contact support",
        description: "Help for this page",
        scope: "page",
      },
    ]);
  });

  it("keeps a link to the current skill because it remains available to the agent", () => {
    expect(
      availableSkills({ links: [{ to: "/claims", label: "Claims", scope: "page" }] }),
    ).toHaveLength(1);
  });

  it("finds locked skills nested in source-only block sections", () => {
    const blueprint: SkillBlueprint = {
      nodes: [
        {
          kind: "block",
          block: "gate",
          label: "Member area",
          relation: "oneOf",
          children: [],
          sections: [
            { id: "locked", label: "locked", children: [] },
            {
              id: "unlocked",
              label: "unlocked",
              children: [
                {
                  kind: "skill",
                  label: "Priority claim",
                  to: "/member-portal/priority-claim",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(staticSkillLinks(blueprint)).toEqual([
      {
        to: "/member-portal/priority-claim",
        label: "Priority claim",
        description: undefined,
        locked: true,
      },
    ]);
  });

  it("takes a link's polarity from the INNERMOST condition that has one", () => {
    // Shape of the claim-status skill: an outer "has a lookup happened" test
    // whose false side holds the real true/false decision. The outer condition
    // is a precondition for BOTH targets, so the inner one is what
    // distinguishes them.
    const blueprint: SkillBlueprint = {
      nodes: [
        {
          kind: "block",
          block: "if",
          label: "lookup === null",
          relation: "oneOf",
          children: [],
          sections: [
            {
              id: "false",
              label: "false",
              polarity: "negative",
              children: [
                {
                  kind: "block",
                  block: "if",
                  label: "lookup.hasOpenClaim",
                  relation: "oneOf",
                  children: [],
                  sections: [
                    {
                      id: "true",
                      label: "true",
                      polarity: "positive",
                      children: [{ kind: "skill", label: "Track", to: "/track", children: [] }],
                    },
                    {
                      id: "false",
                      label: "false",
                      polarity: "negative",
                      children: [{ kind: "skill", label: "File", to: "/file", children: [] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const byPath = new Map(staticSkillLinks(blueprint).map((link) => [link.to, link]));
    expect(byPath.get("/track")).toMatchObject({ locked: true, polarity: "positive" });
    expect(byPath.get("/file")).toMatchObject({ locked: true, polarity: "negative" });

    // Both sides name the SAME condition, which is what lets a skill with
    // several decisions still be read as pairs. It is the inner condition, not
    // the outer precondition the two links share.
    expect(byPath.get("/track")?.decision).toBe("lookup.hasOpenClaim");
    expect(byPath.get("/file")?.decision).toBe("lookup.hasOpenClaim");
  });

  it("leaves links with no boolean above them uncoloured", () => {
    // A procedure step is a section, so its links are locked — but a step is
    // not a boolean, so there is nothing to colour true or false.
    const blueprint: SkillBlueprint = {
      nodes: [
        {
          kind: "block",
          block: "procedure",
          label: "Order",
          relation: "sequence",
          children: [],
          sections: [
            {
              id: "step-1",
              label: "Confirm safety",
              children: [{ kind: "skill", label: "Intake", to: "/intake", children: [] }],
            },
          ],
        },
      ],
    };

    expect(staticSkillLinks(blueprint)[0]).toEqual({
      to: "/intake",
      label: "Intake",
      description: undefined,
      locked: true,
    });
  });

  it("catalogs runtime, live, and source-only tool calls", () => {
    const blueprint: SkillBlueprint = {
      nodes: [
        {
          kind: "block",
          block: "if",
          label: "ready",
          relation: "oneOf",
          children: [],
          sections: [
            {
              id: "then",
              label: "ready",
              children: [{ kind: "tool", label: "submit_claim", children: [] }],
            },
          ],
        },
      ],
    };
    expect(staticToolCalls(blueprint)).toEqual(["submit_claim"]);

    const context = {
      tools: [
        {
          id: "runtime:read_skill",
          name: "read_skill",
          description: "Read a skill.",
          inputSchema: { type: "object", properties: {} },
          scope: "runtime",
        },
        {
          id: "global:callback",
          name: "request_callback",
          description: "Request a callback.",
          inputSchema: { type: "object", properties: {} },
          scope: "global",
        },
      ],
    } as CompiledContext;
    const catalog = buildToolCatalog(
      context,
      new Map([["/claims", blueprint]]),
      null,
    );

    expect(catalog.map((tool) => [tool.name, tool.ownerPath])).toEqual([
      ["read_skill", undefined],
      ["request_callback", undefined],
      ["submit_claim", "/claims"],
    ]);
  });

  it("starts the graph at the agent and preserves locked connections", () => {
    // At the agent level: no skill loaded yet.
    const context = {
      path: "",
      loadedSkills: [],
      links: [{ to: "/member-portal", label: "member portal", scope: "global" }],
    } as unknown as CompiledContext;
    const blueprints = new Map<string, SkillBlueprint | null>([
      [
        "/member-portal",
        {
          nodes: [
            {
              kind: "block",
              block: "if",
              label: "verified",
              relation: "oneOf",
              children: [],
              sections: [
                {
                  id: "then",
                  label: "verified",
                  children: [
                    {
                      kind: "skill",
                      label: "Priority claim",
                      to: "/member-portal/priority-claim",
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    ]);

    const graph = buildSkillGraph(
      context,
      blueprints,
      null,
      new Map([["/member-portal", { title: "Member portal" }]]),
    );
    // The agent opens its indexed skills; no skill stands in for the agent.
    expect(graph.edges).toContainEqual({
      source: AGENT_NODE_ID,
      target: "/member-portal",
      label: "member portal",
      state: "available",
    });
    expect(graph.nodes.some((node) => node.path === AGENT_NODE_ID)).toBe(false);
    expect(graph.nodes.find((node) => node.path === "/member-portal")?.label).toBe(
      "Member portal",
    );
    expect(graph.edges).toContainEqual({
      source: "/member-portal",
      target: "/member-portal/priority-claim",
      label: "Priority claim",
      state: "locked",
    });
    expect(
      graph.nodes.find((node) => node.path === "/member-portal/priority-claim")?.state,
    ).toBe("locked");
  });
});
