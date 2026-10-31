import { HOOK_EVENT_TYPES, type AgentHooks, type CallEvent, type CallHook, type HookName } from "../hooks.js";
import type { ErrorCode, HookRunRequest, HookRunStatus } from "./protocol.js";

/**
 * The hook runs of this runner: a run id to each, so a host can start one and read how it ended.
 *
 * NO HTTP HERE, as in `session-registry.ts`: idempotence, the deadline and failure capture are
 * testable without a port.
 *
 * CUSTOMER CODE RUNS HERE, AND NOTHING IT DOES MAY END THE PROCESS. A throw or a rejection fails
 * its run. So does a failure it left behind (a floating promise, a throw in a timer), which only
 * the process sees: {@link HookRuns.guardProcess}.
 *
 * WHAT A HOST READS IS NOT WHAT THE AGENT THREW. `error.message` crosses into the host's storage,
 * so it carries the message alone, with no stack and no value of this process's environment:
 * {@link hookErrorMessage}. The stack goes to this runner's own log.
 */

/** What a run ended as. `cause` is what the hook threw, for the agent's own eyes only. */
export type HookOutcome =
  | { state: "succeeded" }
  | { state: "failed"; timedOut: boolean; cause: unknown };

/** How a failed hook reads past its deadline. A host matches this exact text. */
export const HOOK_TIMEOUT_MESSAGE = "timeout";

/**
 * Call `hook` with `event` and wait for it, up to `deadlineMs`. Never rejects: a throw, a
 * rejection and the deadline are outcomes.
 *
 * Past the deadline the hook keeps running, because JavaScript cannot stop it; `onLate` hears how
 * it ended. Only the first ending counts, so a late success never turns a timeout into a success.
 */
export async function invokeHook(
  hook: CallHook,
  event: CallEvent,
  deadlineMs: number,
  onLate?: (cause: unknown) => void,
): Promise<HookOutcome> {
  // An async wrapper, so a hook that throws before its first await rejects like any other, and
  // what a hook returns is never mistaken for the deadline.
  const running = (async () => {
    await hook(event.data.object, event);
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  try {
    if ((await Promise.race([running, deadline])) !== "timeout") return { state: "succeeded" };
    running.then(
      () => onLate?.(undefined),
      (cause: unknown) => onLate?.(cause),
    );
    return { state: "failed", timedOut: true, cause: new Error(HOOK_TIMEOUT_MESSAGE) };
  } catch (cause) {
    return { state: "failed", timedOut: false, cause };
  } finally {
    clearTimeout(timer);
  }
}

/** How much of a failure a host stores. Enough to read, and a runaway message stays here. */
const MAX_ERROR_CHARS = 1024;

/** A value shorter than this is too likely a word ("true", "prod") to take out of a sentence. */
const MIN_REDACTED_CHARS = 6;

const REDACTED = "[redacted]";

/** `text` with every value of `env` taken out, longest first so a value holding another goes whole. */
function redact(text: string, env: NodeJS.ProcessEnv): string {
  const values = Object.values(env)
    .filter((value): value is string => value !== undefined && value.length >= MIN_REDACTED_CHARS)
    .sort((left, right) => right.length - left.length);
  return values.reduce((redacted, value) => redacted.split(value).join(REDACTED), text);
}

/** The words of what a hook threw. Only an `Error` or a string has any: an object could hold anything. */
function thrownMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error && typeof cause.message === "string") return cause.message;
  return `the hook threw ${cause === null ? "null" : `a value of type ${typeof cause}`}, not an Error`;
}

/** What a host may read of `cause`: one message, no stack, no environment value, bounded. */
export function hookErrorMessage(cause: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let message: string;
  try {
    message = thrownMessage(cause);
  } catch {
    // KEEP-JUSTIFIED: a `message` getter that throws has no words to report; the run still fails.
    message = "the hook threw a value that cannot be read";
  }
  // A message can carry a stack of its own: `new Error(inner.stack)`.
  const [withoutStack = ""] = message.split(/\n\s*at\s/, 1);
  const redacted = redact(withoutStack, env).trim();
  return redacted === "" ? "the hook failed with no message" : redacted.slice(0, MAX_ERROR_CHARS);
}

/** How a start was answered. The server maps each failure code to an HTTP status. */
export type HookStartOutcome =
  | { ok: true; runId: string }
  | { ok: false; code: Extract<ErrorCode, "hook_not_declared" | "invalid_request" | "runner_draining">; detail: string };

export interface HookRunsOptions {
  /** The hooks this build declares. */
  hooks: AgentHooks;
  log?: (message: string) => void;
  /** What `error.message` must not carry. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
}

interface Run {
  status: HookRunStatus;
  /** Resolves once `status` is final. */
  finished: Promise<void>;
  /** Fails a run still in progress, from outside its own promise. */
  fail: (cause: unknown) => void;
}

