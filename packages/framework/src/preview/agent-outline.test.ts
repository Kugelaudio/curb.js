import { describe, expect, it } from "vitest";
import { previewAgent } from "../server/frames.js";
import { insuranceAgent } from "../test-fixtures/insurance-runtime.js";
import { agentOutline } from "./agent-outline.js";

describe("the preview's outline of the agent", () => {
  // What the server sends in the agents frame: it crosses the WebSocket as JSON.
  const described = previewAgent(insuranceAgent);

  it("carries the project's name for a project's single agent, which the page calls it by", () => {
    expect(insuranceAgent.id).toBe("agent");
    expect(previewAgent(insuranceAgent, "insurance-agent").name).toBe("insurance-agent");
    expect("name" in previewAgent(insuranceAgent)).toBe(false);
    expect("name" in previewAgent({ ...insuranceAgent, id: "support" }, "insurance-agent")).toBe(false);
  });

  it("is plain data: it arrives unchanged through JSON", () => {
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(described.skills.map((skill) => skill.path)).toEqual(insuranceAgent.routes.map((route) => route.path));
  });

  it("lists every skill and marks the interactive and the gated ones from their source", () => {
    const outline = agentOutline(JSON.parse(JSON.stringify(described)));

    expect(outline.skillPaths).toEqual(insuranceAgent.routes.map((route) => route.path));
    // The member portal has a login form; the coverage page is text only.
    expect(outline.interactivePaths.has("/member-portal")).toBe(true);
    expect(outline.interactivePaths.has("/policy-questions/coverage")).toBe(false);
    // The priority claim is linked only inside the verified branch.
    expect([...outline.gatedPaths]).toEqual(["/member-portal/priority-claim"]);
    expect(
      outline.blueprints.get("/member-portal")?.nodes.some((node) =>
        JSON.stringify(node).includes('"to":"/member-portal/priority-claim"'),
      ),
    ).toBe(true);
    expect(outline.skillMetadata.get("/policy-questions/coverage")).toEqual({
      title: "Coverage",
      description: "Use for questions about what a policy covers.",
    });
  });

  it("carries the agent's preview hints, with the placeholder's default", () => {
    const outline = agentOutline(described);
    expect(outline.suggestedPrompts).toEqual([
      "I need to report property damage",
      "What does my policy cover?",
      "How do I file a claim?",
    ]);
    expect(outline.chatPlaceholder).toBe("I need to report property damage...");
    expect(agentOutline({ ...described, preview: {} })).toMatchObject({
      suggestedPrompts: [],
      chatPlaceholder: "Message your agent…",
    });
  });
});
