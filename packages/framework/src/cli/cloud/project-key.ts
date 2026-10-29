import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { LoginResult } from "./auth.js";
import { projectKeysPath, readProjectKeys, type StoredProjectKey, storeProjectKey } from "./credentials.js";
import { readLink, writeLink } from "./link.js";

/**
 * How a Curb project runs on `curb login`. In a Curb project the browser sign-in creates a
 * project API key; the CLI keeps it in its own store beside credentials.json
 * (`project-keys.json`, mode 0600) and links the project to the KugelAudio project the key
 * belongs to (`.curb/link.json`, when there is no link yet). Every curb command started in the
 * project then gets it from `useLoginKey`. The key is never written into the project or
 * printed. A KUGELAUDIO_API_KEY set in `.env` or the environment is the alternative, and wins.
 */

export const PROJECT_KEY_VARIABLE = "KUGELAUDIO_API_KEY";

function dependsOnCurb(manifest: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    throw new Error(`${manifest} is not valid JSON. Fix it, then run \`npx curb login\` again.`);
  }
  const { dependencies, devDependencies } = (parsed ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return Object.hasOwn(dependencies ?? {}, "curb") || Object.hasOwn(devDependencies ?? {}, "curb");
}

/** The Curb project around `start`: the nearest directory up whose package.json depends on curb; null outside one. */
export function findCurbProject(start: string): string | null {
  let directory = resolve(start);
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && dependsOnCurb(manifest)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Whether the project's `.env` sets a non-empty KUGELAUDIO_API_KEY, read the way `curb dev` loads it. */
export function envHasProjectKey(root: string): boolean {
  const path = join(root, ".env");
  if (!existsSync(path)) return false;
  return (parseEnv(readFileSync(path, "utf8"))[PROJECT_KEY_VARIABLE] ?? "") !== "";
}

/**
 * After the browser sign-in: in a Curb project that asked for a key, the key goes into the
 * CLI's store and the project into `.curb/link.json` (when no link exists yet). Returns the
 * lines to print, the last one saying who is signed in and what the project runs on.
 */
export function finishLogin(
  root: string | null,
  askedForKey: boolean,
  { credentials, projectKey }: LoginResult,
  keysPath: string = projectKeysPath(),
): string[] {
  const who = credentials.user?.email ?? credentials.user?.id ?? "unknown user";
  const signedIn = `Signed in as ${who} (${credentials.webUrl})`;
  if (root === null) {
    return [`${signedIn}. Run \`npx curb login\` in a Curb project to run it on your login.`];
  }
  if (!askedForKey) {
    return [
      `${signedIn}. .env sets ${PROJECT_KEY_VARIABLE}, so this project runs on that key, not on your login ` +
        "(remove the line and run `npx curb login` again to use your login).",
    ];
  }
  if (!projectKey) {
    return [
      `${signedIn}, but no API key came with the sign-in (this KugelAudio server does not issue one yet, or you manage ` +
        "API keys in no project), so this project cannot run on your login yet. Run `npx curb login` again later.",
    ];
  }
  const link = readLink(root);
  storeProjectKey({ ...projectKey, webUrl: credentials.webUrl, email: who }, keysPath);
  const project = `${projectKey.orgName} / ${projectKey.projectName}`;
  if (link === null) {
    writeLink(root, { webUrl: credentials.webUrl, orgId: projectKey.orgId, projectId: projectKey.projectId });
  } else if (link.projectId !== projectKey.projectId) {
    return [
      `Signed in as ${who} for ${project}, but .curb/link.json links this project to another KugelAudio project, ` +
        "so it does not run on that login. Delete .curb/link.json and run `npx curb login` again to switch.",
    ];
  }
  return [`Signed in as ${who} for ${project}. This project runs on your login; there is no key to copy.`];
}

/**
 * The one place a Curb project gets its KugelAudio key from `curb login`, called once when a
 * curb command starts, after `.env` loads. When neither the environment nor `.env` sets
 * KUGELAUDIO_API_KEY and `.curb/link.json` names a project the login stored a key for, it sets
 * the variable in `env` (this process; the processes it starts inherit it). Nothing is written.
 * Returns the stored key it used, or null.
 */
export function useLoginKey(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  keysPath: string = projectKeysPath(),
): StoredProjectKey | null {
  if (env[PROJECT_KEY_VARIABLE]?.trim()) return null;
  const link = readLink(root);
  const stored = link ? readProjectKeys(keysPath)[link.projectId] : undefined;
  if (!stored) return null;
  env[PROJECT_KEY_VARIABLE] = stored.apiKey;
  return stored;
}
