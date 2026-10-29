/**
 * The page's side of Curb's browser dev environment, which needs no server: `curb dev`'s
 * supervisor and forwarder (`cli/dev.ts`) in the page, with the agent server in a Web Worker
 * instead of a child process, and the project itself kept here, in IndexedDB. Loaded before
 * the preview app (the static build puts it first in `index.html`), it routes the preview's
 * traffic to the agent: every same-origin WebSocket but Vite's HMR and every request on the
 * agent's paths (`AGENT_HTTP_PATHS`) go to the worker that serves, wait while one starts, and
 * get the reason while none can run. The preview's context markdown comes from the project's
 * `context/`. The preview itself is unchanged.
 *
 * The project starts as the template the build ships (`curb-browser/template.json`) and is
 * changed through `window.curb.project` (write, remove, install), which is what an editor or a
 * coding agent in the page calls. Reloads are `AgentServerSupervisor`'s, as in `curb dev`: a
 * change that counts (`changesAgent`) waits for the reply or the call, stops the worker (which
 * tells the preview, with the conversation to come back to), and starts a new one on the
 * project as it is then. The conversation journal the workers write (`builtins/memory-fs.ts`)
 * is kept in IndexedDB too, so a reload of the agent or of the tab continues it.
 *
 * Opened from a link the KugelAudio platform issued (`#project=&token=&api=`), the page also
 * connects to the platform (`relay.ts`) and answers the coding agent's tool calls on this
 * project (`tools.ts`). The project is then the platform's (`project-sync.ts`): the page loads
 * the platform's copy on every connect, before the agent starts, and saves each change there
 * before applying it, so it is the same project in any browser. IndexedDB (a database per
 * project) is only the working copy, and the home of what never leaves the tab: installed
 * packages, `.env` and the conversations.
 *
 * Served with sessions (`session.ts`), the page at `<prefix><id>` is one project's session:
 * it keeps that session's link, the preview's routes live under the session path, and without
 * a link, or once the platform refuses it, the page goes to the host's sign-in for a new one.
 */

import { AgentServerSupervisor, type AgentProcess } from "../cli/dev-supervisor.js";
import type { ChildMessage } from "../cli/dev-ipc.js";
import { changesAgent } from "../cli/dev-watch.js";
import type { AgentTarget } from "../cli/dev-proxy.js";
import type { AuthoringDiagnostic } from "../authoring.js";
import { isAgentHttpPath } from "../server/agent-http-paths.js";
import { VITE_HMR_PATH } from "../server/hmr-path.js";
import { serializeServerMessage } from "../server/protocol.js";
import type { ForwardedResponse } from "./builtins/virtual-http.js";
import { AgentTurns, toolDiagnostic } from "./agent-turns.js";
import { PagePortSocket } from "./call-port.js";
import { npmInstall, npmRestore, type ProjectChange } from "./npm-install.js";
import { askForSecret, showRelayState } from "./page-ui.js";
import { binaryFilesOf, platformCopyChange, savedPart, seedSave, type PlatformFile } from "./project-sync.js";
import { currentLink, forgetLink, Relay } from "./relay.js";
import { sessionOf, sessionSettings, signedIn, signInFor } from "./session.js";
import { browserTools, type AgentState, type Reload, type ToolHost } from "./tools.js";
import type { DiagnosticsAnswer, FromWorker, ToWorker, WorkerBoot } from "./worker-protocol.js";

const WORKER_URL = "/curb-browser/worker.js";
/**
 * The page holds no key: a relay adds it on the way out. That is the platform's when the page
 * was opened from its link (`ready.model.base`, `relay.ts`), else the static host's `/kugel`.
 */
const WORKER_ENV: Record<string, string> = {
  KUGELAUDIO_API_KEY: "added-by-the-relay",
  KUGELAUDIO_API_BASE: `${location.origin}/kugel`,
  KUGEL_CONVERSATIONS_DB: "/curb/conversations.jsonl",
};

