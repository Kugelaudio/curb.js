import { describe, expect, it } from "vitest";
import { agentName } from "./agent-sphere.js";

describe("the agent's name on the page", () => {
  it("is its project's package name for a project's single agent", () => {
    expect(agentName("agent", "insurance-agent")).toBe("Insurance agent");
    expect(agentName("agent", "@acme/front_desk")).toBe("Front desk");
  });

  it("is \"Your agent\" when the project has no name", () => {
    expect(agentName("agent")).toBe("Your agent");
    expect(agentName("agent", "")).toBe("Your agent");
    expect(agentName("agent", "@acme/")).toBe("Your agent");
  });

  it("is its folder for an agent of a multi-agent host, whatever the project is called", () => {
    expect(agentName("support")).toBe("Support");
    expect(agentName("ops-desk", "insurance-agent")).toBe("Ops desk");
  });
});
