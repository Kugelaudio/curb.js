import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { agentLoadFailure, discoverAgent, type DiscoveredAgent } from "../agent.node.js";
import { agentToolInventory, diagnoseAgentAuthoring, type DiagnosableAgent } from "../authoring-diagnostics.js";
import {
  AUTHORING_DIAGNOSTIC_CODES,
  formatAuthoringDiagnostic,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
} from "../authoring.js";
import { isRemoteConfig, type McpAnyServerConfig } from "../mcp/config.js";
import { getMcpManager } from "../mcp/manager.js";
import type { McpToolInfo } from "../mcp/to-tool-definition.js";
import {
  diagnoseMcpToolsStale,
  MCP_TOOLS_FILE,
  readMcpToolsSnapshot,
  snapshotToolNames,
  type McpToolsSnapshot,
} from "../mcp-tools-stale.js";
import { resolveAgentDir } from "../project.node.js";
import { diagnoseScenarios, writtenToolNames, type CheckedScenario } from "../scenario-diagnostics.js";
import type { Env } from "../provider-keys.js";
import type { StoredProjectKey } from "./cloud/credentials.js";
import { checkConfiguration, formatConfiguration, projectEnvironment, type Configuration } from "./check-env.js";
import { typeCheckProject, type TypeCheckResult } from "./typecheck.js";
import { diagnoseVoices, type findVoice } from "./voices.js";

/** The single agent a project keeps in src/agent/ (see `discoverAgent`). */
const AGENT_ID = "agent";

export type CheckReport = {
  diagnostics: AuthoringDiagnostic[];
  typeCheck: TypeCheckResult;
  typeCheckMs: number;
  /** The environment variables the project needs, set or missing (names only). */
  configuration: Configuration;
  /** What could not be checked and why (a voice lookup that did not get an answer). */
  notes: string[];
};

/**
 * Everything `curb check` knows about a project: its TypeScript errors under src/, a leftover
 * src/orchestration/, the authoring diagnostics of the rendered agent, which include what a
 * project from before the agent level still has to move, and the environment variables the
 * project needs (`check-env.ts`). The type check runs first and does not need the agent to
 * load, so a project whose module throws on import still gets the type error behind it.
 * `env` is the process environment the variables are looked up in, under the project's .env.
 * `loginKey` is the key `curb login` stored that this run uses, when it uses one.
 */
export async function checkProject(
  projectRoot: string,
  options: {
    typeCheck?: typeof typeCheckProject;
    env?: Env;
    loginKey?: StoredProjectKey | null;
    findVoice?: typeof findVoice;
    /** What each reachable MCP server of the agent lists now, by server id (tests stand in). */
    listMcpTools?: typeof listReachableMcpTools;
  } = {},
): Promise<CheckReport> {
  const root = realpathSync(projectRoot);
  const started = Date.now();
  const typeCheck = await (options.typeCheck ?? typeCheckProject)(root, AGENT_ID);
  const typeCheckMs = Date.now() - started;

  const diagnostics: AuthoringDiagnostic[] = [...typeCheck.diagnostics];
  if (existsSync(join(root, "src", "orchestration"))) diagnostics.push(orchestrationIgnored());

  let agent: DiscoveredAgent | null = null;
  try {
    agent = await discoverAgent(resolveAgentDir(root), AGENT_ID);
  } catch (error) {
    diagnostics.push(agentLoadFailure(error, root, AGENT_ID));
  }
  const notes: string[] = [];
  if (agent) {
    const diagnosable: DiagnosableAgent = {
      id: agent.id,
      definition: agent.definition,
      routes: agent.routes,
      source: agent.source,
      projectRoot: root,
      homeSkill: agent.homeSkill,
      writtenTools: sourceFiles(join(root, "src")).flatMap((file) => writtenToolNames(readFileSync(file, "utf8"))),
    };
    diagnostics.push(...diagnoseAgentAuthoring(diagnosable));
    const mcp = readProjectMcpSnapshot(root, notes);
    diagnostics.push(...(await checkScenarios(root, diagnosable, mcp, notes)));
    if (mcp) {
      const listed = await (options.listMcpTools ?? listReachableMcpTools)(agent);
      diagnostics.push(...diagnoseMcpToolsStale({ agentId: agent.id, snapshot: mcp, listed }));
    }
  }
  const environment = await checkConfiguration({
    projectRoot: root,
    agent,
    agentId: AGENT_ID,
    ...(options.env ? { env: options.env } : {}),
    loginKey: options.loginKey ?? null,
  });
  diagnostics.push(...environment.diagnostics);
  const voices = await diagnoseVoices({
    uses: (environment.uses ?? []).map((use) => ({ where: use.where, tts: use.settings.tts })),
    env: projectEnvironment(root, options.env ?? process.env),
    agentId: AGENT_ID,
    agentSource: "src/agent/agent.tsx",
    ...(options.findVoice ? { find: options.findVoice } : {}),
  });
  diagnostics.push(...voices.diagnostics);
  return {
    diagnostics: mergeAuthoringDiagnostics(diagnostics),
    typeCheck,
    typeCheckMs,
    configuration: environment.configuration,
    notes: [...notes, ...voices.notes],
  };
}

