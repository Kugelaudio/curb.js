import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The LiveKit agent name a voice worker registers under, which room and SIP dispatch target.
 *
 * One rule for both workers: `curb start` reads the project's package name when it starts,
 * and `curb build` bakes the same name into the artifact, so a project registers under the
 * same name however it is run. Light on purpose (no LiveKit import): `curb build` and the
 * CLI read it without loading the voice host.
 */

export const AGENT_NAME_VAR = "CURB_AGENT_NAME";
const DEFAULT_AGENT_NAME = "curb-agent";

/**
 * `CURB_AGENT_NAME`, else the project's package name (what a scaffolded project's worker
 * used to export), else `curb-agent`. A blank value counts as unset: an empty name would
 * make LiveKit dispatch the worker into every room of the project.
 */
export function voiceWorkerAgentName(
  env: NodeJS.ProcessEnv = process.env,
  projectName?: string,
): string {
  return env[AGENT_NAME_VAR]?.trim() || projectName?.trim() || DEFAULT_AGENT_NAME;
}

/** The project's package.json `name`; undefined when there is no package.json or no name. */
export function readProjectPackageName(projectRoot: string): string | undefined {
  const manifestPath = join(projectRoot, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${manifestPath} is not valid JSON, so the worker has no name to register: ${detail}`);
  }
  const name = (manifest as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}