const NativeWebSocket = window.WebSocket;
const sessions = sessionSettings(document);
/** The session this page is, `/agents/session/<id>`; null for the plain dev page. */
const session = sessions ? sessionOf(location.pathname, sessions.prefix) : null;
// The preview's routes (`preview-route.ts`) live under the session path.
if (session) document.documentElement.dataset.curbBase = session;
/** The platform link this page was opened from (or kept), null for a plain dev page. */
const link = currentLink(location, localStorage, session ?? "/", history);

/**
 * Off to the host's sign-in for a fresh link to this session; false when it already sent the
 * person there a moment ago (the link it gave was refused too) or the build has no sign-in.
 */
function signIn(): boolean {
  const url = sessions && session ? signInFor(sessions, session, sessionStorage) : null;
  if (!url) return false;
  location.replace(url);
  return true;
}

// A session page without a link has nothing to run: it signs in, and the page stops here.
if (session && !link) {
  if (!signIn()) showRelayState({ kind: "refused" }, sessions?.signIn ? "signInFailed" : "noLink");
  await new Promise<never>(() => {});
}
const DATABASE = link ? `curb-browser:${link.project}` : "curb-browser";
/** The worker's `.env`: the project's values under the page's own (`WORKER_ENV` wins). */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of (project.files.get(".env") ?? "").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    env[match[1]!] = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
  }
  return { ...env, ...WORKER_ENV };
}
const nativeFetch = window.fetch.bind(window);