/** Finished runs kept for their status and for idempotence, oldest dropped first: a runner a host
 * reuses must not grow without end. A run still in progress is never dropped. */
const MAX_FINISHED_RUNS = 1024;

export class HookRuns {
  readonly #hooks: AgentHooks;
  readonly #log: (message: string) => void;
  readonly #env: NodeJS.ProcessEnv;
  readonly #runs = new Map<string, Run>();
  #draining = false;

  constructor(options: HookRunsOptions) {
    this.#hooks = options.hooks;
    this.#log = options.log ?? ((message) => console.error(message));
    this.#env = options.env ?? process.env;
  }

  /** Starts one run, or says why it will not. A run id this runner holds starts nothing. */
  start(name: HookName, request: HookRunRequest): HookStartOutcome {
    const { runId, event, deadlineMs } = request;
    if (this.#runs.has(runId)) return { ok: true, runId };
    const hook = this.#hooks[name];
    if (hook === undefined) {
      return { ok: false, code: "hook_not_declared", detail: `this build declares no ${name}` };
    }
    const expected = HOOK_EVENT_TYPES[name];
    if (event.type !== expected) {
      return { ok: false, code: "invalid_request", detail: `${name} receives ${expected}, not ${event.type}` };
    }
    if (this.#draining) {
      return { ok: false, code: "runner_draining", detail: "this runner is draining; run the hook on another" };
    }

    const label = `hook ${name} (run ${runId})`;
    const status: HookRunStatus = { runId, state: "running" };
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const end = (outcome: HookOutcome): void => {
      if (status.state !== "running") return;
      if (outcome.state === "succeeded") {
        status.state = "succeeded";
      } else {
        status.state = "failed";
        status.error = {
          message: outcome.timedOut ? HOOK_TIMEOUT_MESSAGE : hookErrorMessage(outcome.cause, this.#env),
        };
        this.#log(`curb: ${label} failed: ${outcome.timedOut ? HOOK_TIMEOUT_MESSAGE : this.#stackOf(outcome.cause)}`);
      }
      settle();
      this.#forgetFinished();
    };
    this.#runs.set(runId, {
      status,
      finished,
      fail: (cause) => end({ state: "failed", timedOut: false, cause }),
    });
    const onLate = (cause: unknown): void => {
      const how = cause === undefined ? "finished" : `failed: ${this.#stackOf(cause)}`;
      this.#log(`curb: ${label} ${how} after its deadline`);
    };
    void invokeHook(hook, event, deadlineMs, onLate).then(end);
    return { ok: true, runId };
  }

  /** A copy of how a run stands; null when this runner holds no such run. */
  status(runId: string): HookRunStatus | null {
    const run = this.#runs.get(runId);
    return run === undefined ? null : { ...run.status };
  }

  /** Runs still in progress. */
  get running(): number {
    return [...this.#runs.values()].filter((run) => run.status.state === "running").length;
  }

  /** Refuse new runs. Those in progress go on until they end or reach their deadline. */
  drain(): void {
    this.#draining = true;
  }

  /** Resolves once no run is in progress. */
  async settled(): Promise<void> {
    await Promise.all([...this.#runs.values()].map((run) => run.finished));
  }

  /**
   * Keep a failure no hook's promise reports from ending the process, and fail the runs in
   * progress with it: Node cannot say whose it was, and a host running a hook again is what a
   * failed run costs, while a hook that lost work and read `succeeded` would cost the work.
   * Returns what removes the guard.
   */
  guardProcess(target: Pick<NodeJS.Process, "on" | "off"> = process): () => void {
    const onFailure = (cause: unknown): void => {
      // KEEP-JUSTIFIED: this runner runs customer code by design, so a stray failure is logged and
      // fails the runs in progress instead of taking the process down with them.
      this.#log(`curb: a failure outside any hook's promise: ${this.#stackOf(cause)}`);
      for (const run of this.#runs.values()) run.fail(cause);
    };
    target.on("uncaughtException", onFailure);
    target.on("unhandledRejection", onFailure);
    return () => {
      target.off("uncaughtException", onFailure);
      target.off("unhandledRejection", onFailure);
    };
  }

  /** `cause` for this runner's own log: the stack when there is one, with the environment out. */
  #stackOf(cause: unknown): string {
    if (cause instanceof Error && typeof cause.stack === "string") return redact(cause.stack, this.#env);
    return hookErrorMessage(cause, this.#env);
  }

  #forgetFinished(): void {
    const finished = [...this.#runs].filter(([, run]) => run.status.state !== "running");
    for (const [runId] of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RUNS))) {
      this.#runs.delete(runId);
    }
  }
}
