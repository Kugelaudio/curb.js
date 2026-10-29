import { describe, expect, it } from "vitest";
import { formatAuthoringDiagnostic, formatAuthoringLocation } from "./authoring.js";

describe("authoring diagnostic formatting", () => {
  it("uses the source path without redundant component details", () => {
    const location = {
      source: "src/agent/agent.tsx",
      skillPath: "/member-portal",
      component: "Skill",
    };

    expect(formatAuthoringLocation(location)).toBe("src/agent/agent.tsx");
    expect(
      formatAuthoringDiagnostic({
        code: "AGENT_MISSING_SKILL_DESCRIPTION",
        severity: "warning",
        message: "Missing description.",
        location,
        fix: "Add a description.",
      }),
    ).toContain("Location: src/agent/agent.tsx\nFix:");
  });

  it("appends the line, and the column when known, to the source path", () => {
    expect(formatAuthoringLocation({ source: "src/agent/claims/skill.tsx", line: 12, column: 5 })).toBe(
      "src/agent/claims/skill.tsx:12:5",
    );
    expect(formatAuthoringLocation({ source: "src/agent/claims/skill.tsx", line: 12 })).toBe("src/agent/claims/skill.tsx:12");
  });

  it("falls back to route and component when no source is available", () => {
    expect(formatAuthoringLocation({ skillPath: "/claims", component: "Skill" })).toBe(
      'skill "/claims" · component Skill',
    );
  });
});