/** Files by path, kept in one IndexedDB object store, written behind each change. */
class BrowserStore {
  private static database: Promise<IDBDatabase> | null = null;
  readonly files = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private flush: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: "project" | "volume") {}

  private static open(): Promise<IDBDatabase> {
    BrowserStore.database ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DATABASE, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("project");
        open.result.createObjectStore("volume");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error(`IndexedDB did not open: ${open.error?.message ?? "unknown error"}`));
    });
    return BrowserStore.database;
  }

  /** Every saved file, into `files`. */
  async load(): Promise<void> {
    const store = (await BrowserStore.open()).transaction(this.store, "readonly").objectStore(this.store);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    keys.forEach((key, index) => this.files.set(String(key), String(values[index])));
  }

  set(path: string, text: string): void {
    this.files.set(path, text);
    this.changed(path);
  }

  delete(path: string): void {
    this.files.delete(path);
    this.changed(path);
  }

  private changed(path: string): void {
    this.dirty.add(path);
    this.flush ??= setTimeout(() => {
      this.flush = null;
      const paths = [...this.dirty];
      this.dirty.clear();
      void this.write(paths).catch((error: unknown) =>
        console.error(`[curb] ${paths.length} file(s) of the ${this.store} were not saved to IndexedDB: ${String(error)}`),
      );
    }, 50);
  }

  private async write(paths: string[]): Promise<void> {
    const transaction = (await BrowserStore.open()).transaction(this.store, "readwrite");
    const store = transaction.objectStore(this.store);
    for (const path of paths) {
      const text = this.files.get(path);
      if (text === undefined) store.delete(path);
      else store.put(text, path);
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

/** The project (`src/`, `context/`, `package.json`, `node_modules/`). */
const project = new BrowserStore("project");
/** The files the workers wrote: the conversation journal. */
const volume = new BrowserStore("volume");

/** The last lines the agent, its supervisor and npm logged, for `get_log`. */
const LOG_LINES = 2000;
const logLines: string[] = [];
let lastError: string | null = null;
function logLine(level: "info" | "warn" | "error", text: string): void {
  for (const line of text.split("\n")) logLines.push(`${new Date().toISOString().slice(11, 23)} ${level === "info" ? "" : `${level} `}${line}`);
  if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
  if (level === "error") lastError = text;
}

type Held = () => void;

/** `cli/dev-proxy.ts`'s `AgentForwarder`, between the preview and the workers. */
class PageForwarder {
  private target: AgentTarget = { kind: "hold" };
  private readonly held = new Set<Held>();
  /** Sockets told why no agent runs, closed for a reconnect once one does. */
  private readonly explained = new Set<MessagePort>();
  /** The preview's sockets by the worker (port) they went to, dropped if it dies. */
  private readonly sockets = new Map<number, Set<PagePortSocket>>();

  constructor(private readonly workers: Map<number, Worker>) {}

  setTarget(target: AgentTarget, files: readonly string[]): void {
    const previous = this.target;
    this.target = target;
    if (previous.kind === "unavailable" && target.kind !== "unavailable") {
      const frame = serializeServerMessage({ type: "dev_reload", state: "reloading", files: [...files] });
      for (const port of this.explained) {
        port.postMessage({ data: frame });
        port.postMessage({ close: { code: 1012, reason: "The agent is reloading." } });
      }
      this.explained.clear();
    }
    if (target.kind === "unavailable") {
      const frame = serializeServerMessage({ type: "agent_unavailable", ...target.unavailable });
      for (const port of this.explained) port.postMessage({ data: frame });
    }
    if (target.kind === "hold") return;
    const held = [...this.held];
    this.held.clear();
    for (const release of held) release();
  }

  /** The worker that serves now, if one does. */
  servingWorker(): Worker | undefined {
    return this.target.kind === "forward" ? this.workers.get(this.target.port) : undefined;
  }

  /** Why no agent serves, as diagnostics; none while one serves or starts. */
  unavailableDiagnostics(): AuthoringDiagnostic[] {
    return this.target.kind === "unavailable" ? this.target.unavailable.diagnostics : [];
  }

  /** The worker serving on `port` is gone, `clean` after exit code 0: its sockets end. */
  workerGone(port: number, clean: boolean): void {
    for (const socket of this.sockets.get(port) ?? []) socket.workerGone(clean);
    this.sockets.delete(port);
  }

  openSocket(url: string): PagePortSocket {
    const channel = new MessageChannel();
    const socket = new PagePortSocket(channel.port1, url);
    const route = () => {
      const target = this.target;
      if (target.kind === "hold") return void this.held.add(route);
      if (target.kind === "unavailable") return this.explain(channel.port2);
      const worker = this.workers.get(target.port);
      if (!worker) return void this.held.add(route);
      const { pathname, search } = new URL(url);
      const open = this.sockets.get(target.port) ?? new Set();
      this.sockets.set(target.port, open);
      open.add(socket);
      socket.addEventListener("close", () => open.delete(socket));
      const message: ToWorker = { connect: { url: `${pathname}${search}`, headers: { host: location.host }, port: channel.port2 } };
      worker.postMessage(message, [channel.port2]);
    };
    route();
    return socket;
  }

  fetch(request: Request): Promise<Response> {
    return new Promise((resolve, reject) => {
      const route = async () => {
        const target = this.target;
        if (target.kind === "hold") return void this.held.add(() => void route());
        if (target.kind === "unavailable") {
          return resolve(new Response(`The agent is not running: ${target.unavailable.message}`, { status: 503 }));
        }
        const worker = this.workers.get(target.port);
        if (!worker) return void this.held.add(() => void route());
        const { pathname, search } = new URL(request.url);
        const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
        const channel = new MessageChannel();
        channel.port1.onmessage = (event: MessageEvent<ForwardedResponse>) => {
          channel.port1.close();
          const { status, headers, body: answer } = event.data;
          resolve(new Response(status === 204 || status === 304 ? null : answer, { status, headers }));
        };
        const message: ToWorker = {
          request: { method: request.method, url: `${pathname}${search}`, headers: Object.fromEntries(request.headers), body },
          reply: channel.port2,
        };
        worker.postMessage(message, body ? [channel.port2, body] : [channel.port2]);
      };
      route().catch(reject);
    });
  }

  /** `AgentForwarder.explainUnavailable`: the reason now, an error for anything it is sent. */
  private explain(port: MessagePort): void {
    const target = this.target;
    if (target.kind !== "unavailable") return;
    this.explained.add(port);
    port.postMessage({ accepted: true });
    port.postMessage({ data: serializeServerMessage({ type: "agent_unavailable", ...target.unavailable }) });
    port.onmessage = (event: MessageEvent<{ close?: unknown }>) => {
      if (event.data.close) return void this.explained.delete(port);
      const current = this.target;
      const reason = current.kind === "unavailable" ? current.unavailable.message : "it is reloading";
      port.postMessage({ data: serializeServerMessage({ type: "error", scope: "protocol", message: `The agent is not running: ${reason}` }) });
    };
  }
}

const workers = new Map<number, Worker>();
const forwarder = new PageForwarder(workers);
let nextPort = 1;

function sameOrigin(url: string): URL | null {
  const parsed = new URL(url, location.href);
  const origin = parsed.protocol.replace(/^ws/, "http") + "//" + parsed.host;
  return origin === location.origin ? parsed : null;
}

/** A WebSocket to the agent goes to the worker; any other (Vite's HMR, LiveKit) is the browser's. */
function AgentAwareWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
  const parsed = sameOrigin(String(url));
  if (!parsed || parsed.pathname === VITE_HMR_PATH) return new NativeWebSocket(url, protocols);
  return forwarder.openSocket(parsed.href) as unknown as WebSocket;
}
Object.assign(AgentAwareWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: NativeWebSocket.prototype });
window.WebSocket = AgentAwareWebSocket as unknown as typeof WebSocket;

