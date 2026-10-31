import {
  joinRoomAndServe,
  warmVoiceRunner,
  HOSTED_MARKER,
  type DirectJoinConfig,
  type DirectJoinSession,
  type WarmVoiceRunner,
} from "./direct-join.js";
import {
  SessionRegistry,
  type CallHandle,
  type RunnerIdentity,
  type StartCallSpec,
} from "../hosted/session-registry.js";
import { startManagementServer, MANAGEMENT_ADDRESS_ENV } from "../hosted/management-server.js";
import { EventJournal } from "../hosted/event-journal.js";
import { HookRuns } from "../hosted/hook-runs.js";
import type { LifecycleBody, RunnerRole } from "../hosted/protocol.js";
import { discoverAgentFromRegistry } from "../agent-registry.node.js";
import { agentHooks, type AgentHooks } from "../hooks.js";

/**
 * Managed mode: the runner is up first and is handed calls afterwards.
 *
 * A host starts the process, then starts calls on it over the management port (the host
 * protocol in `hosted/protocol.ts`). The expensive, call-independent work (the agent bundle,
 * the VAD model, the provider plugin imports) is paid once, BEFORE the runner announces
 * `ready`, so a call pays only the room connect and the provider constructors. No realtime
 * API key or secret ever reaches this process: each call brings a room-scoped token.
 *
 * IT DOES NOT EXIT WHEN A CALL ENDS. An idle managed runner is waiting for its next call; it
 * exits once a drain has emptied it.
 *
 * A HOOK RUNNER (`CURB_RUNNER_ROLE=hooks`) is a managed runner for an agent's after-call code. It
 * pays for none of the voice work, because it holds no conversation: it loads the agent, says
 * `ready`, runs the hooks a host asks for, and refuses every call.
 */

/** How many calls this runner may serve at once. */
export const MAX_SESSIONS_VAR = "CURB_MAX_SESSIONS";
/** What this runner is, so it can refuse a call pinned to another generation. */
export const DEPLOYMENT_ID_VAR = "CURB_DEPLOYMENT_ID";
export const CONFIGURATION_VERSION_VAR = "CURB_CONFIGURATION_VERSION";
/** What this runner is for: `calls`, the same as unset, or `hooks`. */
export const RUNNER_ROLE_VAR = "CURB_RUNNER_ROLE";

export type ManagedConfig = {
  address: string;
  maxSessions: number;
  deploymentId?: string;
  configurationVersion?: number;
  /** Set on a hook runner. Absent means a runner of calls. */
  role?: RunnerRole;
};

/**
 * The role the environment states. A value that names no role throws: read as `calls`, a typo in
 * a hook runner's environment would give a runner that answers every hook with 501, and read as
 * `hooks`, a call runner that refuses every call.
 */
function readRunnerRole(env: NodeJS.ProcessEnv): RunnerRole {
  const role = env[RUNNER_ROLE_VAR]?.trim() ?? "";
  if (role === "" || role === "calls") return "calls";
  if (role === "hooks") return "hooks";
  throw new Error(`${RUNNER_ROLE_VAR}=${role} is not a runner role. Use calls or hooks, or leave it unset.`);
}

/**
 * Read when this process is managed, null when it is not.
 *
 * READ ONCE, AT BOOT, and never again: the generated entry calls this before warmup and the
 * runner keeps the result for its whole life. A runner restored from a memory snapshot
 * therefore keeps the bound it booted with; changing `CURB_MAX_SESSIONS` (or the generation)
 * in the restored environment changes nothing. Boot a new runner to change them.
 *
 * Everything here is the RUNNER's. A call's own facts (its session id, its room) come with
 * its start request, never from this environment, which is the same for every call.
 */
