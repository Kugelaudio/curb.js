/**
 * The text of the agent registry module that replaces filesystem discovery in a bundle: static
 * imports (module + `?raw` source) of the agent entry and every `skill.tsx`, keyed
 * `./agent/<relative path>`; `agent-registry.node.ts` reads it. Node-free, because two builds
 * generate it: `curb build` over the project directory (`agent-modules.ts`) and the browser
 * runtime's worker over the files it fetched (`browser/project-compile.ts`).
 */

export const AGENT_ENTRY_CANDIDATES = ["agent.tsx", "agent.ts"];

/** `entry` and `skills` are agent-dir-relative POSIX paths; `modulePath` turns one into the
 * specifier the bundle imports it by. */
export function agentRegistryCode(entry: string, skills: readonly string[], modulePath: (agentRelative: string) => string): string {
  const lines: string[] = [];
  const agentPath = modulePath(entry);
  lines.push(`import * as agentModule from ${JSON.stringify(agentPath)};`);
  lines.push(`import agentSource from ${JSON.stringify(`${agentPath}?raw`)};`);
  skills.forEach((relativePath, index) => {
    const path = modulePath(relativePath);
    lines.push(`import * as skillModule${index} from ${JSON.stringify(path)};`);
    lines.push(`import skillSource${index} from ${JSON.stringify(`${path}?raw`)};`);
  });
  lines.push(`export const agentModules = { ${JSON.stringify(`./agent/${entry}`)}: agentModule };`);
  lines.push(`export const agentSources = { ${JSON.stringify(`./agent/${entry}`)}: agentSource };`);
  lines.push(
    `export const skillModules = { ${skills
      .map((relativePath, index) => `${JSON.stringify(`./agent/${relativePath}`)}: skillModule${index}`)
      .join(", ")} };`,
  );
  lines.push(
    `export const skillSources = { ${skills
      .map((relativePath, index) => `${JSON.stringify(`./agent/${relativePath}`)}: skillSource${index}`)
      .join(", ")} };`,
  );
  return `${lines.join("\n")}\n`;
}
