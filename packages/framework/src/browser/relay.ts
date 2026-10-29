/**
 * The tab's socket to a hosting platform, which carries a coding agent's tool calls to this
 * page and the answers back (the frames are in `docs/browser.md`). The page opens
 * it when it was opened from a link the platform issued (`#project=&token=&api=`), keeps
 * that link for the project so a reload reconnects, and answers each `call` frame with the
 * tool's result (`tools.ts`). Without a link the page is a plain browser dev environment.
 *
 * The platform holds the project (`project-sync.ts`): every `ready` carries its files, which
 * the page loads before any call is answered, and `save` stores a change there before the
 * page applies it.
 */

import type { PlatformFile, ProjectSave } from "./project-sync.js";
import { ToolError, type AgentState, type ToolHandler } from "./tools.js";

export type RelayLink = { project: string; token: string; api: string };

/** The tab answers at most this much in one reply. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** Tools that only read run beside others; the rest run one at a time, in order. */
const READS = new Set(["list_files", "read_file", "search", "get_log", "list_conversations", "get_conversation", "check"]);

/** A link is kept per place: a session page's path (`session.ts`), or `/` for the plain page. */
const LINK_KEY = (place: string) => `curb-browser:link:${place}`;

/** The link in a fragment (`#project=…&token=…&api=…`), or null. */
export function linkFromFragment(hash: string): RelayLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const project = params.get("project");
  const token = params.get("token");
  const api = params.get("api");
  if (!project || !token || !api) return null;
  let origin: string;
  try {
    origin = new URL(api).origin;
  } catch {
    return null;
  }
  return { project, token, api: origin };
}

/**
 * The link this page works on at `place`: the fragment's (kept, and taken out of the address
 * bar so the token is in no history entry), else the one this browser kept there.
 */
export function currentLink(
  location: Pick<Location, "hash" | "pathname" | "search">,
  storage: Storage,
  place: string,
  history?: Pick<History, "replaceState">,
): RelayLink | null {
  const fromFragment = linkFromFragment(location.hash);
  if (fromFragment) {
    storage.setItem(LINK_KEY(place), JSON.stringify(fromFragment));
    history?.replaceState(null, "", `${location.pathname}${location.search}`);
    return fromFragment;
  }
  const kept = storage.getItem(LINK_KEY(place));
  return kept ? (JSON.parse(kept) as RelayLink) : null;
}

/** Drops the link kept at `place`: the platform refused it. */
export function forgetLink(place: string, storage: Storage): void {
  storage.removeItem(LINK_KEY(place));
}

export type RelayState =
  | { kind: "connecting" }
  | { kind: "connected" }
  /** The platform refused the link (expired or revoked): only a new link helps. */
  | { kind: "refused" }
  /** A newer tab took the project over. */
  | { kind: "replaced" }
  | { kind: "retrying"; inMs: number };

type CallFrame = { type: "call"; id: string; tool: string; input?: Record<string, unknown> };
type SaveAnswer = { type: "saved"; id: string } | { type: "save_failed"; id: string; error?: { code?: string; message?: string } };

