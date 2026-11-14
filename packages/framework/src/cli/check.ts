import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { agentLoadFailure, discoverAgent, type DiscoveredAgent } from "../agent.node.js";
import { diagnoseAgentAuthoring } from "../authoring-diagnostics.js";
import {
  AUTHORING_DIAGNOSTIC_CODES,
  formatAuthoringDiagnostic,
  mergeAuthoringDiagnostics,
  type AuthoringDiagnostic,
} from "../authoring.js";
import { resolveAgentDir } from "../project.node.js";
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
  if (agent) {
    diagnostics.push(
      ...diagnoseAgentAuthoring({
        id: agent.id,
        definition: agent.definition,
        routes: agent.routes,
        source: agent.source,
        projectRoot: root,
        homeSkill: agent.homeSkill,
      }),
    );
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
    notes: voices.notes,
  };
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
