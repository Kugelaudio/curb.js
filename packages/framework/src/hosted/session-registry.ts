import { createCallReporter, type HostedCallReporter } from "./call-reporter.js";
import type { EventJournal } from "./event-journal.js";
import { MessageRefusedError, type MessageIssue, type MessageRefusalCode } from "../messages.js";
import {
  SettingsRefusedError,
  type EffectiveSettings,
  type SettingsRefusalCode,
} from "../settings-update.js";
import {
  PROTOCOL_VERSION,
  type CallState,
  type ErrorCode,
  type HostMessage,
  type LiveCall,
  type RunnerRole,
  type RunnerStatus,
  type StartCallRequest,
} from "./protocol.js";

/**
 * The calls this runner is serving: an id to each live call, so one can be started,
 * inspected and ended without touching the others.
 *
 * NO HTTP HERE. The registry is the state machine and the management server is one way to
 * reach it, so capacity, idempotence and generation rules are testable without a port.
 *
 * EVERY CALL IS INDEPENDENT: its own reporter, producer name and sequence. Only the journal
 * is shared, because a host reads a runner over one stream.
 *
 * TWO WAYS A CALL ARRIVES. A managed runner is handed calls by the host (`start`, needs
 * `startCall`). A LiveKit worker or `curb dev` is handed calls by LiveKit dispatch or the
 * preview, and registers each one it runs (`adopt`): the host can then inspect, message,
 * adjust and end it, but never place one there.
 */

export type { CallState, LiveCall, RunnerStatus };

/** What this runner is, fixed for its whole life. */
export interface RunnerIdentity {
  deploymentId?: string;
  /**
   * The configuration this runner was started with. A call pinned to another version must
   * go to another runner: this one's environment was set once, at start.
   */
  configurationVersion?: number;
  /** How many calls this runner may serve at once. */
  maxSessions: number;
  /** Set on a hook runner. Absent means a runner of calls. */
  role?: RunnerRole;
}

/** What the host sends to start one call. */
export type StartCallSpec = StartCallRequest;

/** How a start was answered. The server maps each failure code to an HTTP status. */
export type StartOutcome =
  | { ok: true; accepted: true; sessionId: string }
  /** Idempotent repeat: the ORIGINAL acceptance, never a second call into one room. */
  | { ok: true; accepted: false; sessionId: string }
  | {
      ok: false;
      code: Extract<
        ErrorCode,
        "runner_at_capacity" | "runner_draining" | "generation_mismatch" | "start_failed"
      >;
      detail: string;
    };

/** How a settings change was answered. The server maps each failure code to an HTTP status. */
export type UpdateOutcome =
  | { ok: true; settings: EffectiveSettings }
  | {
      ok: false;
      code: Extract<ErrorCode, "session_not_found"> | SettingsRefusalCode;
      detail: string;
      /** On `not_adjustable`: the first path the host may not change. */
      path?: string;
      /** On `invalid_settings`: what is wrong with the update. */
      issues?: MessageIssue[];
    };

/** How a host message was answered. The server maps each failure code to an HTTP status. */
export type DeliverOutcome =
  /** `delivered: false` is a repeat of an id this call already took. */
  | { ok: true; delivered: boolean }
  | {
      ok: false;
      code: Extract<ErrorCode, "session_not_found" | "runner_at_capacity"> | MessageRefusalCode;
      detail: string;
      /** On `invalid_payload`: what the agent's schema refused. */
      issues?: MessageIssue[];
    };

/**
 * How many host messages a call still `starting` holds for delivery once it connects.
 * Bounded so a host that floods a call that never connects cannot grow the heap.
 */
export const MAX_QUEUED_HOST_MESSAGES = 32;

/** One running call, as the registry drives it. */
export interface CallHandle {
  /** Resolves when the call is over. */
  ended: Promise<void>;
  /**
   * Hands one host message to the call's agent. Resolves once its handlers settled; rejects
   * with {@link MessageRefusedError} when the agent refused it.
   */
  deliver(message: HostMessage): Promise<void>;
  /**
   * Applies one settings change from the host. Resolves with the effective settings; rejects
   * with {@link SettingsRefusedError} when the agent refused it (nothing changed then).
   */
  update(body: unknown): Promise<EffectiveSettings>;
  /**
   * Ends it. `reason` reaches the agent so it can close properly; `graceMs` is how long the
   * agent may take to finish what it is saying before it leaves the room.
   */
  close(reason: string, graceMs: number): Promise<void>;
}

