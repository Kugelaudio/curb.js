import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { missingAgentMessage } from "../project.node.js";
import { AGENT_ENTRY_CANDIDATES, agentRegistryCode } from "./agent-registry-code.js";

/**
 * The agent registry `curb build` bundles in place of filesystem discovery.
 *
 * Discovery walks `src/agent/` and imports what it finds by computed path, which a bundler
 * cannot follow. This lists the project's agent entry and every `skill.tsx` for the static
 * registry `agent-registry-code.ts` writes instead.
 */

/** Depth-first `skill.tsx` files, as agent-dir-relative POSIX paths. */
function listSkillFiles(agentDir: string): string[] {
  const files: string[] = [];
  function walk(directory: string, prefix: string): void {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (entry.name === "skill.tsx") files.push(`${prefix}${entry.name}`);
    }
  }
  walk(agentDir, "");
  return files;
}

export function generateAgentModulesCode(projectRoot: string): string {
  const agentDir = join(projectRoot, "src", "agent");
  if (!existsSync(agentDir)) {
    throw new Error(missingAgentMessage(projectRoot));
  }
  const entry = AGENT_ENTRY_CANDIDATES.find((name) => existsSync(join(agentDir, name)));
  if (!entry) {
    throw new Error(missingAgentMessage(projectRoot));
  }
  return agentRegistryCode(entry, listSkillFiles(agentDir), (relativePath) => join(agentDir, relativePath));
}
