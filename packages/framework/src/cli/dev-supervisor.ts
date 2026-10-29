import { formatAuthoringLocation } from "../authoring.js";
import type { AgentServerReport } from "../server/main.js";
import type { ChildMessage, SupervisorMessage } from "./dev-ipc.js";
import type { AgentTarget, AgentUnavailable } from "./dev-proxy.js";

/** A running agent server, as the supervisor drives it: a child process, a fake in tests. */
export type AgentProcess = {
  send(message: SupervisorMessage): void;
  kill(signal?: NodeJS.Signals): void;
  onMessage(listener: (message: ChildMessage) => void): void;
  /** Once, when the process is gone (`code` null when a signal ended it). */
  onExit(listener: (code: number | null) => void): void;
};

export type SupervisorDeps = {
  /** Start an agent server. `quiet`: a reload, which prints nothing at boot. */
  spawn(options: { quiet: boolean }): AgentProcess;
  /** Where the preview's port sends the agent's traffic now (`files`: what a reload is for). */
  target(target: AgentTarget, files: readonly string[]): void;
  /** The first start ended: serving, or the agent did not load. `curb dev` prints its banner. */
  firstStart(outcome: { report: AgentServerReport } | { failure: AgentUnavailable }): void;
  /** One terminal line. */
  log(level: "info" | "error", message: string): void;
  now?(): number;
};

/** An agent server that is not ready by then is stopped, and the preview says so. */
export const START_TIMEOUT_MS = 60_000;
/** An agent server asked to stop for a reload that is still running by then is killed. */
export const STOP_TIMEOUT_MS = 5_000;
/** An agent server that crashes sooner than this after it was ready is not started again
 * until a file changes: it would only crash again. */
export const CRASH_LOOP_MS = 10_000;
/** A reload waits this long at most for a running reply, then reloads anyway and cuts it, as a
 * crash would. A live call is never cut; an MCP sign-in ends within `MCP_SIGN_IN_HOLD_MS`. */
export const REPLY_WAIT_MS = 30_000;

/** What a pending reload waits for: the live call to end, the MCP sign-in the user opened to
 * call back, or the running reply to end. */
type Waiting = "call_ends" | "sign_in_ends" | "reply_ends";

/** The terminal line while a reload waits, after "<files> changed: ". */
const WAITING_LINES: Record<Waiting, string> = {
  call_ends: "reloading when the call ends",
  sign_in_ends: "reloading when the MCP sign-in finishes (at most 5 min)",
  reply_ends: `reloading when the reply ends (at most ${REPLY_WAIT_MS / 1000}s)`,
};

type Phase =
  | { kind: "idle" }
  | {
      kind: "starting";
      child: AgentProcess;
      files: string[];
      /** When the reload (or the first start) began, for the "reloaded in" line. */
      since: number;
      failure: AgentUnavailable | null;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "serving";
      child: AgentProcess;
      readyAt: number;
      calls: number;
      turns: number;
      signIns: number;
      /** Changed since this server started, waiting for the call, the sign-in or the reply. */
      pending: string[];
      waiting: Waiting | null;
      /** Cuts the running reply the reload waits for, at `REPLY_WAIT_MS`. */
      replyTimer: ReturnType<typeof setTimeout> | null;
    }
  | { kind: "stopping"; child: AgentProcess; files: string[]; since: number; timer: ReturnType<typeof setTimeout> }
  | { kind: "down" }
  | { kind: "closed" };

/**
 * Keeps one agent server running for `curb dev` and restarts it when the project's files
 * change, so the agent the preview talks to always runs the code on disk. A restart waits
 * for a live call to end, for an MCP sign-in the user opened, and for a running reply (at
 * most `REPLY_WAIT_MS`); a server that does not start leaves the preview showing why, until
 * the next change starts another.
 */
