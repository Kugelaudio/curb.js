import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Root of the consuming agent project — the directory holding `package.json`,
 * `src/agent/`, and optionally `context/`. Hosts started by the CLI inherit it
 * via `AGENT_PROJECT_DIR`; hosts started directly (tests) set
 * that env var themselves. Falls back to the working directory, which is
 * correct when a host runs from the project root.
 */
export function resolveProjectRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.AGENT_PROJECT_DIR ?? process.cwd());
}

/** The project's authoring surface. Throws an agent-readable error when the
 * directory is missing (usually: the CLI ran outside a project root). */
export function resolveAgentDir(projectRoot: string = resolveProjectRoot()): string {
  const agentDir = join(projectRoot, "src", "agent");
  if (!existsSync(agentDir)) {
    throw new Error(missingAgentMessage(projectRoot));
  }
  return agentDir;
}

/** Optional per-project markdown for file-backed `<Text file=…>` content.
 * A missing directory is a defined empty state, not an error. */
export function resolveContextDir(projectRoot: string = resolveProjectRoot()): string {
  return join(projectRoot, "context");
}

export function missingAgentMessage(projectRoot: string): string {
  return [
    `No agent found: ${join(projectRoot, "src/agent/")} does not exist.`,
    "",
    "A framework project keeps its agent in src/agent/:",
    "  src/agent/agent.tsx          exports `agent` (a defineAgent(...) result): where every conversation starts",
    "  src/agent/<name>/skill.tsx   one folder per skill, opened when needed",
    "",
    "Fix: run this command from the project root (the directory containing",
    "src/agent/), or create the files above.",
  ].join("\n");
}