export function readManagedConfig(env: NodeJS.ProcessEnv = process.env): ManagedConfig | null {
  // Before the address: an unmanaged process has to refuse a bad role too.
  const role = readRunnerRole(env);
  const address = env[MANAGEMENT_ADDRESS_ENV]?.trim();
  if (!address) {
    if (role === "calls") return null;
    // Without it this process would fall through to joining a room or registering a worker, and
    // run the calls a hook runner must never take.
    throw new Error(`${RUNNER_ROLE_VAR}=hooks needs ${MANAGEMENT_ADDRESS_ENV}: a hook runner is told what to run over that port.`);
  }

  // Defaulted to 1, not "unlimited": several calls in one process share a blast radius, and
  // that should be opted into deliberately.
  const maxSessions = positiveInt(env[MAX_SESSIONS_VAR]) ?? 1;
  const configurationVersion = positiveInt(env[CONFIGURATION_VERSION_VAR]);

  return {
    address,
    maxSessions,
    ...(env[DEPLOYMENT_ID_VAR] ? { deploymentId: env[DEPLOYMENT_ID_VAR] } : {}),
    ...(configurationVersion === undefined ? {} : { configurationVersion }),
    ...(role === "hooks" ? { role } : {}),
  };
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * One machine-readable line on stdout: HOSTED_MARKER, a space, then JSON with `event` as
 * its first key. Hosts may key on the exact prefix `curb-hosted {"event":"ready"`.
 */
function emit(body: LifecycleBody): void {
  console.log(`${HOSTED_MARKER} ${JSON.stringify(body)}`);
}

/** Injected so the runner's ordering is testable without a model, an artifact or a room. */
export type ManagedRunnerDeps = {
  /** Everything call-independent and expensive, done once before `ready`. */
  warm?: () => Promise<WarmVoiceRunner>;
  join?: (config: DirectJoinConfig) => Promise<DirectJoinSession>;
  /** The hooks a hook runner serves, read once before `ready`. */
  loadHooks?: () => AgentHooks;
  journal?: EventJournal;
  /** Monotonic clock in ms, the same one the voice host reports first audio on. */
  now?: () => number;
};

function identityOf(config: ManagedConfig): RunnerIdentity {
  return {
    maxSessions: config.maxSessions,
    ...(config.deploymentId === undefined ? {} : { deploymentId: config.deploymentId }),
    ...(config.configurationVersion === undefined
      ? {}
      : { configurationVersion: config.configurationVersion }),
    ...(config.role === undefined ? {} : { role: config.role }),
  };
}

/** The hooks of the agent this artifact bundles. */
function bundledAgentHooks(): AgentHooks {
  return agentHooks(discoverAgentFromRegistry().definition);
}

/** The agent's hooks, or the reason this runner will never be ready to run them. */
function loadHookRuns(load: () => AgentHooks): HookRuns {
  try {
    return new HookRuns({ hooks: load() });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`curb: this runner will not announce ready: ${detail}`);
    throw new Error(`warmup failed before ready: ${detail}`);
  }
}

/**
 * Serves calls until a drain empties this runner, then resolves.
 *
 * Rejects BEFORE `ready` when warmup fails, which the generated entry turns into a non-zero
 * exit: a runner that said ready and then failed every call would look warm and answer
 * nobody.
 */
