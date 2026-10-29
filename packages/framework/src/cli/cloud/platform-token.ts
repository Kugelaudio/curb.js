import { readFileSync } from "node:fs";
import type { CloudAccess } from "./client.js";
import type { DeployTarget } from "./deploy.js";

/**
 * A platform token a host issued, instead of `curb login`'s session.
 *
 * A host that runs a Curb project for someone else (a hosted workspace) must not hand the
 * project the person's session: everything in the project can read it, and it carries
 * everything the person may do. It sets `CURB_PLATFORM_TOKEN_FILE` to a file it keeps
 * current with a short-lived token bound to one agent and one environment:
 *
 *   {"token", "expiresAt", "platformApiUrl", "tenantId", "projectId", "environmentId"}
 *
 * `curb deploy` then deploys there with it, reading the file on every run, and never calls
 * the web app. `curb login` and `curb secrets push` are refused: neither has a meaning for a
 * token the host owns.
 */

export const PLATFORM_TOKEN_FILE_ENV = "CURB_PLATFORM_TOKEN_FILE";

/** One token, as the host wrote it. */
export interface PlatformToken {
  token: string;
  expiresAt: Date;
  platformApiUrl: string;
  tenantId: string;
  projectId: string;
  environmentId: string;
}

const FIELDS = ["token", "expiresAt", "platformApiUrl", "tenantId", "projectId", "environmentId"] as const;

/** The token file `env` names, or null when none is named. Throws on a file that cannot be used. */
export function readPlatformToken(env: NodeJS.ProcessEnv, now: Date = new Date()): PlatformToken | null {
  const path = env[PLATFORM_TOKEN_FILE_ENV];
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `${PLATFORM_TOKEN_FILE_ENV} names ${path}, which cannot be read (${error instanceof Error ? error.message : String(error)}). ` +
        "The host writes it; if it was just started, try again in a moment.",
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} (${PLATFORM_TOKEN_FILE_ENV}) is not JSON.`);
  }
  for (const field of FIELDS) {
    if (typeof parsed[field] !== "string" || parsed[field] === "") {
      throw new Error(`${path} (${PLATFORM_TOKEN_FILE_ENV}) has no "${field}".`);
    }
  }
  const token = {
    token: parsed.token as string,
    expiresAt: new Date(parsed.expiresAt as string),
    platformApiUrl: (parsed.platformApiUrl as string).replace(/\/+$/, ""),
    tenantId: parsed.tenantId as string,
    projectId: parsed.projectId as string,
    environmentId: parsed.environmentId as string,
  };
  if (Number.isNaN(token.expiresAt.getTime())) {
    throw new Error(`${path} (${PLATFORM_TOKEN_FILE_ENV}) has an "expiresAt" that is not a time.`);
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    throw new Error(
      `The platform token in ${path} expired at ${token.expiresAt.toISOString()}. ` +
        "The host renews it on its own; try again in a minute.",
    );
  }
  return token;
}

/** The client access and deploy target a platform token gives. */
export function platformTokenTarget(token: PlatformToken): { access: CloudAccess; target: DeployTarget } {
  return {
    access: {
      webUrl: "",
      platformApiUrl: token.platformApiUrl,
      accessToken: token.token,
      unauthorized:
        "The platform refused this environment's token: it expired, was revoked, or the environment stopped. " +
        "The host renews it on its own; try again in a minute.",
    },
    target: { orgId: token.tenantId, platformProjectId: token.projectId, environmentId: token.environmentId },
  };
}

/** Refuses a command that has no meaning under a host's platform token. */
export function refuseUnderPlatformToken(env: NodeJS.ProcessEnv, command: string, instead: string): void {
  if (env[PLATFORM_TOKEN_FILE_ENV]) {
    throw new Error(
      `\`curb ${command}\` is not available here: this environment deploys with a platform token its host ` +
        `issues (${PLATFORM_TOKEN_FILE_ENV}). ${instead}`,
    );
  }
}
