import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  credentialsPath,
  type Credentials,
  DEFAULT_WEB_URL,
  deleteCredentials,
  deleteProjectKeys,
  projectKeysPath,
  readCredentials,
  revokeSession,
  writeCredentials,
} from "./credentials.js";
import { requestJson } from "./http.js";

/**
 * `curb login`: a browser sign-in handed back to a loopback server.
 *
 * The CLI listens on 127.0.0.1:<random port>, opens `<web>/cli/login` with a random
 * `state` and a PKCE S256 challenge, and waits for the browser to redirect to
 * `/callback?code&state`. The code alone is useless: the token exchange also needs the
 * verifier, which never left this process.
 *
 * With `project_key=1` the sign-in page also lets the person choose the KugelAudio project
 * a new API key is created in, and the exchange answers with that key (`api_key` and where
 * it lives). The CLI asks for one only in a Curb project, and keeps it in its own store
 * (`project-keys.json`, see credentials.ts), never in the project.
 */

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface LoginOptions {
  webUrl: string;
  /** Opens the sign-in page; tests drive the browser side through it. */
  open: (url: string) => void;
  log?: (line: string) => void;
  timeoutMs?: number;
  path?: string;
  /** Ask for a project API key: this login is run in a Curb project, which will run on it. */
  requestProjectKey?: boolean;
  /** This computer's name, which the web gives the API key ("Curb CLI on <device>"). */
  deviceName?: string;
}

/** The project API key a login created, and the KugelAudio project it belongs to, by public id. */
export interface ProjectKey {
  apiKey: string;
  keyId: number;
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
}

export interface LoginResult {
  credentials: Credentials;
  /** Null when none was asked for, or the web does not issue one (an older web, no project the person manages). */
  projectKey: ProjectKey | null;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
  platformApiUrl: string;
  webUrl?: string;
  user: { id: string; email: string };
  api_key?: string;
  key_id?: number;
  org_id?: string;
  org_name?: string;
  project_id?: string;
  project_name?: string;
}

const filled = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The key in the answer; null when it has none. A key without where it lives is a contract mismatch. */
function readProjectKey(body: TokenResponse, webUrl: string): ProjectKey | null {
  const { api_key, key_id, org_id, org_name, project_id, project_name } = body;
  if (api_key === undefined) return null;
  if (filled(api_key) && typeof key_id === "number" && filled(org_id) && filled(org_name) && filled(project_id) && filled(project_name)) {
    return { apiKey: api_key, keyId: key_id, orgId: org_id, orgName: org_name, projectId: project_id, projectName: project_name };
  }
  const missing = Object.entries({ api_key, key_id, org_id, org_name, project_id, project_name })
    .filter(([field, value]) => (field === "key_id" ? typeof value !== "number" : !filled(value)))
    .map(([field]) => field);
  throw new Error(`${webUrl}/api/cli/token answered an API key without ${missing.join(", ")}; the server and this CLI disagree on the login contract.`);
}