export async function runManaged(config: ManagedConfig, deps: ManagedRunnerDeps = {}): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const join = deps.join ?? joinRoomAndServe;

  // Started before the port opens so the two overlap. A hook runner warms nothing: no call will
  // use a voice, so none of the voice work may stand between it and its first hook.
  const warmStartedAt = now();
  const hooks = config.role === "hooks" ? loadHookRuns(deps.loadHooks ?? bundledAgentHooks) : null;
  const warming = hooks === null ? (deps.warm ?? (() => warmVoiceRunner()))() : null;
  // KEEP-JUSTIFIED: not a swallow. `warming` is awaited before `ready` and by every call;
  // this only stops a rejection that lands while the port is still opening from being
  // reported as unhandled.
  warming?.catch(() => {});

  // One journal for the whole runner: `ready` and `draining` belong to no call.
  const journal = deps.journal ?? new EventJournal();
  let lifecycleSeq = 0;
  /** On stdout AND on the stream. stdout also covers what happens before the port serves. */
  const announce = (body: LifecycleBody): void => {
    emit(body);
    lifecycleSeq += 1;
    journal.publish({
      producer: "runner",
      seq: lifecycleSeq,
      class: "lifecycle",
      at: Date.now(),
      body,
    });
  };

  let drainSignal: NodeJS.Signals | undefined;
  const registry = new SessionRegistry({
    journal,
    identity: identityOf(config),
    onDrain: (calls) => {
      hooks?.drain();
      const active = calls + (hooks?.running ?? 0);
      announce({ event: "draining", ...(drainSignal ? { signal: drainSignal } : {}), active });
    },
    startCall: warming === null ? undefined : async (spec: StartCallSpec, reporter): Promise<CallHandle> => {
      const startedAt = now();
      // A call placed before `ready` waits for warmup rather than building everything cold.
      const warm = await warming;
      let heard = false;
      // The SAME join path direct-join uses, so a call started over the port and a call
      // handed over in the environment cannot differ.
      const session = await join({
        url: spec.realtimeUrl,
        token: spec.realtimeToken,
        sessionId: spec.sessionId,
        ...(spec.clientContext === undefined ? {} : { clientContext: spec.clientContext }),
        ...(spec.direction === undefined ? {} : { direction: spec.direction }),
        ...(spec.experiments === undefined ? {} : { experiments: spec.experiments }),
        reporter,
        warm,
        onFirstAudio: (monotonicMs) => {
          if (heard) return;
          heard = true;
          // The end of the latency budget: the start request reached this runner at
          // `startedAt`, and the caller could first hear the agent at `monotonicMs`.
          announce({
            event: "first-audio",
            session: spec.sessionId,
            monotonicMs: Math.round(monotonicMs),
            sinceStartMs: Math.round(monotonicMs - startedAt),
          });
        },
      });
      announce({ event: "call-started", session: spec.sessionId, room: session.roomName });
      return {
        // Resolves only once the call's conversation recording is finished too, so the
        // registry frees the slot after that, never mid-write.
        ended: session.ended,
        // The call's own hub, so a message reaches this call's agent and no other. The host
        // protocol names a message key `name`; the origin is stamped here, by the transport.
        deliver: async (message) => {
          await session.messages.deliver("host", {
            id: message.id,
            key: message.name,
            payload: message.payload,
            ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
          });
        },
        // Live settings from the host, gated by the agent's `<Agent adjustable host={…}>`.
        update: async (body) => session.settings.update("host", body),
        // `graceMs` lets the agent finish the reply it is speaking before it leaves the room.
        close: async (reason: string, graceMs: number) => {
          announce({ event: "call-stopping", session: spec.sessionId, reason });
          await session.handle.close({ graceMs });
          // A stop frees the slot when this resolves, so it waits for the call's own end:
          // the recording finished and the scratch directory removed. Without it the next
          // call could start while this one's teardown is still running.
          await session.ended;
        },
      };
    },
  });

  const server = await startManagementServer(registry, {
    address: config.address,
    journal,
    ...(hooks === null ? {} : { hooks }),
  });
  if (server === null) {
    // Without it no call can ever be started, so this runner would sit idle looking healthy.
    throw new Error(
      `could not open the management port at ${config.address}, so this runner can ` +
        `never be given a call.`,
    );
  }

  try {
    await warming;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`curb: this runner will not announce ready: ${detail}`);
    await server.close();
    throw new Error(`warmup failed before ready: ${detail}`);
  }

  announce({
    event: "ready",
    address: server.address,
    maxSessions: config.maxSessions,
    warmupMs: Math.round(now() - warmStartedAt),
  });

  // Held open explicitly: nothing else keeps the loop alive between one call and the next.
  const idle = setInterval(() => {}, 60_000);
  // From here customer code runs, and what it leaves behind must not end the process.
  const removeGuard = hooks?.guardProcess();

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      console.error(`curb: ${signal} received again while draining; exiting now.`);
      process.exit(1);
    }
    stopping = true;
    drainSignal = signal;
    // A signal drains rather than kills: the calls in progress have people in them.
    void registry.drain();
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
    const handler = () => onSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  // A signal or `POST /v1/runner/drain`, whichever comes first.
  await registry.drained;
  // No call is left, and a hook is not a call: a drained hook runner still waits for its runs.
  await hooks?.settled();

  removeGuard?.();
  clearInterval(idle);
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  // Announced BEFORE the listener closes, so a follower receives the terminal record and
  // then EOF. EOF without it is how a host tells a cut stream from a finished one.
  announce({ event: "ended", reason: "drained" });
  await server.close();
}
