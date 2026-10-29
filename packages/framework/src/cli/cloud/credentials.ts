import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CloudError } from "./http.js";

/**
 * The signed-in KugelAudio account, stored by `curb login` at
 * `$XDG_CONFIG_HOME/curb/credentials.json` (default `~/.config/curb/`), mode 0600.
 * It is the token-exchange answer of `POST <web>/api/cli/token` plus the web URL it came from.
 */
export interface Credentials {
  webUrl: string;
  platformApiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  user: { id: string; email: string };
}

export const DEFAULT_WEB_URL = "https://www.kugelaudio.com";

/** Refresh this many seconds before the token would expire, so a slow request does not race it. */
const REFRESH_MARGIN_SECONDS = 60;

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
    ? env.XDG_CONFIG_HOME
    : join(homedir(), ".config");
  return join(configHome, "curb", "credentials.json");
}

const REQUIRED_FIELDS = [
  "webUrl",
  "platformApiUrl",
  "supabaseUrl",
  "supabaseAnonKey",
  "accessToken",
  "refreshToken",
  "expiresAt",
] as const;

/** The stored credentials, or null when nobody is signed in on this machine. */
export function readCredentials(path: string = credentialsPath()): Credentials | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON. Delete it (or run \`npx curb logout\`) and run \`npx curb login\`.`);
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((field) => record[field] === undefined || record[field] === "");
  if (missing.length > 0) {
    throw new Error(`${path} is missing ${missing.join(", ")}. Run \`npx curb login\` again.`);
  }
  return record as unknown as Credentials;
}

export function writeCredentials(credentials: Credentials, path: string = credentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync applies `mode` only when it creates the file; an existing file keeps
  // whatever it had, so tighten it explicitly.
  chmodSync(path, 0o600);
}

/** Removes the stored credentials. Returns false when there were none. */
export function deleteCredentials(path: string = credentialsPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * A project API key `curb login` created, kept beside credentials.json in `project-keys.json`
 * (mode 0600), keyed by the KugelAudio project id. A Curb project linked to that project runs
 * on it (`useLoginKey`), so no key is written into the project. `curb logout` removes it; the
 * key stays listed and revocable on the dashboard's API keys page.
 */
export interface StoredProjectKey {
  apiKey: string;
  keyId: number;
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  webUrl: string;
  /** Who signed in when the key was created. */
  email: string;
}

const PROJECT_KEY_FIELDS = ["apiKey", "keyId", "orgId", "orgName", "projectId", "projectName", "webUrl", "email"] as const;

/** `project-keys.json` in the directory of the credentials file at `credentials`. */
export function projectKeysPath(credentials: string = credentialsPath()): string {
  return join(dirname(credentials), "project-keys.json");
}

/** The stored project keys by project id; empty when there are none. */
export function readProjectKeys(path: string = projectKeysPath()): Record<string, StoredProjectKey> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON. Run \`npx curb logout\`, then \`npx curb login\`.`);
  }
  const keys = (parsed ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const [projectId, entry] of Object.entries(keys)) {
    const missing = PROJECT_KEY_FIELDS.filter((field) => entry?.[field] === undefined || entry[field] === "");
    if (missing.length > 0) {
      throw new Error(`${path} is missing ${missing.join(", ")} for ${projectId}. Run \`npx curb logout\`, then \`npx curb login\`.`);
    }
  }
  return keys as unknown as Record<string, StoredProjectKey>;
}

/** Stores a project's key, replacing the one stored for that project before. */
export function storeProjectKey(key: StoredProjectKey, path: string = projectKeysPath()): void {
  const keys = { ...readProjectKeys(path), [key.projectId]: key };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Removes every stored project key. Returns false when there were none. */
export function deleteProjectKeys(path: string = projectKeysPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}

/** Exchanges the refresh token for a fresh session through Supabase Auth. */
export async function refreshCredentials(
  credentials: Credentials,
  now: () => number = () => Date.now() / 1000,
): Promise<Credentials> {
  const url = `${credentials.supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { apikey: credentials.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: credentials.refreshToken }),
    });
  } catch (cause) {
    throw new CloudError(
      `Could not reach ${new URL(url).origin} to refresh your session: ${cause instanceof Error ? cause.message : String(cause)}`,
      0,
      undefined,
    );
  }
  if (!response.ok) {
    throw new CloudError(
      `Your KugelAudio session could not be refreshed (HTTP ${response.status}). Run \`npx curb login\`.`,
      response.status,
      undefined,
    );
  }
  const body = (await response.json()) as SupabaseTokenResponse;
  if (!body.access_token || !body.refresh_token) {
    throw new CloudError("Supabase answered the refresh without a token. Run `npx curb login`.", response.status, undefined);
  }
  const expiresAt = body.expires_at ?? Math.floor(now()) + (body.expires_in ?? 3600);
  return { ...credentials, accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt };
}

/**
 * The signed-in credentials with a usable access token: refreshed (and saved) when it is
 * about to expire. Throws a "run curb login" error when nobody is signed in.
 */
export async function ensureCredentials(
  path: string = credentialsPath(),
  now: () => number = () => Date.now() / 1000,
): Promise<Credentials> {
  const stored = readCredentials(path);
  if (!stored) {
    throw new Error("You are not signed in to KugelAudio. Run `npx curb login` first.");
  }
  if (stored.expiresAt - REFRESH_MARGIN_SECONDS > now()) return stored;
  const refreshed = await refreshCredentials(stored, now);
  writeCredentials(refreshed, path);
  return refreshed;
}

/**
 * Revokes this machine's session at Supabase (scope=local: other devices stay signed in).
 * Throws on failure so the caller can say the server-side session may still be valid.
 */
export async function revokeSession(credentials: Credentials): Promise<void> {
  const url = `${credentials.supabaseUrl.replace(/\/$/, "")}/auth/v1/logout?scope=local`;
  const response = await fetch(url, {
    method: "POST",
    headers: { apikey: credentials.supabaseAnonKey, Authorization: `Bearer ${credentials.accessToken}` },
  });
  // 401/403: the session is already gone (expired or revoked), which is what logout wants.
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    throw new CloudError(`Supabase refused the logout with HTTP ${response.status}.`, response.status, undefined);
  }
}