/** Starts one call. Injected so the registry is testable without a realtime server. */
export type CallStarter = (
  spec: StartCallSpec,
  reporter: HostedCallReporter,
) => Promise<CallHandle>;

/** A call LiveKit placed on this process, registered so the host can reach it. */
export interface AdoptedCall {
  /** This call's reporter. Hand it to the voice session so its records reach the journal. */
  reporter: HostedCallReporter;
  /** The call is live; the registry serves it through `handle` until `handle.ended`. */
  connected(handle: CallHandle): void;
  /** The call never started. Frees the entry. */
  failed(error: unknown): void;
}

export interface SessionRegistryOptions {
  /** What this runner is. Only a `managed` runner reports it. */
  identity?: RunnerIdentity;
  /**
   * Starts a call the host placed with `POST /v1/sessions`. Absent means this process takes
   * no calls over the wire (a LiveKit worker, `curb dev`): calls are `adopt`ed instead.
   */
  startCall?: CallStarter;
  /** The runner journal each call reports into. Absent means calls keep no record. */
  journal?: EventJournal;
  now?: () => number;
  log?: (message: string) => void;
  /** Warnings, such as a queued host message the agent refused after it was accepted. */
  warn?: (message: string) => void;
  /** Injected so a test need not build a real reporter. */
  makeReporter?: (sessionId: string) => HostedCallReporter;
  /** Called once, on the first `drain()`, with the number of calls still live. */
  onDrain?: (active: number) => void;
}

interface Entry {
  sessionId: string;
  state: CallState;
  startedAtMs: number;
  handle: CallHandle | null;
  reporter: HostedCallReporter;
  /** Set by `stop()`. A call stopped while `starting` is closed with this once it connects. */
  stopRequest: { reason: string; graceMs: number } | null;
  /** Host message ids this call has taken, for idempotent delivery. */
  messageIds: Set<string>;
  /** Host messages that arrived while the call was `starting`, delivered once it connects. */
  queued: HostMessage[];
  /** Resolves with the handle once connected, or null when the call never connected. */
  connected: Promise<CallHandle | null>;
  markConnected: (handle: CallHandle | null) => void;
  /** Resolves once the call has left the registry, however it ended. */
  retired: Promise<void>;
  markRetired: () => void;
}

export class SessionRegistry {
  readonly #identity: RunnerIdentity;
  readonly #startCall: CallStarter | undefined;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #warn: (message: string) => void;
  readonly #makeReporter: (sessionId: string) => HostedCallReporter;
  readonly #onDrain: ((active: number) => void) | undefined;
  readonly #calls = new Map<string, Entry>();
  #draining = false;
  readonly #drained: Promise<void>;
  #markDrained!: () => void;