/** The preview reads the project's context markdown over HTTP (`public-context.ts`): from `context/`. */
function contextResponse(pathname: string): Response | null {
  const markdown = [...project.files.keys()].filter((path) => path.startsWith("context/") && path.endsWith(".md"));
  if (pathname === "/context.index.json") {
    return Response.json(markdown.map((path) => path.slice("context/".length)).sort());
  }
  const text = project.files.get(`context${decodeURIComponent(pathname)}`);
  return pathname.endsWith(".md") && text !== undefined ? new Response(text, { headers: { "content-type": "text/markdown" } }) : null;
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const parsed = sameOrigin(request.url);
  if (parsed && isAgentHttpPath(parsed.pathname)) return forwarder.fetch(request);
  if (parsed && request.method === "GET") {
    await loaded;
    const context = contextResponse(parsed.pathname);
    if (context) return context;
  }
  return nativeFetch(request);
};

/** One worker as the supervisor drives a child process. */
function spawnWorker(quiet: boolean): AgentProcess {
  const port = nextPort++;
  const worker = new Worker(WORKER_URL, { type: "module" });
  const listeners: Array<(message: ChildMessage) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    worker.terminate();
    workers.delete(port);
    forwarder.workerGone(port, code === 0);
    // After the current task, as a child process's exit event arrives: the supervisor kills
    // a starting child and then launches its replacement, and must hear the exit after that.
    setTimeout(() => {
      for (const listener of exitListeners) listener(code);
    });
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if ("child" in message) {
      for (const listener of listeners) listener(message.child);
      // A child that failed to load exits after saying so (`dev-child.ts`).
      if (message.child.type === "failed") exit(1);
    } else if ("exited" in message) {
      exit(message.exited);
    } else if ("log" in message) {
      logLine(message.log.level, message.log.text);
    } else {
      const { path, change } = message.volume;
      volume.set(path, "append" in change ? (volume.files.get(path) ?? "") + change.append : change.text);
    }
  };
  worker.onerror = (event) => {
    console.error(`[curb] the agent worker failed: ${event.message}`);
    exit(1);
  };
  workers.set(port, worker);
  const boot: WorkerBoot = {
    env: workerEnv(),
    files: Object.fromEntries(project.files),
    volume: Object.fromEntries(volume.files),
    port,
    quiet,
  };
  worker.postMessage(boot);
  return {
    send: (message) => worker.postMessage({ supervisor: message } satisfies ToWorker),
    kill: () => exit(null),
    onMessage: (listener) => void listeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
  };
}

/** A reload outcome waits at most this long: a reload also waits for a running reply or call. */
const RELOAD_WAIT_MS = 20_000;

/**
 * How the agent took a change, from the supervisor's targets: a worker started after the
 * change serves (`reloaded`) or none can (`failed`, with the reason). The ports name workers
 * in start order, so "after the change" is a port above the last one started then.
 */
class ReloadWatch {
  private readonly waiting = new Set<(target: AgentTarget) => void>();
  state: AgentState = "reloading";
  message: string | undefined;
  onState: ((state: AgentState, message?: string) => void) | null = null;