/** The platform's copy in a `ready` frame: its files, null when it is empty, undefined when the frame is not one. */
function projectOf(frame: { project?: unknown }): PlatformFile[] | null | undefined {
  if (frame.project === null) return null;
  const files = (frame.project as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return undefined;
  const valid = files.every(
    (file: { path?: unknown; text?: unknown; size?: unknown }) =>
      typeof file?.path === "string" && (typeof file.text === "string" || typeof file.size === "number"),
  );
  return valid ? (files as PlatformFile[]) : undefined;
}

export class Relay {
  private socket: WebSocket | null = null;
  /** The platform answered `ready` on the current socket: frames may go. */
  private ready = false;
  private retryMs = 500;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private agent: { state: AgentState; message?: string } = { state: "reloading" };
  /** The platform's project being loaded: calls wait for it. */
  private loading: Promise<void> = Promise.resolve();
  private nextSave = 0;
  private readonly saves = new Map<string, { resolve: () => void; reject: (error: ToolError) => void }>();

  constructor(
    private readonly link: RelayLink,
    private readonly tools: Record<string, ToolHandler>,
    private readonly options: {
      WebSocket: typeof WebSocket;
      onState?: (state: RelayState) => void;
      /** Where the platform relays this tab's model calls (`ready.model.base`), when it does. */
      onModelBase?: (base: string) => void;
      /** The platform's copy of the project, on every `ready`: null when it is empty (seed it with `save`). */
      onProject?: (files: PlatformFile[] | null) => Promise<void>;
      log?: (line: string) => void;
    },
  ) {}

  /**
   * Stores a change in the platform's copy; resolves once the platform has it. Refused
   * (ToolError) while the tab is not connected, when the platform refuses it, or when the
   * socket closes first; the page applies a change only after this resolves.
   */
  save(change: ProjectSave): Promise<void> {
    if (!this.ready || this.socket?.readyState !== 1) {
      return Promise.reject(new ToolError("not_connected", "The tab is not connected to the platform, so the change was not saved and nothing changed. It reconnects by itself; try again in a moment."));
    }
    const id = `s${++this.nextSave}`;
    const frame = JSON.stringify({ type: "save", id, ...change });
    if (frame.length > MAX_REPLY_BYTES) {
      return Promise.reject(new ToolError("project_too_large", `The change is ${frame.length} bytes; a tab saves at most 8 MiB at once.`));
    }
    return new Promise<void>((resolve, reject) => {
      this.saves.set(id, { resolve, reject });
      this.socket!.send(frame);
    });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close(1000, "tab closed");
  }

  /** The agent's state changed: the platform keeps the last one (`GET …/browser/status`). */
  agentStatus(state: AgentState, message?: string): void {
    this.agent = message === undefined ? { state } : { state, message };
    this.sendFrame({ type: "status", agent: this.agent });
  }

  private connect(): void {
    this.options.onState?.({ kind: "connecting" });
    const url = new URL("/v1/agents/browser/socket", this.link.api);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new this.options.WebSocket(url.href);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", project: this.link.project, token: this.link.token }));
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data) as { type: string; model?: { base?: unknown }; project?: unknown };
      if (frame.type === "ready") {
        const project = projectOf(frame);
        if (project === undefined) {
          this.options.log?.("the platform's ready frame carries no project; this tab cannot load it");
          socket.close(1002, "ready without a project");
          return;
        }
        this.ready = true;
        if (typeof frame.model?.base === "string") this.options.onModelBase?.(frame.model.base);
        this.retryMs = 500;
        this.options.onState?.({ kind: "connected" });
        this.sendFrame({ type: "status", agent: this.agent });
        const load = this.options.onProject?.(project) ?? Promise.resolve();
        this.loading = load.catch((error: unknown) =>
          this.options.log?.(`the project did not load: ${error instanceof Error ? error.message : String(error)}`),
        );
      } else if (frame.type === "saved" || frame.type === "save_failed") {
        this.settleSave(frame as SaveAnswer);
      } else if (frame.type === "call") {
        this.answer(frame as CallFrame);
      }
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      const unsettled = [...this.saves.values()];
      this.saves.clear();
      for (const pending of unsettled) {
        // The platform may have stored it: the next ready carries its copy either way.
        pending.reject(new ToolError("not_connected", "The connection to the platform closed before it confirmed the change, so this tab did not apply it. The platform's copy is the project; read the file again once the tab reconnects."));
      }
      if (this.stopped) return;
      if (event.code === 4401) return this.end({ kind: "refused" }, "the platform refused this link; ask Claude for a new one (agent_open)");
      if (event.code === 4409) return this.end({ kind: "replaced" }, "another tab opened this project; this one stopped answering");
      const inMs = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
      this.options.onState?.({ kind: "retrying", inMs });
      setTimeout(() => {
        if (!this.stopped) this.connect();
      }, inMs);
    };
  }

  private end(state: RelayState, line: string): void {
    this.stopped = true;
    this.options.log?.(line);
    this.options.onState?.(state);
  }

  private settleSave(answer: SaveAnswer): void {
    const pending = this.saves.get(answer.id);
    if (!pending) return;
    this.saves.delete(answer.id);
    if (answer.type === "saved") return pending.resolve();
    const code = answer.error?.code ?? "save_failed";
    pending.reject(new ToolError(code, `The platform did not save the change, so nothing changed: ${answer.error?.message ?? code}`));
  }

  private answer(call: CallFrame): void {
    const run = async () => {
      await this.loading;
      const handler = Object.hasOwn(this.tools, call.tool) ? this.tools[call.tool] : undefined;
      if (!handler) return this.reply(call.id, { ok: false, error: { code: "tool_unknown", message: `This tab has no tool "${call.tool}".` } });
      const started = performance.now();
      try {
        const result = await handler(call.input ?? {});
        this.options.log?.(`${call.tool} answered in ${Math.round(performance.now() - started)} ms`);
        this.reply(call.id, { ok: true, result });
      } catch (error) {
        const failure =
          error instanceof ToolError
            ? { code: error.code, message: error.message }
            : { code: "tool_crashed", message: error instanceof Error ? error.message : String(error) };
        this.options.log?.(`${call.tool} failed: ${failure.code}: ${failure.message}`);
        this.reply(call.id, { ok: false, error: failure });
      }
    };
    if (READS.has(call.tool)) {
      void run();
      return;
    }
    this.queue = this.queue.then(run);
  }

  private reply(id: string, body: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }): void {
    let frame = JSON.stringify({ type: "reply", id, ...body });
    if (frame.length > MAX_REPLY_BYTES) {
      frame = JSON.stringify({
        type: "reply",
        id,
        ok: false,
        error: { code: "reply_too_large", message: `The answer is ${frame.length} bytes; a tab answers at most 8 MiB.` },
      });
    }
    // A call whose socket closed meanwhile is answered by nobody: the platform timed it out.
    this.sendText(frame);
  }

  private sendFrame(frame: Record<string, unknown>): void {
    this.sendText(JSON.stringify(frame));
  }

  private sendText(text: string): void {
    if (this.ready && this.socket?.readyState === 1) this.socket.send(text);
  }
}