/** The project's `mcp.tools.json`, or null when it has none; a file that cannot be read is a note. */
function readProjectMcpSnapshot(root: string, notes: string[]): McpToolsSnapshot | null {
  const file = join(root, MCP_TOOLS_FILE);
  if (!existsSync(file)) return null;
  const read = readMcpToolsSnapshot(readFileSync(file, "utf8"));
  if ("snapshot" in read) return read.snapshot;
  notes.push(`${read.problem}; it was not compared with the MCP servers. Run \`npx curb mcp snapshot\` to write it again.`);
  return null;
}

/** SCENARIO_* for every scenario of the project. A file that does not load is a note: `curb test`
 * reports why. */
async function checkScenarios(
  root: string,
  agent: DiagnosableAgent,
  mcp: McpToolsSnapshot | null,
  notes: string[],
): Promise<AuthoringDiagnostic[]> {
  const { findScenarioFiles, loadScenarios } = await import("./test.js");
  const files = findScenarioFiles(root);
  if (files.length === 0) return [];
  const scenarios: CheckedScenario[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const loaded of await loadScenarios(root, file)) {
      if ("error" in loaded) notes.push(`Scenario ${JSON.stringify(loaded.name)} was not checked: ${loaded.error}`);
      else scenarios.push({ file, name: loaded.name, scenario: loaded.scenario, source });
    }
  }
  const inventory = agentToolInventory(agent);
  // An agent that does not render has its error already; its tools are not all known.
  if (!inventory.rendered) return [];
  return diagnoseScenarios({
    agentId: agent.id,
    routes: agent.routes,
    tools: inventory.tools,
    mcpServers: inventory.mcpServers,
    writtenTools: agent.writtenTools ?? [],
    mcpTools: mcp ? snapshotToolNames(mcp) : null,
    scenarios,
  });
}

/** The project's own TypeScript under `dir`, without its scenarios and tests. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourceFiles(path);
    return /\.(?:ts|tsx|mts)$/.test(entry.name) && !/\.(?:scenario|test|spec)\.[mc]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** How long `curb check` waits for the agent's MCP servers to list their tools, at most. */
const MCP_LIST_TIMEOUT_MS = 10_000;

/**
 * What each MCP server of the agent lists now, by server id: those `defineAgent({ mcpServers })`
 * declares and each `<Mcp url>` the diagnostic render registered. A server that does not answer
 * in time, fails, or needs a sign-in is left out: it is not compared. Every server is
 * disconnected afterwards, so the check exits.
 */
export async function listReachableMcpTools(agent: DiscoveredAgent): Promise<Record<string, McpToolInfo[]>> {
  const manager = getMcpManager();
  for (const server of (agent.definition.mcpServers ?? []) as McpAnyServerConfig[]) {
    if (isRemoteConfig(server)) manager.ensureServer(server);
    else if (!manager.serverIds().includes(server.id)) {
      manager.configure([server]);
      void manager.connectServer(server.id);
    }
  }
  const ids = manager.serverIds();
  if (ids.length === 0) return {};
  const connecting = () => ids.some((id) => manager.resolve(id).status === "connecting");
  if (connecting()) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, MCP_LIST_TIMEOUT_MS);
      const stop = manager.onChange(() => {
        if (!connecting()) done();
      });
    });
  }
  const listed: Record<string, McpToolInfo[]> = {};
  for (const id of ids) {
    const state = manager.resolve(id);
    if (state.status === "ready") listed[id] = state.tools;
  }
  await Promise.all(ids.map((id) => manager.disconnectServer(id)));
  return listed;
}

/**
 * The report as `curb check` prints it. Returns the exit code: 1 when anything is an error. A
 * missing value in the Configuration block is not one: a hosted agent gets its values from the
 * platform.
 */
export function printCheckReport(report: CheckReport): number {
  const { diagnostics, typeCheck, typeCheckMs, configuration, notes } = report;
  for (const diagnostic of diagnostics) {
    const output = `[agent:${diagnostic.location.agentId ?? AGENT_ID}] ${formatAuthoringDiagnostic(diagnostic)}`;
    if (diagnostic.severity === "error") console.error(output);
    else console.warn(output);
  }
  if (typeCheck.unlisted > 0) {
    console.error(
      `... and ${typeCheck.unlisted} more type error(s), not listed. Fix the ones above and run check again.`,
    );
  }
  if (typeCheck.checkedFiles > 0) {
    console.log(
      `Type-checked ${typeCheck.checkedFiles} file(s) under src/ in ${(typeCheckMs / 1000).toFixed(1)}s.`,
    );
  }
  for (const line of formatConfiguration(configuration)) console.log(line);
  for (const note of notes) console.log(note);
  const errors =
    diagnostics.filter((diagnostic) => diagnostic.severity === "error").length + typeCheck.unlisted;
  const warnings = diagnostics.length + typeCheck.unlisted - errors;
  console.log(
    errors + warnings === 0
      ? "No authoring diagnostics: the agent is clean."
      : `${errors} error(s), ${warnings} warning(s).`,
  );
  return errors > 0 ? 1 : 0;
}

function orchestrationIgnored(): AuthoringDiagnostic {
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.orchestrationIgnored,
    severity: "warning",
    message: "The framework runs the voice session on every route; these files are not used.",
    location: { agentId: AGENT_ID, source: "src/orchestration/" },
    fix: "Delete src/orchestration/ (voice settings go on <Agent>).",
  };
}