  target(target: AgentTarget): void {
    const state: AgentState = target.kind === "forward" ? "serving" : target.kind === "hold" ? "reloading" : "down";
    const message = target.kind === "unavailable" ? target.unavailable.message : undefined;
    // The platform keeps the last state: tell it on a change only.
    if (state !== this.state || message !== this.message) this.onState?.(state, message);
    this.state = state;
    this.message = message;
    for (const listener of [...this.waiting]) listener(target);
  }

  /** Run `start` (which may launch a worker) and answer how the next worker came up. */
  after(start: () => void): Promise<Reload> {
    const lastPort = nextPort - 1;
    const started = performance.now();
    return new Promise((resolve) => {
      const done = (reload: Reload) => {
        clearTimeout(timer);
        this.waiting.delete(listener);
        resolve(reload);
      };
      const listener = (target: AgentTarget) => {
        const ms = Math.round(performance.now() - started);
        if (target.kind === "forward" && target.port > lastPort) done({ state: "reloaded", ms });
        else if (target.kind === "unavailable" && nextPort - 1 > lastPort) {
          const { message, diagnostics } = target.unavailable;
          done({ state: "failed", ms, message, diagnostics: diagnostics.map(toolDiagnostic) });
        }
      };
      const timer = setTimeout(
        () =>
          done({
            state: "pending",
            message: `The agent has not reloaded after ${RELOAD_WAIT_MS / 1000} s: it waits for a running reply or call to end, then reloads.`,
          }),
        RELOAD_WAIT_MS,
      );
      this.waiting.add(listener);
      start();
    });
  }
}
const reloads = new ReloadWatch();

function npmLog(line: string): void {
  console.info(`[npm] ${line}`);
  logLine("info", `[npm] ${line}`);
}

/** The platform's socket, when the page was opened from its link: the project is then the platform's. */
let relay: Relay | null = null;

/**
 * A change to the project: saved to the platform first when the project is its (a refused
 * save throws and changes nothing), then written here, then the agent reloads when the change
 * touches it; how that went.
 */
async function applyChange(change: ProjectChange): Promise<Reload> {
  const saved = relay ? savedPart(change) : null;
  if (saved) await relay!.save(saved);
  writeHere(change);
  return reload([...change.writes.keys(), ...change.deletes]);
}

/** A change into the working copy (and IndexedDB behind it), without a reload. */
function writeHere(change: ProjectChange): void {
  for (const path of change.deletes) project.delete(path);
  for (const [path, text] of change.writes) project.set(path, text);
}

/** Reload the agent when any of `paths` changes it. */
function reload(paths: readonly string[]): Promise<Reload> {
  const counted = paths.filter(countsForAgent);
  if (counted.length === 0) return Promise.resolve({ state: "unchanged" });
  return reloads.after(() => supervisor.filesChanged(counted));
}

const supervisor = new AgentServerSupervisor({
  spawn: ({ quiet }) => spawnWorker(quiet),
  target: (target, files) => {
    forwarder.setTarget(target, files);
    reloads.target(target);
  },
  firstStart: (outcome) => {
    if ("failure" in outcome) console.error(`[curb] the agent did not load: ${outcome.failure.message}`);
    else console.info("[curb] agent server running in this page's worker");
  },
  log: (level, message) => {
    (level === "error" ? console.error : console.info)(`[curb] ${message}`);
    logLine(level, `[curb] ${message}`);
  },
});
/**
 * The working copy and the conversations, back from IndexedDB. A plain page starts on the
 * template; a page from a platform link waits for the platform's copy (`loadFromPlatform`).
 */
const loaded = (async () => {
  await Promise.all([project.load(), volume.load()]);
  if (!link && project.files.size === 0) writeHere(await templateChange());
})();

/** The template the build ships (`curb-browser/template.json`), by path. */
async function templateFiles(): Promise<Record<string, string>> {
  const response = await nativeFetch("/curb-browser/template.json");
  if (!response.ok) throw new Error(`The project template did not load: HTTP ${response.status}.`);
  return (await response.json()) as Record<string, string>;
}

