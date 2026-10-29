import { readFileSync } from "node:fs";
import { PLATFORM_TOKEN_FILE_ENV } from "./platform-token.js";
import { PROJECT_KEY_VARIABLE } from "./project-key.js";

/**
 * The model key a host supplies, beside its platform token. A host that runs a Curb project
 * for someone (a hosted workspace) writes `kugelaudioApiKey`, and `kugelaudioApiBase` when it
 * names one, into the file `CURB_PLATFORM_TOKEN_FILE` names, and renews the file before the
 * key expires. With no KUGELAUDIO_API_KEY in the environment or `.env`, every curb command
 * then runs on that key, and re-reads the file as the host renews it, so a long `curb dev`
 * never holds an expired key. A key the user sets always wins. Nothing is written or printed.
 */

/** Marks an environment whose KUGELAUDIO_API_KEY (and base) came from the host's file. */
export const HOST_KEY_MARKER = "CURB_HOST_MODEL_KEY";
const BASE_VARIABLE = "KUGELAUDIO_API_BASE";

/** How often a running process re-reads the host's file. */
export const HOST_KEY_REFRESH_MS = 30_000;

export type HostModelKey =
  /** No host file, or a host that supplies no model key. */
  | { kind: "none" }
  /** The host names a file it has not written yet (the workspace is still starting). */
  | { kind: "pending"; path: string }
  | { kind: "key"; apiKey: string; apiBase: string | null };

/** The model key the host's file holds. Throws on a file that exists and cannot be used. */
export function readHostModelKey(env: NodeJS.ProcessEnv): HostModelKey {
  const path = env[PLATFORM_TOKEN_FILE_ENV];
  if (!path) return { kind: "none" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "pending", path };
    throw new Error(
      `${PLATFORM_TOKEN_FILE_ENV} names ${path}, which cannot be read ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} (${PLATFORM_TOKEN_FILE_ENV}) is not JSON.`);
  }
  const apiKey = typeof parsed.kugelaudioApiKey === "string" ? parsed.kugelaudioApiKey.trim() : "";
  if (!apiKey) return { kind: "none" };
  const base = typeof parsed.kugelaudioApiBase === "string" ? parsed.kugelaudioApiBase.trim() : "";
  return { kind: "key", apiKey, apiBase: base || null };
}

/** Whether `env`'s model key is the host's (set by `useHostModelKey`), not the user's. */
export function runsOnHostKey(env: NodeJS.ProcessEnv): boolean {
  return env[HOST_KEY_MARKER] === "1";
}

/**
 * Called once a command has loaded `.env`: when neither the environment nor `.env` sets
 * KUGELAUDIO_API_KEY, or the key there is the host's own, sets it (and KUGELAUDIO_API_BASE,
 * unless the user set one) from the host's file. Returns what the host supplied.
 */
export function useHostModelKey(env: NodeJS.ProcessEnv = process.env): HostModelKey {
  if (env[PROJECT_KEY_VARIABLE]?.trim() && !runsOnHostKey(env)) return { kind: "none" };
  const supplied = readHostModelKey(env);
  if (supplied.kind !== "key") return supplied;
  const ownBase = Boolean(env[BASE_VARIABLE]?.trim()) && !runsOnHostKey(env);
  env[PROJECT_KEY_VARIABLE] = supplied.apiKey;
  if (!ownBase) {
    if (supplied.apiBase) env[BASE_VARIABLE] = supplied.apiBase;
    else delete env[BASE_VARIABLE];
  }
  env[HOST_KEY_MARKER] = "1";
  return supplied;
}

/**
 * Keeps a long-running process on the host's current key: re-reads the file every
 * HOST_KEY_REFRESH_MS while the process runs on the host's key or still waits for it.
 * Providers read the environment when a session starts, so the next call gets the renewed
 * key. A file that turns unusable is reported once per distinct cause, and the last key
 * stays until it expires. The timer never keeps the process alive.
 */
export function keepHostModelKeyFresh(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(`[curb] ${message}\n`),
): () => void {
  if (!env[PLATFORM_TOKEN_FILE_ENV]) return () => {};
  let lastProblem = "";
  const timer = setInterval(() => {
    if (env[PROJECT_KEY_VARIABLE]?.trim() && !runsOnHostKey(env)) return;
    try {
      useHostModelKey(env);
      lastProblem = "";
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      if (problem !== lastProblem) warn(`the workspace's model key was not renewed: ${problem}`);
      lastProblem = problem;
    }
  }, HOST_KEY_REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}
