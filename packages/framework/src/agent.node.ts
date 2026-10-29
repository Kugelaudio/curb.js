import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES, type AuthoringDiagnostic } from "./authoring.js";
import { renderErrorOrigin } from "./authoring-diagnostics.js";
import type { AgentDefinition } from "./config.js";
import type { HomeSkillFile } from "./home-skill-migration.js";
import type { AgentRoute } from "./routing.js";
import { discoverSkillRoutes, readHomeSkillFile } from "./routing.node.js";

/** One discovered agent: folder name is the id (also shown in the preview). */
export type DiscoveredAgent = {
  id: string;
  definition: AgentDefinition;
  /** Its skills; none is a complete agent too (everything in `agent.tsx`). */
  routes: AgentRoute[];
  source: string;
  diagnostics: AuthoringDiagnostic[];
  /** The agent folder's own `skill.tsx`, left over from before the agent level: not loaded,
   * reported by `curb check`. */
  homeSkill?: HomeSkillFile;
};

/** Matches source (ts/tsx) and compiled (js) agent entry modules. */
const AGENT_ENTRY_CANDIDATES = ["agent.tsx", "agent.ts", "agent.js"];

/**
 * Generic multi-agent discovery helper retained for custom hosts. The starter
 * project uses `discoverAgent()` on its single `src/agent/` directory.
 */
/** Discover the starter project's single author-facing `src/agent/` folder. */
export async function discoverAgent(agentDir: string, id = "agent"): Promise<DiscoveredAgent> {
  const entryFile = findAgentEntry(agentDir);
  if (!entryFile) {
    throw new Error(`${agentDir} has no agent.tsx exporting \`agent\`.`);
  }
  return loadAgent(agentDir, id, entryFile);
}

/**
 * The `agent` the folder's `agent.tsx` exports, imported the way {@link discoverAgent} imports it
 * but without its skills: `curb build` reads the goals and experiments it writes into the bundle
 * manifest from it.
 */
export async function loadAgentDefinition(agentDir: string): Promise<AgentDefinition> {
  const entryFile = findAgentEntry(agentDir);
  if (!entryFile) {
    throw new Error(`${agentDir} has no agent.tsx exporting \`agent\`.`);
  }
  return importAgentDefinition(entryFile);
}

function findAgentEntry(dir: string): string | undefined {
  return AGENT_ENTRY_CANDIDATES.map((name) => join(dir, name)).find(existsSync);
}

async function importAgentDefinition(entryFile: string): Promise<AgentDefinition> {
  const module = (await import(pathToFileURL(entryFile).href)) as { agent?: AgentDefinition };
  if (!module.agent) {
    throw new Error(`Agent module "${entryFile}" must export \`agent\` (a defineAgent result).`);
  }
  return module.agent;
}

async function loadAgent(dir: string, id: string, entryFile: string): Promise<DiscoveredAgent> {
  const definition = await importAgentDefinition(entryFile);
  const homeSkill = readHomeSkillFile(dir);
  return {
    id,
    definition,
    routes: await discoverSkillRoutes(dir),
    source: readFileSync(entryFile, "utf8"),
    diagnostics: [],
    ...(homeSkill ? { homeSkill } : {}),
  };
}

const AGENT_NOT_LOADED = "The agent could not be loaded";

/**
 * The diagnostic for an agent whose modules threw while being imported (`curb check`, and
 * `curb dev` loading it after a save): a syntax error at the line the compiler reports, an
 * `AgentAuthoringError` as it was raised, else the project line the error came from.
 */
export function agentLoadFailure(error: unknown, projectRoot: string, agentId = "agent"): AuthoringDiagnostic {
  if (error instanceof AgentAuthoringError) {
    return { ...error.diagnostic, location: { agentId, ...error.diagnostic.location } };
  }
  const root = realProjectRoot(projectRoot);
  const message = error instanceof Error ? error.message : String(error);
  const syntax = compileErrorAt(message);
  if (syntax) {
    const source = projectRelative(syntax.file, [root, projectRoot]);
    return {
      code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
      severity: "error",
      message: `${AGENT_NOT_LOADED}: its code does not compile: ${syntax.text}`,
      location: { agentId, source, line: syntax.line, column: syntax.column },
      fix: "Fix the code at this line. `curb check` lists every type and syntax error under src/.",
    };
  }
  const origin = renderErrorOrigin(error, root);
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.renderFailed,
    severity: "error",
    message: `${AGENT_NOT_LOADED}: ${message}`,
    location: origin
      ? { agentId, source: origin.file, line: origin.line, column: origin.column }
      : { agentId, source: "src/agent/agent.tsx" },
    fix: "Fix the error where it was thrown; the agent's modules must import without throwing. Type errors, which `curb check` lists, are the usual cause.",
  };
}

/**
 * The first error of a TypeScript/JSX compile failure, as tsx reports esbuild's:
 * `Transform failed with 1 error:\n/abs/src/x.ts:1:42: ERROR: Unexpected ";"`. The column
 * there counts from 0; the diagnostic's counts from 1.
 */
function compileErrorAt(message: string): { file: string; line: number; column: number; text: string } | null {
  const match = /^(.+?):(\d+):(\d+): ERROR: (.+)$/m.exec(message);
  if (!match) return null;
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) + 1, text: match[4] };
}

function realProjectRoot(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    return projectRoot;
  }
}

/** `file` from the first of `roots` it is under, with forward slashes; else as given. */
function projectRelative(file: string, roots: readonly string[]): string {
  const posix = file.split("\\").join("/");
  for (const root of roots) {
    const prefix = `${root.split("\\").join("/").replace(/\/+$/, "")}/`;
    if (posix.startsWith(prefix)) return posix.slice(prefix.length);
  }
  return posix;
}

/** The boot-time agent: AGENT_DEFAULT env var, or the first id in sorted order. */
export function resolveDefaultAgentId(agents: DiscoveredAgent[], env = process.env): string {
  const requested = env.AGENT_DEFAULT?.trim();
  if (requested) {
    if (!agents.some((agent) => agent.id === requested)) {
      throw new Error(
        `AGENT_DEFAULT="${requested}" does not match any agent. ` +
          `Available: ${agents.map((agent) => agent.id).join(", ")}.`,
      );
    }
    return requested;
  }
  return agents[0].id;
}