/** What makes the working copy the template (its installed packages and secrets go too). */
async function templateChange(): Promise<ProjectChange> {
  return { writes: new Map(Object.entries(await templateFiles())), deletes: [...project.files.keys()] };
}

/** A file the page ships (`/curb-browser/...`). */
async function assetBytes(path: string): Promise<Uint8Array> {
  const response = await nativeFetch(path);
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The platform's copy becomes the template (and the binary files it depends on); the copy it now holds. */
async function seedPlatform(): Promise<PlatformFile[]> {
  const template = await templateFiles();
  const binaries = await Promise.all(
    binaryFilesOf(new Map(Object.entries(template))).map(async ([path, asset]) => [path, await assetBytes(asset)] as [string, Uint8Array]),
  );
  await relay!.save(seedSave(template, binaries));
  logLine("info", "[curb] the project started on the platform from the template");
  return [...Object.entries(template).map(([path, text]) => ({ path, text })), ...binaries.map(([path, bytes]) => ({ path, size: bytes.length }))];
}

/** The agent server has been started once. */
let started = false;

/**
 * The platform's copy, on every `ready`: an empty one is seeded from the template; the working
 * copy becomes it, `node_modules/` is installed from its lockfile, and the agent starts, or
 * reloads when it was running and anything differs.
 */
async function loadFromPlatform(files: PlatformFile[] | null): Promise<void> {
  const copy = files ?? (await seedPlatform());
  const fromPlatform = platformCopyChange(project.files, copy);
  writeHere(fromPlatform);
  const paths = [...fromPlatform.writes.keys(), ...fromPlatform.deletes];
  try {
    const packages = await npmRestore(project.files, npmLog);
    writeHere(packages);
    paths.push(...packages.writes.keys(), ...packages.deletes);
  } catch (error) {
    // The agent still starts: an import of a package that did not install names itself.
    logLine("error", `[npm] the project's packages did not install: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (paths.length > 0) logLine("info", `[curb] loaded the platform's copy (${paths.length} file(s) changed here)`);
  if (!started) {
    started = true;
    supervisor.start();
    return;
  }
  await reload(paths);
}

/** `curb dev`'s rule for a path that reloads the agent, and package.json (the packages it can import). */
function countsForAgent(path: string): boolean {
  return changesAgent(path) || path === "package.json";
}

/** The project, for an editor or a coding agent in the page. Changes are saved to the platform when the project is its. */
const projectApi = {
  /** Every file path (the packages under `node_modules/` too). */
  list: (): string[] => [...project.files.keys()].sort(),
  read: (path: string): string | undefined => project.files.get(path),
  write: (path: string, text: string): Promise<Reload> => applyChange({ writes: new Map([[path, text]]), deletes: [] }),
  remove: (path: string): Promise<Reload> => applyChange({ writes: new Map(), deletes: [path] }),
  /** `npm install <specs...>`: from the npm registry, into `node_modules/`, then a reload. */
  async install(...specs: string[]): Promise<void> {
    await applyChange(await npmInstall(specs, project.files, npmLog));
  },
  /** Back to the template (the conversations stay; on a platform project, its copy too). */
  async reset(): Promise<void> {
    if (relay) return loadFromPlatform(await seedPlatform());
    const change = await templateChange();
    writeHere(change);
    await reload([...change.writes.keys(), ...change.deletes]);
  },
};
(window as unknown as { curb: { project: typeof projectApi } }).curb = { project: projectApi };

const JOURNAL = WORKER_ENV.KUGEL_CONVERSATIONS_DB!;

/** The page, as the coding agent's tools see it (`tools.ts`). */
const toolHost: ToolHost = {
  files: project.files,
  change: applyChange,
  restart: () => reloads.after(() => supervisor.filesChanged(["src/agent/agent.tsx"])),
  journal: () => volume.files.get(JOURNAL) ?? "",
  log: () => ({ state: reloads.state, lines: logLines, lastError }),
  requestSecret(name) {
    void askForSecret(name).then((value) => {
      if (value === null) return logLine("info", `[curb] ${name} was not set (the prompt was dismissed)`);
      const kept = (project.files.get(".env") ?? "").split("\n").filter((line) => line.trim() !== "" && !new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line));
      void applyChange({ writes: new Map([[".env", `${[...kept, `${name}=${JSON.stringify(value)}`].join("\n")}\n`]]), deletes: [] });
      logLine("info", `[curb] ${name} saved to this browser's .env`);
    });
  },
  npmLog,
};

/** The journal's conversations, by id. */
function journalIds(): Array<{ id: number; userTexts: Set<string> }> {
  const byId = new Map<number, Set<string>>();
  for (const line of toolHost.journal().split("\n")) {
    if (!line.trim()) continue;
    let record: { t?: string; id?: number; conversation?: number; message?: { role?: string; content?: string } };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // KEEP-JUSTIFIED: a torn last line is a write in progress; the next read has it.
    }
    if (record.t === "conversation" && record.id !== undefined) byId.set(record.id, byId.get(record.id) ?? new Set());
    if (record.t === "message" && record.conversation !== undefined && record.message?.role === "user") {
      (byId.get(record.conversation) ?? byId.set(record.conversation, new Set()).get(record.conversation)!).add(record.message.content ?? "");
    }
  }
  return [...byId].map(([id, userTexts]) => ({ id, userTexts }));
}

const turns = new AgentTurns({
  // The preview's own route to the agent: the forwarder's socket is a WebSocket to its users.
  openAgentSocket: (path) => forwarder.openSocket(new URL(path, location.href.replace(/^http/, "ws")).href) as unknown as WebSocket,
  async diagnostics() {
    const state = reloads.state;
    if (state === "down") {
      return { serving: false, message: reloads.message ?? "the agent does not load", diagnostics: forwarder.unavailableDiagnostics() };
    }
    const worker = forwarder.servingWorker();
    if (!worker) return { serving: false, message: "the agent is reloading; call again in a moment", diagnostics: [] };
    const channel = new MessageChannel();
    const answer = await new Promise<DiagnosticsAnswer>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent<DiagnosticsAnswer>) => resolve(event.data);
      worker.postMessage({ diagnostics: channel.port2 } satisfies ToWorker, [channel.port2]);
    });
    channel.port1.close();
    if ("error" in answer) return { serving: false, message: answer.error, diagnostics: [] };
    return { serving: true, diagnostics: answer.diagnostics };
  },
  lastConversationId: () => Math.max(0, ...journalIds().map((entry) => entry.id)),
  async recordedConversation(text, afterId) {
    // The worker's journal writes reach the page beside the socket's frames, not in order with them.
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = journalIds().filter((entry) => entry.id > afterId && entry.userTexts.has(text)).at(-1);
      if (found) return found.id;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  },
});

