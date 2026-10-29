import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentLlmClient } from "../agent-session.js";
import { discoverAgent, resolveDefaultAgentId } from "../agent.node.js";
import { generateAgentModulesCode } from "../bundler/agent-modules.js";
import { agentSourceKeys } from "../bundler/assets.js";
import { skillPathFromModuleId } from "../routing.js";
import { createAgentSession } from "./bootstrap.js";

const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });

const PROJECT_DIR = fileURLToPath(new URL("../test-fixtures/project/", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("../test-fixtures/project/src/agent/", import.meta.url));

describe("Node host bootstrap", () => {
  it("filesystem agent discovery finds the skills the bundled registry carries", async () => {
    const discovered = await discoverAgent(AGENT_DIR);
    expect(discovered.id).toBe("agent");

    // `curb build` bundles a static registry from its own walk of src/agent/; a hosted
    // artifact must route exactly the skills filesystem discovery does.
    const bundledSkillPaths = agentSourceKeys(generateAgentModulesCode(PROJECT_DIR))
      .filter((key) => key.endsWith("/skill.tsx"))
      .map((key) => skillPathFromModuleId(`./${key.slice("./agent/".length)}`));
    expect(discovered.homeSkill).toBeUndefined();
    expect(discovered.routes.map((route) => route.path).sort()).toEqual(bundledSkillPaths.sort());
  });

  it("resolves the default agent (first sorted id, AGENT_DEFAULT override)", async () => {
    const agents = [await discoverAgent(AGENT_DIR)];
    expect(resolveDefaultAgentId(agents, {})).toBe("agent");
    expect(resolveDefaultAgentId(agents, { AGENT_DEFAULT: "agent" })).toBe("agent");
    expect(() => resolveDefaultAgentId(agents, { AGENT_DEFAULT: "nope" })).toThrow(/does not match/);
  });

  it("builds a headless runtime with the agent's skills and tools", async () => {
    const { runtime, session, agentId } = await createAgentSession(idleLlm);
    const snapshot = runtime.snapshot();

    expect(agentId).toBe("agent");
    // Every conversation starts at the agent level, with no skill loaded.
    expect(snapshot.context.path).toBe("");
    expect(snapshot.context.loadedSkills).toEqual([]);
    expect(snapshot.context.links.map((link) => link.to)).toContain("/property-damage");
    // The global request_callback tool is always present. MCP tools are NOT:
    // remote servers connect via the preview's MCP menu, not at boot.
    expect(snapshot.context.tools.map((tool) => tool.name)).toContain("request_callback");
    expect(snapshot.context.tools.some((tool) => tool.id.startsWith("mcp:"))).toBe(false);

    expect(session.isRunning).toBe(false);
    expect(session.messages).toEqual([]);
  });

  it("builds a session for the explicit project agent id", async () => {
    const { agentId, runtime } = await createAgentSession(idleLlm, undefined, "agent");
    expect(agentId).toBe("agent");
    expect(runtime.snapshot().context.path).toBe("");
  });

});