  constructor(options: SessionRegistryOptions) {
    this.#identity = { maxSessions: 1, ...options.identity };
    this.#startCall = options.startCall;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? ((message) => console.error(message));
    this.#warn = options.warn ?? ((message) => console.warn(message));
    this.#onDrain = options.onDrain;
    this.#makeReporter =
      options.makeReporter ??
      // The session id is the PRODUCER, which keeps two calls in one process from sharing
      // a sequence space.
      ((sessionId) => createCallReporter({ journal: options.journal, producer: sessionId }));
    this.#drained = new Promise<void>((resolve) => {
      this.#markDrained = resolve;
    });
  }

  /** True when the host may place calls here (`POST /v1/sessions`). */
  get placesCalls(): boolean {
    return this.#startCall !== undefined;
  }

  /**
   * True when a host owns this runner's life (`GET /v1/runner`, `POST /v1/runner/drain`): one
   * it places calls on, and a hook runner, which takes none.
   */
  get managed(): boolean {
    return this.placesCalls || this.#identity.role === "hooks";
  }

  status(): RunnerStatus {
    const mine = this.#identity;
    return {
      protocolVersion: PROTOCOL_VERSION,
      ...(mine.deploymentId === undefined ? {} : { deploymentId: mine.deploymentId }),
      ...(mine.configurationVersion === undefined
        ? {}
        : { configurationVersion: mine.configurationVersion }),
      maxSessions: mine.maxSessions,
      activeSessions: this.#calls.size,
      draining: this.#draining,
      sessions: this.list(),
      ...(mine.role === undefined ? {} : { role: mine.role }),
    };
  }

  list(): LiveCall[] {
    return [...this.#calls.values()].map(liveCall);
  }

  get(sessionId: string): LiveCall | null {
    const entry = this.#calls.get(sessionId);
    return entry === undefined ? null : liveCall(entry);
  }

  /**
   * Starts one call, or says why it will not.
   *
   * The order of the checks is the contract. Idempotence is FIRST: a host retries, and a
   * retry of a call this runner already holds must get that acceptance back rather than a
   * refusal because the runner filled up or began draining in between.
   *
   * A call stopped while it was still `starting` is closed as soon as it connects and
   * answered `start_failed`: it must never be reported as running.
   */
  async start(spec: StartCallSpec): Promise<StartOutcome> {
    if (this.#calls.has(spec.sessionId)) {
      return { ok: true, accepted: false, sessionId: spec.sessionId };
    }
    if (this.#draining) {
      return {
        ok: false,
        code: "runner_draining",
        detail: "this runner is retiring and accepts no new calls",
      };
    }
    const mismatch = this.#generationMismatch(spec);
    if (mismatch !== null) {
      return { ok: false, code: "generation_mismatch", detail: mismatch };
    }
    if (this.#calls.size >= this.#identity.maxSessions) {
      return {
        ok: false,
        code: "runner_at_capacity",
        detail: `this runner serves ${this.#identity.maxSessions} call(s) at once and is full`,
      };
    }

    const startCall = this.#startCall;
    if (startCall === undefined) {
      return { ok: false, code: "start_failed", detail: "this process takes no calls over the wire" };
    }

    // Registered BEFORE the await, so a retry that arrives while this one is still
    // connecting is answered as a repeat, and the slot is held until the call is gone.
    const entry = this.#open(spec.sessionId);

    let handle: CallHandle;
    try {
      handle = await startCall(spec, entry.reporter);
    } catch (error) {
      // It never started, so it holds no slot.
      const detail = describe(error);
      this.#log(`curb: call ${spec.sessionId} did not start: ${detail}`);
      await this.#retire(entry, entry.stopRequest?.reason ?? "failed");
      return { ok: false, code: "start_failed", detail };
    }

    if (!(await this.#connect(entry, handle))) {
      return { ok: false, code: "start_failed", detail: "stopped while starting" };
    }
    return { ok: true, accepted: true, sessionId: spec.sessionId };
  }

  /**
   * Registers a call this process was handed by LiveKit, not by the host. It skips the
   * placement rules (capacity, draining, generation): LiveKit already placed it.
   *
   * Throws when a call with this id is already registered; the second call then runs
   * without being reachable over the management port.
   */
  adopt(sessionId: string): AdoptedCall {
    if (this.#calls.has(sessionId)) {
      throw new Error(`a call with session id ${sessionId} is already registered on this process`);
    }
    const entry = this.#open(sessionId);
    return {
      reporter: entry.reporter,
      connected: (handle) => void this.#connect(entry, handle),
      failed: (error) => {
        this.#log(`curb: call ${sessionId} did not start: ${describe(error)}`);
        void this.#retire(entry, entry.stopRequest?.reason ?? "failed");
      },
    };
  }

  /** A fresh `starting` entry, registered at once. */
  #open(sessionId: string): Entry {
    let markRetired!: () => void;
    let markConnected!: (handle: CallHandle | null) => void;
    const entry: Entry = {
      sessionId,
      state: "starting",
      startedAtMs: this.#now(),
      handle: null,
      reporter: this.#makeReporter(sessionId),
      stopRequest: null,
      messageIds: new Set(),
      queued: [],
      connected: new Promise<CallHandle | null>((resolve) => {
        markConnected = resolve;
      }),
      markConnected: (handle) => markConnected(handle),
      retired: new Promise<void>((resolve) => {
        markRetired = resolve;
      }),
      markRetired: () => markRetired(),
    };
    this.#calls.set(sessionId, entry);
    return entry;
  }

  /**
   * The call connected. Returns false when it was stopped while starting: it is closed then
   * and must never be reported as running.
   */
  async #connect(entry: Entry, handle: CallHandle): Promise<boolean> {
    if (entry.stopRequest !== null || this.#calls.get(entry.sessionId) !== entry) {
      const { reason, graceMs } = entry.stopRequest ?? { reason: "stopped", graceMs: 0 };
      await this.#close(entry, handle, reason, graceMs);
      await this.#retire(entry, reason);
      return false;
    }

    entry.handle = handle;
    entry.state = "connected";
    entry.markConnected(handle);
    this.#deliverQueued(entry, handle);
    // The call runs on its own from here. Whatever ends it lands in one place.
    void handle.ended
      .catch((error: unknown) => {
        // ONE CALL'S FAILURE, not the runner's. A rejection escaping here would reach the
        // process and take every other call down with it.
        this.#log(`curb: call ${entry.sessionId} ended with an error: ${describe(error)}`);
      })
      .finally(() => {
        void this.#retire(entry, entry.stopRequest?.reason ?? "completed");
      });
    return true;
  }

  /**
   * Applies one settings change from the host. A call still `starting` is changed once it
   * connects; one that ends first answers `session_not_found`.
   */
  async update(sessionId: string, body: unknown): Promise<UpdateOutcome> {
    const entry = this.#calls.get(sessionId);
    const handle = entry === undefined ? null : (entry.handle ?? (await entry.connected));
    if (handle === null) {
      return { ok: false, code: "session_not_found", detail: `no such call: ${sessionId}` };
    }
    try {
      return { ok: true, settings: await handle.update(body) };
    } catch (error) {
      if (!(error instanceof SettingsRefusedError)) throw error;
      return {
        ok: false,
        code: error.code,
        detail: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.issues === undefined ? {} : { issues: error.issues }),
      };
    }
  }

  /**
   * Hands one host message to a call. Idempotent by `message.id` per call.
   *
   * A connected call answers once the agent's handlers settled: a refusal (`no_handler`,
   * `invalid_payload`, `handler_failed`) comes back as the outcome, and its id is not kept,
   * so a corrected retry with the same id is delivered.
   *
   * A call still `starting` holds up to {@link MAX_QUEUED_HOST_MESSAGES} and delivers them
   * once it connects; past that the message is refused, not dropped, so the host can retry.
   * A queued message is accepted before any handler sees it, so a refusal at delivery is
   * warned about and counted in the call's record (`curb.messages`) instead.
   */
  async deliver(sessionId: string, message: HostMessage): Promise<DeliverOutcome> {
    const entry = this.#calls.get(sessionId);
    if (entry === undefined) {
      return { ok: false, code: "session_not_found", detail: `no such call: ${sessionId}` };
    }
    if (entry.messageIds.has(message.id)) return { ok: true, delivered: false };
    if (entry.handle === null) {
      if (entry.queued.length >= MAX_QUEUED_HOST_MESSAGES) {
        return {
          ok: false,
          code: "runner_at_capacity",
          detail:
            `call ${sessionId} is still starting and already holds ` +
            `${MAX_QUEUED_HOST_MESSAGES} undelivered host messages; retry once it is connected`,
        };
      }
      entry.messageIds.add(message.id);
      entry.queued.push(message);
      return { ok: true, delivered: true };
    }
    entry.messageIds.add(message.id);
    const refusal = await this.#handOver(entry, entry.handle, message);
    if (refusal === null) return { ok: true, delivered: true };
    return {
      ok: false,
      code: refusal.code,
      detail: refusal.message,
      ...(refusal.issues === undefined ? {} : { issues: refusal.issues }),
    };
  }

  #deliverQueued(entry: Entry, handle: CallHandle): void {
    for (const message of entry.queued.splice(0)) {
      // Started in order, each without waiting for the one before: the HTTP answer for
      // these was already sent, so nothing waits on them.
      void this.#handOver(entry, handle, message).then((refusal) => {
        if (refusal === null) return;
        entry.reporter.count({ refusedQueuedHostMessages: 1 });
        this.#warn(
          `curb: queued host message ${message.id} (${message.name}) to call ` +
            `${entry.sessionId} was refused once the call connected: ${refusal.message}`,
        );
      });
    }
  }

  /** Null when the agent took it. Never rejects: a failure is ONE MESSAGE'S, not the call's. */
  async #handOver(
    entry: Entry,
    handle: CallHandle,
    message: HostMessage,
  ): Promise<MessageRefusedError | null> {
    try {
      await handle.deliver(message);
      return null;
    } catch (error) {
      entry.messageIds.delete(message.id);
      if (error instanceof MessageRefusedError) return error;
      // Not a refusal: the transport itself broke. Logged with its cause, and answered as
      // handler_failed so the host still gets a code.
      this.#log(
        `curb: host message ${message.id} (${message.name}) to call ${entry.sessionId} ` +
          `failed: ${describe(error)}`,
      );
      return new MessageRefusedError(
        "handler_failed",
        { key: message.name, from: "host" },
        `delivering "${message.name}" failed: ${describe(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Ends one call and resolves once it has left the registry. Absent is success: a stop is
   * retried, and a second must not be an error.
   */
  async stop(sessionId: string, reason: string, graceMs = 0): Promise<boolean> {
    const entry = this.#calls.get(sessionId);
    if (entry === undefined) return false;
    if (entry.stopRequest === null) {
      entry.stopRequest = { reason, graceMs };
      entry.state = "ending";
      // Still `starting`: `start()` closes it once it connects, so it is closed exactly once.
      if (entry.handle !== null) {
        await this.#close(entry, entry.handle, reason, graceMs);
        await this.#retire(entry, reason);
      }
    }
    await entry.retired;
    return true;
  }

  /**
   * Stop accepting calls. Resolves once the last call has ended; every call to it returns
   * the same promise.
   *
   * Draining never touches a running call: it retires a runner without dropping the
   * conversations it is still serving.
   */
  drain(): Promise<void> {
    if (!this.#draining) {
      this.#draining = true;
      this.#onDrain?.(this.#calls.size);
      this.#settleDrain();
    }
    return this.#drained;
  }

  /** Resolves once a drain, however requested, has emptied the runner. */
  get drained(): Promise<void> {
    return this.#drained;
  }

  get draining(): boolean {
    return this.#draining;
  }

  async #close(entry: Entry, handle: CallHandle, reason: string, graceMs: number): Promise<void> {
    try {
      await handle.close(reason, graceMs);
    } catch (error) {
      this.#log(`curb: call ${entry.sessionId} did not close cleanly: ${describe(error)}`);
    }
  }

  async #retire(entry: Entry, reason: string): Promise<void> {
    if (this.#calls.get(entry.sessionId) !== entry) return;
    this.#calls.delete(entry.sessionId);
    entry.state = "ended";
    entry.markConnected(null);
    // Flushed here, so a call that ended by ANY route still reports that it ended.
    await entry.reporter.finish(reason).catch(() => {});
    entry.markRetired();
    this.#settleDrain();
  }

  #settleDrain(): void {
    if (this.#draining && this.#calls.size === 0) this.#markDrained();
  }

  /**
   * Null when this runner may serve the call, a reason when it may not.
   *
   * A generation is `(deploymentId, configurationVersion)`. Versions are counted per
   * deployment, so the version alone would admit a call meant for another deployment.
   * A dimension is compared only when BOTH sides state it: the host pins calls, and
   * silence on either side is not a mismatch.
   */
  #generationMismatch(spec: StartCallSpec): string | null {
    const mine = this.#identity;
    if (
      spec.deploymentId !== undefined &&
      mine.deploymentId !== undefined &&
      spec.deploymentId !== mine.deploymentId
    ) {
      return `this runner serves deployment ${mine.deploymentId}, the call is pinned to ${spec.deploymentId}`;
    }
    if (
      spec.configurationVersion !== undefined &&
      mine.configurationVersion !== undefined &&
      spec.configurationVersion !== mine.configurationVersion
    ) {
      return `this runner holds configurationVersion ${mine.configurationVersion}, the call is pinned to ${spec.configurationVersion}`;
    }
    return null;
  }
}

function liveCall(entry: Entry): LiveCall {
  return { sessionId: entry.sessionId, state: entry.state, startedAtMs: entry.startedAtMs };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
