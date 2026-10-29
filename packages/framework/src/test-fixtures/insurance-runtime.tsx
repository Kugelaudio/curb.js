import { fileURLToPath } from "node:url";
import { discoverAgent } from "../agent.node.js";
import { agentAppElement } from "../routing.js";
import { AgentSiteRuntime } from "../index.js";
import { agent } from "./project/src/agent/agent.js";

export { INSURANCE_AGENT_SYSTEM_PROMPT, agent } from "./project/src/agent/agent.js";

/**
 * The bundled fixture project's agent (`./project/`), discovered from the filesystem the
 * way the Node hosts discover a real consuming project's (see `../server/bootstrap.ts`).
 */
export const insuranceAgent = await discoverAgent(
  fileURLToPath(new URL("./project/src/agent/", import.meta.url)),
);

/** Test fixture: the insurance demo agent as a ready-made runtime, at the agent level. */
export function createInsuranceDemoRuntime() {
  const { routes } = insuranceAgent;
  return new AgentSiteRuntime(
    ({ path, loadedPaths }) => agentAppElement(agent.app, { path, loadedPaths, routes }),
    { maxLoadedSkills: agent.maxLoadedSkills },
  );
}