function startRelay(): void {
  relay = new Relay(link!, browserTools(toolHost, turns), {
    WebSocket: NativeWebSocket,
    onState: (state) => {
      if (state.kind === "connected" && session) signedIn(session, sessionStorage);
      if (state.kind === "refused" && session) {
        forgetLink(session, localStorage);
        if (signIn()) return;
        return showRelayState(state, sessions?.signIn ? "signInFailed" : "noLink");
      }
      showRelayState(state);
      logLine("info", `[relay] ${state.kind}${state.kind === "retrying" ? ` in ${state.inMs} ms` : ""}`);
    },
    onModelBase(base) {
      if (WORKER_ENV.KUGELAUDIO_API_BASE === base) return;
      WORKER_ENV.KUGELAUDIO_API_BASE = base;
      // The agent picks the new base up as it starts again (or as it first starts).
      if (started) supervisor.filesChanged([".env"]);
    },
    onProject: loadFromPlatform,
    log: (line) => logLine("info", `[relay] ${line}`),
  });
  reloads.onState = (state, message) => relay!.agentStatus(state, message);
  relay.agentStatus(reloads.state, reloads.message);
  relay.start();
}

loaded.then(
  () => {
    // From a platform link the agent starts once the platform's copy has loaded.
    if (link) startRelay();
    else {
      started = true;
      supervisor.start();
    }
  },
  (error: unknown) => console.error(`[curb] the project did not load: ${String(error)}`),
);