export function normalizeWebUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--url "${raw}" is not a URL. Example: --url ${DEFAULT_WEB_URL}`);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`--url must be https (got ${url.origin}); plain http is accepted only for localhost.`);
  }
  return url.origin;
}

/** Signs in through the browser and stores the credentials. The caller says what was signed in to. */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const webUrl = normalizeWebUrl(options.webUrl);
  const state = randomBytes(16).toString("base64url");
  const pkce = createPkce();

  const callback = await listenForCallback(state, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const signIn = new URL("/cli/login", webUrl);
    signIn.searchParams.set("port", String(callback.port));
    signIn.searchParams.set("state", state);
    signIn.searchParams.set("code_challenge", pkce.challenge);
    if (options.deviceName) signIn.searchParams.set("device_name", options.deviceName);
    if (options.requestProjectKey) signIn.searchParams.set("project_key", "1");
    log(`Opening ${signIn.href}`);
    log("If no browser opens, paste that URL into one. Waiting up to 5 minutes...");
    options.open(signIn.href);

    const code = await callback.code;
    const { body } = await requestJson<TokenResponse>({
      method: "POST",
      url: new URL("/api/cli/token", webUrl).href,
      body: { code, code_verifier: pkce.verifier },
      webUrl,
    });
    const missing = (["accessToken", "refreshToken", "expiresAt", "supabaseUrl", "supabaseAnonKey", "platformApiUrl"] as const)
      .filter((field) => body[field] === undefined || body[field] === "");
    if (missing.length > 0) {
      throw new Error(`${webUrl}/api/cli/token answered without ${missing.join(", ")}; the server and this CLI disagree on the login contract.`);
    }
    const projectKey = readProjectKey(body, webUrl);
    const credentials: Credentials = {
      // The server names its canonical URL; links printed later (the playground) use it.
      webUrl: body.webUrl ? normalizeWebUrl(body.webUrl) : webUrl,
      platformApiUrl: body.platformApiUrl.replace(/\/$/, ""),
      supabaseUrl: body.supabaseUrl,
      supabaseAnonKey: body.supabaseAnonKey,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt,
      user: body.user,
    };
    const path = options.path ?? credentialsPath();
    writeCredentials(credentials, path);
    return { credentials, projectKey };
  } finally {
    callback.close();
  }
}

interface Callback {
  port: number;
  code: Promise<string>;
  close: () => void;
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;

/** Starts the loopback listener; `code` settles on the first valid callback, a cancel, or the timeout. */
async function listenForCallback(state: string, timeoutMs: number): Promise<Callback> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller awaits `code` only after printing the URL; this keeps an early rejection
  // from being reported as unhandled in between.
  code.catch(() => {});

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const send = (status: number, title: string, text: string) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      response.end(PAGE(title, text));
    };
    // A callback with the wrong state is not ours (another tab, a forged link): refuse it
    // and keep waiting for the real one rather than failing the login.
    if (url.searchParams.get("state") !== state) {
      send(400, "Sign-in link mismatch", "This sign-in does not belong to the running curb login. Start it again from the terminal.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      send(200, "Sign-in cancelled", "You can close this tab.");
      settle.reject(new Error(error === "access_denied" ? "Sign-in was cancelled in the browser." : `Sign-in failed: ${error}.`));
      return;
    }
    const value = url.searchParams.get("code");
    if (!value) {
      send(400, "Sign-in incomplete", "The browser came back without a code. Run curb login again.");
      settle.reject(new Error("The browser came back without a sign-in code. Run `npx curb login` again."));
      return;
    }
    send(200, "Signed in to KugelAudio", "You can close this tab and return to the terminal.");
    settle.resolve(value);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const timer = setTimeout(
    () => settle.reject(new Error("Timed out after 5 minutes waiting for the browser sign-in. Run `npx curb login` again.")),
    timeoutMs,
  );
  return {
    port: (server.address() as AddressInfo).port,
    code,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The web URL `curb login` targets: --url, else the one stored with the last login, else production. */
export function loginWebUrl(flag: string | undefined, path: string = credentialsPath()): string {
  if (flag) return flag;
  try {
    return readCredentials(path)?.webUrl ?? DEFAULT_WEB_URL;
  } catch {
    // KEEP-JUSTIFIED: an unreadable credentials file is exactly what a fresh login replaces.
    return DEFAULT_WEB_URL;
  }
}

/**
 * `curb logout`: revoke this machine's session and delete the stored credentials and project
 * keys. The keys themselves stay valid until revoked on the dashboard's API keys page.
 */
export async function logout(options: { path?: string; log?: (line: string) => void } = {}): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const path = options.path ?? credentialsPath();
  let credentials: Credentials | null = null;
  try {
    credentials = readCredentials(path);
  } catch (error) {
    log(`Stored credentials were unreadable (${error instanceof Error ? error.message : String(error)}); deleting them.`);
  }
  if (credentials) {
    try {
      await revokeSession(credentials);
    } catch (error) {
      log(
        `Warning: could not revoke the session at ${credentials.supabaseUrl} ` +
          `(${error instanceof Error ? error.message : String(error)}); it expires on its own.`,
      );
    }
  }
  const keysPath = projectKeysPath(path);
  const removed = [deleteCredentials(path) ? path : null, deleteProjectKeys(keysPath) ? keysPath : null].filter(
    (file): file is string => file !== null,
  );
  if (removed.length === 0) {
    log("Not signed in; nothing to remove.");
    return;
  }
  log(`Signed out. Removed ${removed.join(" and ")}.`);
  if (removed.includes(keysPath)) log("The project keys your logins created stay revocable on the API keys page of the KugelAudio dashboard.");
}
