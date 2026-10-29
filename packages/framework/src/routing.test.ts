import { describe, expect, it } from "vitest";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { AGENT_FOLDER_SKILL_MODULE, createSkillRoutes, skillPathFromModuleId } from "./routing.js";

describe("skill routing", () => {
  it("maps skill files to directory routes", () => {
    expect(skillPathFromModuleId("./property-damage/skill.tsx")).toBe("/property-damage");
    expect(skillPathFromModuleId("./claim-procedure/skill.tsx")).toBe("/claim-procedure");
    expect(skillPathFromModuleId("./policy-questions/coverage/skill.tsx")).toBe("/policy-questions/coverage");
    expect(skillPathFromModuleId("./policy-questions/deductibles/skill.tsx")).toBe("/policy-questions/deductibles");
  });

  it("derives no route from the agent folder's own skill.tsx: the agent level is not a skill", () => {
    let thrown: unknown;
    try {
      skillPathFromModuleId(AGENT_FOLDER_SKILL_MODULE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    expect((thrown as AgentAuthoringError).diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidRoute);
  });

  it("builds route entries from skill modules", () => {
    function PropertyDamage() {
      return null;
    }
    function PolicyCoverage() {
      return null;
    }

    const routes = createSkillRoutes({
      "./property-damage/skill.tsx": { default: PropertyDamage },
      "./policy-questions/coverage/skill.tsx": { default: PolicyCoverage },
    });

    expect(routes).toEqual([
      { path: "/policy-questions/coverage", Component: PolicyCoverage },
      { path: "/property-damage", Component: PropertyDamage },
    ]);
  });
});