export class AgentServerSupervisor {
  private phase: Phase = { kind: "idle" };
  /** The first start ended (ready or failed): every later start is a quiet reload. */
  private started = false;
  /** The conversation store the last server that came up named, for the line when it changes. */
  private conversationStore: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SupervisorDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.phase.kind !== "idle") return;
    this.launch([], this.now());
  }

  /** Paths (from the project root) whose change changes the agent. */
  filesChanged(paths: readonly string[]): void {
    const phase = this.phase;
    switch (phase.kind) {
      case "starting":
        // It may have read some files before they changed: start over.
        clearTimeout(phase.timer);
        phase.child.kill("SIGKILL");
        this.launch(union(phase.files, paths), phase.since);
        return;
      case "serving":
        phase.pending = union(phase.pending, paths);
        this.reloadWhenIdle(phase);
        return;
      case "stopping":
        phase.files = union(phase.files, paths);
        return;
      case "down":
        this.launch([...paths], this.now());
        return;
      case "idle":
      case "closed":
        return;
    }
  }

  /** `curb dev` is exiting. */
  close(): void {
    const phase = this.phase;
    this.phase = { kind: "closed" };
    if (phase.kind === "starting" || phase.kind === "stopping") clearTimeout(phase.timer);
    if (phase.kind === "serving") stopReplyTimer(phase);
    if (phase.kind === "starting" || phase.kind === "serving" || phase.kind === "stopping") {
      phase.child.kill("SIGTERM");
    }
  }

  private launch(files: string[], since: number): void {
    const child = this.deps.spawn({ quiet: this.started });
    const timer = setTimeout(() => {
      const phase = this.phase;
      if (phase.kind !== "starting" || phase.child !== child) return;
      phase.failure = {
        message: `The agent server did not start within ${START_TIMEOUT_MS / 1000}s.`,
        diagnostics: [],
      };
      child.kill("SIGKILL");
    }, START_TIMEOUT_MS);
    this.phase = { kind: "starting", child, files, since, failure: null, timer };
    child.onMessage((message) => this.onMessage(child, message));
    child.onExit((code) => this.onExit(child, code));
    this.deps.target({ kind: "hold" }, files);
  }

  private onMessage(child: AgentProcess, message: ChildMessage): void {
    const phase = this.phase;
    if (!("child" in phase) || phase.child !== child) return;
    if (message.type === "failed" && phase.kind === "starting") {
      phase.failure = { message: "The agent did not load.", diagnostics: [message.diagnostic] };
      return;
    }
    if (message.type === "ready" && phase.kind === "starting") {
      clearTimeout(phase.timer);
      this.phase = {
        kind: "serving",
        child,
        readyAt: this.now(),
        calls: 0,
        turns: 0,
        signIns: 0,
        pending: [],
        waiting: null,
        replyTimer: null,
      };
      this.deps.target({ kind: "forward", port: message.port }, phase.files);
      const store = message.report.conversationStore;
      const storeChanged = this.conversationStore !== null && store !== this.conversationStore;
      this.conversationStore = store;
      if (!this.started) {
        this.started = true;
        this.deps.firstStart({ report: message.report });
        return;
      }
      this.logReload(phase.files, this.now() - phase.since, message.report);
      // A reload prints no boot lines, so a changed store (a KUGEL_CONVERSATION_SINK added,
      // dropped or misspelled in .env) would otherwise apply without a word.
      if (storeChanged) this.deps.log("info", `conversation store: ${store}`);
      return;
    }
    if (message.type === "activity" && phase.kind === "serving") {
      phase.calls = message.calls;
      phase.turns = message.turns;
      phase.signIns = message.signIns;
      this.reloadWhenIdle(phase);
    }
  }

  private onExit(child: AgentProcess, code: number | null): void {
    const phase = this.phase;
    if (!("child" in phase) || phase.child !== child) return;
    if (phase.kind === "stopping") {
      clearTimeout(phase.timer);
      this.launch(phase.files, phase.since);
      return;
    }
    if (phase.kind === "starting") {
      clearTimeout(phase.timer);
      const failure = phase.failure ?? {
        message: `The agent server exited while starting (${exitDescription(code)}); its output above says why.`,
        diagnostics: [],
      };
      this.goDown(failure);
      if (!this.started) {
        this.started = true;
        this.deps.firstStart({ failure });
        return;
      }
      this.deps.log("error", `${describeFiles(phase.files) || "restart"}: ${describeFailure(failure)}`);
      return;
    }
    // Serving, and it exited on its own: a crash.
    stopReplyTimer(phase);
    if (this.now() - phase.readyAt >= CRASH_LOOP_MS) {
      this.deps.log("error", `the agent server exited (${exitDescription(code)}); starting it again`);
      this.launch(phase.pending, this.now());
      return;
    }
    this.goDown({
      message: `The agent server exited (${exitDescription(code)}) right after it started; its output above says why. Save a file to start it again.`,
      diagnostics: [],
    });
    this.deps.log("error", `the agent server exited (${exitDescription(code)}) right after it started; save a file to start it again`);
  }

  private goDown(failure: AgentUnavailable): void {
    this.phase = { kind: "down" };
    this.deps.target({ kind: "unavailable", unavailable: failure }, []);
  }

  /**
   * Reload now if nothing holds it, else say once what the reload waits for: the pages (a
   * call or a reply; a sign-in happens in another window) and the terminal.
   */
  private reloadWhenIdle(phase: Extract<Phase, { kind: "serving" }>): void {
    if (phase.pending.length === 0) return;
    const waiting: Waiting | null =
      phase.calls > 0 ? "call_ends" : phase.signIns > 0 ? "sign_in_ends" : phase.turns > 0 ? "reply_ends" : null;
    if (waiting === null) {
      this.stop(phase);
      return;
    }
    if (waiting === phase.waiting) return;
    phase.waiting = waiting;
    stopReplyTimer(phase);
    if (waiting === "reply_ends") {
      phase.replyTimer = setTimeout(() => {
        if (this.phase !== phase) return;
        this.deps.log("info", `the reply did not end within ${REPLY_WAIT_MS / 1000}s: reloading now, which cuts it off`);
        this.stop(phase);
      }, REPLY_WAIT_MS);
    }
    if (waiting !== "sign_in_ends") phase.child.send({ type: "waiting", until: waiting, files: phase.pending });
    this.deps.log("info", `${describeFiles(phase.pending)} changed: ${WAITING_LINES[waiting]}`);
  }

  /** Stop the serving agent server for the reload of its pending files. */
  private stop(phase: Extract<Phase, { kind: "serving" }>): void {
    stopReplyTimer(phase);
    const files = phase.pending;
    phase.child.send({ type: "stop", files });
    const child = phase.child;
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    this.phase = { kind: "stopping", child, files, since: this.now(), timer };
    this.deps.target({ kind: "hold" }, files);
  }

  private logReload(files: readonly string[], ms: number, report: AgentServerReport): void {
    const what = describeFiles(files);
    const line = `${what ? `reloaded ${what}` : "restarted"} in ${formatDuration(ms)}`;
    if (report.renderError !== null) {
      this.deps.log("error", `${line}, but the agent does not render: ${report.renderError}`);
      return;
    }
    if (report.errors > 0) {
      this.deps.log("error", `${line}, with ${report.errors} authoring error${report.errors === 1 ? "" : "s"} (the preview's Diagnostics)`);
      return;
    }
    this.deps.log("info", line);
  }
}

function union(current: readonly string[], added: readonly string[]): string[] {
  return [...new Set([...current, ...added])].sort();
}

function stopReplyTimer(phase: Extract<Phase, { kind: "serving" }>): void {
  if (phase.replyTimer !== null) clearTimeout(phase.replyTimer);
  phase.replyTimer = null;
}

/** `src/agent/claims/skill.tsx`, or `src/agent/claims/skill.tsx and 2 more`. */
export function describeFiles(files: readonly string[]): string {
  if (files.length === 0) return "";
  return files.length === 1 ? files[0] : `${files[0]} and ${files.length - 1} more`;
}

function describeFailure(failure: AgentUnavailable): string {
  const diagnostic = failure.diagnostics[0];
  if (!diagnostic) return failure.message;
  const location = formatAuthoringLocation(diagnostic.location);
  return `${diagnostic.message}${location ? ` (${location})` : ""}`;
}

function exitDescription(code: number | null): string {
  return code === null ? "killed by a signal" : `exit code ${code}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
