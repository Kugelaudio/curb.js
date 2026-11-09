/**
 * Direct-join mode: the artifact serves ONE call in a room it was handed.
 *
 * This module runs INSIDE the artifact, like render-check.ts. It is the hosted
 * counterpart of the worker/dispatch path the generated entry takes otherwise, and it
 * exists because a hosted platform has already done the dispatching: it created the room,
 * minted the agent a token, and started exactly one runner for exactly one session.
 * Registering a worker pool there re-does that work, and -- the part that matters -- a
 * worker pool can only be registered with the LiveKit API KEY and SECRET, which are the
 * platform's credentials for every room it will ever create. Agent code must never hold
 * them; it gets a short-lived, room-scoped token instead.
 *
 * That is why those two variables are DELETED from the environment here rather than
 * merely left unread: "we do not read them" is a property of code that any later import,
 * plugin, or dependency can quietly break, while an absent variable cannot be read by
 * anything at all.
 *
 * The seam itself is the one `curb dev` uses every day (`server/main.ts`): connect a Room
 * with a URL and a token, then hand it to the framework's voice host.
 * `startLivekitVoiceAgent` takes a connected room and does not care how it was obtained.
 */

import type { VAD } from "@livekit/agents";
import { Room } from "@livekit/rtc-node";
import type { AgentSession } from "../agent-session.js";
import { experimentInfo } from "../experiments.js";
import { detachConversationRecorder } from "../server/conversation-store.js";
import {
  loadSileroVad,
  startLivekitVoiceAgent,
  startVoiceAgent,
  type LivekitVoiceStartOptions,
} from "../server/voice/livekit-host/host.js";
import { isRelayUrl } from "../relay-wire.js";
import { openRelayCall, type RelayCall } from "../server/voice/relay-host/relay-call-room.js";
import {
  buildVoiceProviders,
  preloadVoicePlugins,
  type VoiceProviders,
  type VoiceProviderSettings,
} from "../server/voice/providers.js";
import type { VoiceSessionHandle } from "../server/voice/orchestration.js";
import {
  createVoiceAgentBundle,
  createWarmAgentBundle,
  readyForCall,
  type VoiceAgentBundle,
} from "../voice-host.js";
import { createCallReporter, recordClientTraffic, type HostedCallReporter } from "../hosted/call-reporter.js";
import { attachClientMessages } from "../server/voice/livekit-host/messages.js";
import type { AppMessages } from "../messages.js";
import type { SessionSettings } from "../session-settings.js";
import { EventJournal } from "../hosted/event-journal.js";
import { MANAGEMENT_ADDRESS_ENV, startManagementServer } from "../hosted/management-server.js";
import { openCallScratch } from "../hosted/call-scratch.js";
import type { CallDirection } from "../hosted/protocol.js";

/** Prefix of every machine-readable line this mode prints, one JSON object per line. */
export const HOSTED_MARKER = "curb-hosted";

/** The room-scoped capability the platform hands the runner. Both, or neither. */
export const REALTIME_URL_VAR = "CURB_REALTIME_URL";
export const REALTIME_TOKEN_VAR = "CURB_REALTIME_TOKEN";
/** Fallback room name, for a server that reports none back. */
export const SESSION_ID_VAR = "CURB_SESSION_ID";

/**
 * Platform-wide credentials. Direct-join mode removes them from the environment before
 * it does anything else; see the module comment.
 */
export const PLATFORM_CREDENTIAL_VARS = ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];

export type DirectJoinConfig = {
  url: string;
  token: string;
  /**
   * The host's id for this call: the start request's `sessionId` on a managed runner,
   * CURB_SESSION_ID on a direct join. The call's agent reads it as `useSession().call`, and
   * it is the room name only when the server reports none.
   */
  sessionId?: string;
  /**
   * This call's reporter, built by the caller from the environment.
   *
   * Passed rather than constructed here so the same join path serves a runner that was
   * handed one call at start and a runner that is handed several over its management
   * interface: each call brings its own reporter.
   */
  reporter?: HostedCallReporter;
  /**
   * What a managed runner built before it said `ready`. Absent on the cold direct-join
   * path, which then connects and builds in the order it always has.
   */
  warm?: WarmVoiceRunner;
  /** Called once, on the monotonic clock, when the first agent audio frame is published. */
  onFirstAudio?: (monotonicMs: number) => void;
  /**
   * What the caller's page said about this call, the start request's `clientContext`. The
   * agent reads each entry as `client.<key>` (`clientContextInfo`), set before the session
   * starts. Forgeable text: never an identity or a permission.
   */
  clientContext?: Readonly<Record<string, string>>;
  /**
   * Who placed the call, the start request's `direction`. The agent reads it as
   * `call.direction`, set before the session starts; absent means inbound (a direct join's
   * environment carries none).
   */
  direction?: CallDirection;
  /**
   * The variant the host assigned this call in each of the agent's experiments, the start
   * request's `experiments`. The agent reads each as `experiment.<name>` (`useVariant`), set
   * before the session starts with the client context. Trusted: the host assigned it.
   */
  experiments?: Readonly<Record<string, string>>;
};

/**
 * The agent's info for a call's client context: `{ event: "x" }` becomes
 * `{ "client.event": "x" }`. The `client.` namespace says at every read that a browser wrote
 * it (forgeable), the way `caller.*` is the room's and `call.*` LiveKit's.
 */
export function clientContextInfo(
  context: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const info: Record<string, string> = {};
  for (const [key, value] of Object.entries(context ?? {})) info[`client.${key}`] = value;
  return info;
}

/**
 * Everything expensive about a call that does not depend on WHICH call: the agent bundle,
 * the VAD model and the provider plugin imports.
 *
 * Built once by {@link warmVoiceRunner} before a managed runner announces `ready`, so a
 * call placed on it pays a room connect and two provider constructors, not a cold start.
 */
export type WarmVoiceRunner = {
  /** The authored agent: its first turn is known before any call. */
  readonly definition: VoiceAgentBundle["definition"];
  /** The speech providers the warm bundle rendered with. A call builds these alongside its
   * room connect; if its own conversation renders others, the call swaps at once. Null for an
   * `<Agent s2s>`: its model hears and speaks, so a call builds no speech provider. */
  readonly settings: VoiceProviderSettings | null;
  /** Shared by every call. Each session opens its own stream on it. */
  readonly vad: VAD;
  /**
   * A bundle for one call. The first call gets the one built during warmup.
   *
   * A bundle is one conversation's runtime and transcript, so it is never handed out twice:
   * a later call on the same runner builds its own.
   */
  takeBundle(): Promise<VoiceAgentBundle>;
};

/** The warmup steps. Injected so a test need not load a model or an artifact. */
export type WarmupSteps = {
  env?: NodeJS.ProcessEnv;
  /** A call's bundle when no warm one is left; checks the LLM key. */
  createBundle?: () => Promise<VoiceAgentBundle>;
  /** The bundle built during warmup, before any key is there; the first call takes it. */
  createWarmBundle?: () => Promise<VoiceAgentBundle>;
  /** Checks a warm bundle's LLM key when a call takes it. */
  readyForCall?: (bundle: VoiceAgentBundle) => Promise<VoiceAgentBundle>;
  loadVad?: () => Promise<VAD>;
  preloadPlugins?: (settings: VoiceProviderSettings, env: NodeJS.ProcessEnv) => Promise<void>;
};

/**
 * Do the expensive, call-independent work once. Rejects, naming the step, if any fails.
 *
 * Opens no connection that needs a call: the room token and URL only arrive with the call,
 * and the provider constructors (which may dial their vendor) run per call.
 */
export async function warmVoiceRunner(steps: WarmupSteps = {}): Promise<WarmVoiceRunner> {
  const env = steps.env ?? process.env;
  const createBundle = steps.createBundle ?? (() => createVoiceAgentBundle());
  const createWarmBundle = steps.createWarmBundle ?? steps.createBundle ?? (() => createWarmAgentBundle());
  const ready = steps.readyForCall ?? readyForCall;
  const loadVad = steps.loadVad ?? loadSileroVad;
  const preloadPlugins =
    steps.preloadPlugins ??
    ((settings: VoiceProviderSettings, target: NodeJS.ProcessEnv) =>
      preloadVoicePlugins(settings, { env: target }));

  const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`warmup could not ${what}: ${detail}`);
    }
  };
  // The plugins to import are the ones the agent renders with, so they follow the bundle.
  const [bundle, vad] = await Promise.all([
    step("build the agent from this artifact", createWarmBundle).then(async (built) => {
      if (!built.runtime.settings.s2s()) {
        await step("import the selected voice provider plugins", () =>
          preloadPlugins(built.runtime.settings.current(), env),
        );
      }
      return built;
    }),
    step("load the Silero VAD model", loadVad),
  ]);
  const { stt, tts } = bundle.runtime.settings.current();

  let spare: VoiceAgentBundle | null = bundle;
  return {
    definition: bundle.definition,
    settings: bundle.runtime.settings.s2s() ? null : { stt, tts },
    vad,
    takeBundle: async () => {
      if (spare === null) return createBundle();
      const taken = spare;
      spare = null;
      return ready(taken);
    },
  };
}

/**
 * Seams for the join, so its ordering and its recording end are testable without LiveKit.
 * A room and a real voice pipeline are the parts a hermetic suite cannot own.
 */
export type JoinSeams = {
  createRoom?: () => Room;
  buildProviders?: (options: Parameters<typeof buildVoiceProviders>[0]) => Promise<VoiceProviders>;
  startVoiceAgent?: (options: LivekitVoiceStartOptions) => Promise<VoiceSessionHandle>;
  openRelayCall?: typeof openRelayCall;
  /** The cold path's bundle factory. A warm runner hands over the bundle it built instead. */
  createBundle?: () => Promise<VoiceAgentBundle>;
  /** Replaces {@link RECORDING_FINISH_TIMEOUT_MS}. */
  recordingFinishTimeoutMs?: number;
  /** Where the call's scratch directory is created. Default: the OS temp directory. */
  scratchRoot?: string;
};

/**
 * Read the direct-join configuration, or null when this deployment is not in direct-join
 * mode (both variables absent -- the worker/dispatch path is then correct and unchanged).
 *
 * Exactly one of the two is a misconfigured deployment, never a fall back to worker mode:
 * a platform that set the URL meant to hand over a room, and starting a worker pool
 * instead would need credentials it deliberately withheld -- so it would fail later,
 * further from the cause.
 */
export function readDirectJoinConfig(env: NodeJS.ProcessEnv = process.env): DirectJoinConfig | null {
  const url = env[REALTIME_URL_VAR]?.trim();
  const token = env[REALTIME_TOKEN_VAR]?.trim();
  if (!url && !token) return null;
  if (!url || !token) {
    const present = url ? REALTIME_URL_VAR : REALTIME_TOKEN_VAR;
    const missing = url ? REALTIME_TOKEN_VAR : REALTIME_URL_VAR;
    throw new Error(
      `${present} is set but ${missing} is empty or missing, so this runner has no room to join.\n` +
        `  Direct-join mode needs BOTH: ${REALTIME_URL_VAR} (the realtime server) and ` +
        `${REALTIME_TOKEN_VAR} (a join token minted for one room).\n` +
        `  Unset both to run the LiveKit worker/dispatch path instead.`,
    );
  }
  const sessionId = env[SESSION_ID_VAR]?.trim();
  return { url, token, ...(sessionId ? { sessionId } : {}) };
}

/** One line of machine-readable state, on stdout, for whatever supervises this runner. */
function emit(event: string, fields: Record<string, string | number> = {}): void {
  console.log(`${HOSTED_MARKER} ${JSON.stringify({ event, ...fields })}`);
}

/**
 * Remove the platform's LiveKit credentials from the environment.
 *
 * Returns the names that were actually present, which the caller reports: a hosted
 * deployment that ships these to agent code has a leak worth fixing even though this
 * process no longer holds them.
 */
export function scrubPlatformCredentials(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = PLATFORM_CREDENTIAL_VARS.filter((name) => env[name] !== undefined);
  for (const name of found) delete env[name];
  return found;
}

export type DirectJoinSession = {
  /** The room this process joined; null on a relayed call, whose room the relay holds. */
  room: Room | null;
  /** Leaves the call on either route. */
  connection: { disconnect(): Promise<unknown> };
  roomName: string;
  handle: VoiceSessionHandle;
  /**
   * This call's app messages. The host side is connected to the call's reporter when that
   * reporter keeps a record, so agent-to-host messages leave as `host` records;
   * host-to-agent messages are delivered here with origin `host`.
   */
  messages: AppMessages;
  /** This call's live settings: a host's `PATCH /v1/sessions/{id}` is applied here. */
  settings: SessionSettings;
  /**
   * Resolves once the call is over -- the room emptied, or the handle was closed -- AND
   * its conversation recording is finished: see `finishCallRecording`.
   */
  ended: Promise<void>;
};

/**
 * How long a finished call waits for its transcript's last sink writes.
 *
 * Bounded because curb puts no timeout on a sink call, and a hung sink would otherwise
 * hold `ended` open: a direct-join runner would never exit and a managed one would never
 * free the call's slot. The transcript is a record; the call, and the capacity behind
 * it, is the product.
 */
const RECORDING_FINISH_TIMEOUT_MS = 10_000;

/**
 * End the call's conversation recording: the sink's last retry of anything it refused
 * during the call, then an error-level report of whatever it still refuses. The same
 * thing `server/main.ts` does when a preview connection closes.
 *
 * Never rejects (the recorder owns its failures). Gives up waiting after the bound
 * above, says so, and lets the call end; the attempt carries on in the background for as
 * long as the process lives.
 */
async function finishCallRecording(session: AgentSession, roomName: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timed-out"), timeoutMs);
  });
  const outcome = await Promise.race([
    detachConversationRecorder(session).then(() => "finished" as const),
    timedOut,
  ]);
  clearTimeout(timer);
  if (outcome === "timed-out") {
    console.error(
      `curb: the conversation sink had not finished the transcript of ${roomName} ` +
        `${timeoutMs} ms after the call ended; ending the call without waiting. Its last ` +
        `messages may be missing from the store.`,
    );
  }
}

/**
 * Connect to the room and start the voice session on it.
 *
 * Every failure names the thing to fix: the artifact is started by a machine, and its
 * stderr is the only place a human will look.
 */
export async function joinRoomAndServe(
  config: DirectJoinConfig,
  seams: JoinSeams = {},
): Promise<DirectJoinSession> {
  const warm = config.warm;
  // A relay URL means the host holds the room outside this process (`../relay-wire.ts`).
  const relayed = isRelayUrl(config.url);
  const room = relayed ? null : (seams.createRoom?.() ?? new Room());
  let relay!: RelayCall;

  // WARM: the providers start connecting NOW, alongside the room. They need only the
  // environment's secrets, and a TTS socket that finishes its handshake while the room does
  // is one the greeting does not wait for. Cold paths build them after the join, and an
  // `<Agent s2s>` (no warm settings) builds none.
  const providers = warm?.settings
    ? (seams.buildProviders ?? buildVoiceProviders)({
        settings: warm.settings,
        reporter: config.reporter,
      })
    : null;
  // KEEP-JUSTIFIED: not a swallow. `providers` is awaited below or released on every
  // failure path; this only stops a rejection that lands while room.connect is still
  // pending from being reported as unhandled.
  providers?.catch(() => {});

  // Same options as the dev host (`server/main.ts`): the agent must receive the caller's
  // audio (autoSubscribe) and there is exactly one subscriber, so dynacast's
  // per-subscriber layer negotiation only adds latency.
  try {
    if (room) await room.connect(config.url, config.token, { autoSubscribe: true, dynacast: false });
    else relay = await (seams.openRelayCall ?? openRelayCall)(config.url, config.token);
  } catch (error) {
    releaseProviders(providers);
    const detail = error instanceof Error ? error.message : String(error);
    if (relayed) throw new Error(`could not start the call through the media relay at ${config.url}: ${detail}`);
    throw new Error(
      `could not join the realtime room at ${config.url}: ${detail}\n` +
        `  ${REALTIME_TOKEN_VAR} must be a join token minted for THAT server and still ` +
        `within its TTL, and ${REALTIME_URL_VAR} must be the server it was minted for.\n` +
        `  A rejected token and an unreachable server look alike from here; check the ` +
        `realtime server's own log for this room.`,
    );
  }

  // The server's name for the room it just admitted us to. Falling back to a made-up
  // name would mislabel the call's audio clips and the platform's own correlation.
  const connection: { disconnect(): Promise<unknown> } = room ?? relay;
  const roomName = (room ? room.name : relay.name) ?? config.sessionId;
  if (!roomName) {
    releaseProviders(providers);
    await disconnectQuietly(connection, "the room reported no name");
    throw new Error(
      `joined ${config.url} but the server reported no room name, and ${SESSION_ID_VAR} ` +
        `is not set, so this call cannot be identified.\n` +
        `  Set ${SESSION_ID_VAR} to the platform's session id.`,
    );
  }

  // This call's own directory. Removed on every way out of this call below: the normal end
  // and each failed start.
  const scratch = await openCallScratch(
    roomName,
    seams.scratchRoot === undefined ? {} : { root: seams.scratchRoot },
  );

  // The caller's app can see the agent from now on: answer its RPCs from now on too. They
  // wait for the session to bind its runtime.
  const client = attachClientMessages(room ?? relay.messaging, { roomName });

  let bundle: VoiceAgentBundle;
  try {
    // The SAME bundle factory the worker path uses. It reads the registry that was
    // compiled into this artifact, never the filesystem -- a hosted artifact runs from an
    // arbitrary directory with no src/agent/ in it. A warm runner built it before `ready`.
    bundle = warm
      ? await warm.takeBundle()
      : await (seams.createBundle ?? (() => createVoiceAgentBundle()))();
  } catch (error) {
    releaseProviders(providers);
    client.detach();
    await scratch?.remove();
    await disconnectQuietly(connection, "the agent bundle could not be built");
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `joined ${roomName} but could not build the agent from this artifact: ${detail}\n` +
        `  The bundled agent registry is written by \`curb build\`; an artifact that ` +
        `cannot produce one is mis-packaged and must be rebuilt.`,
    );
  }

  // Connected BEFORE the session starts, so the greeting turn can already reach the host.
  // A call that keeps no record has no host: `askHost` rejects HostUnavailableError there.
  const messages = bundle.runtime.messages;
  const reporter = config.reporter;
  if (reporter?.journaled) {
    messages.connectHost((message) => reporter.host(message));
    // Everything the agent sends the caller's app is in the call record.
    messages.connectRecorder(recordClientTraffic(reporter));
  }

  let handle: VoiceSessionHandle;
  // Assigned by the executor below, which runs synchronously.
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolvePromise) => {
    resolveEnded = resolvePromise;
  });
  // From here the bundle's session may be recording, so every way out of this call ends
  // the recording: the normal end below, and the failed start in the catch.
  const finishRecording = () =>
    finishCallRecording(
      bundle.session,
      roomName,
      seams.recordingFinishTimeoutMs ?? RECORDING_FINISH_TIMEOUT_MS,
    );
  try {
    // The call's identity reaches its agent from the call, never from the environment: a
    // runner serving several calls has one environment for all of them.
    bundle.runtime.bindCall({
      sessionId: config.sessionId ?? roomName,
      ...(scratch === null ? {} : { scratchDir: scratch.dir }),
    });
    // The caller's context, who placed the call and its experiment variants come with the
    // call too, and land before the session starts so the first turn (the greeting included)
    // can read them, as the worker applies `call.*`.
    bundle.session.updateInfo({
      ...clientContextInfo(config.clientContext),
      ...experimentInfo(config.experiments),
      "call.direction": config.direction ?? "inbound",
    });
    const warmed = warm ? { vad: warm.vad, ...(providers ? { providers: await providers } : {}) } : {};
    const startOptions = {
      roomName,
      bundle,
      firstTurn: bundle.definition.firstTurn,
      pipeline: bundle.definition.pipeline,
      reporter: config.reporter,
      client,
      // onClosed fires once, however the call ended: the room emptied, a hang-up, or
      // `handle.close()` from a stop signal or the management port. Never rejects.
      onClosed: () => {
        // Requests still waiting on the host reject now rather than at their timeout.
        messages.connectHost(null);
        messages.connectRecorder(null);
        reporter?.count({ undeliveredToClient: messages.undeliveredCounts().toClient });
        // `ended` frees a managed runner's slot, so the directory is gone before the slot
        // is: a full runner never holds more scratch directories than calls.
        void finishRecording()
          .then(() => scratch?.remove())
          .then(resolveEnded);
      },
      ...warmed,
      ...(config.onFirstAudio ? { onFirstAudio: config.onFirstAudio } : {}),
    };
    handle = room
      ? await (seams.startVoiceAgent ?? startLivekitVoiceAgent)({ ...startOptions, room })
      : await startVoiceAgent({ ...startOptions, room: relay.room });
  } catch (error) {
    // Providers handed in are this call's to release; a cold start built its own inside.
    releaseProviders(providers);
    client.detach();
    messages.connectHost(null);
    messages.connectRecorder(null);
    await finishRecording();
    await scratch?.remove();
    await disconnectQuietly(connection, "the voice session failed to start");
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `joined ${roomName} but the voice session failed to start: ${detail}\n` +
        `  The agent's providers are its <Agent llm stt tts> props, and each one needs its ` +
        `key in the environment (the error above names the variable).`,
    );
  }

  emit("joined", { room: roomName });
  return { room, connection, roomName, handle, messages, settings: bundle.runtime.settings, ended };
}

/**
 * Close providers opened for a call that never started.
 *
 * Fire and forget, because the caller is about to throw a more specific error. A TTS socket
 * left open here would outlive the call for the life of the runner.
 */
function releaseProviders(pending: Promise<VoiceProviders> | null): void {
  if (pending === null) return;
  void pending.then(
    async ({ stt, tts }) => {
      const results = await Promise.allSettled([tts.close(), stt.close?.()]);
      for (const result of results) {
        if (result.status === "rejected") {
          const detail =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.error(`curb: could not close a speech provider for a call that never started: ${detail}`);
        }
      }
    },
    () => {
      // KEEP-JUSTIFIED: the build itself failed, so nothing was opened to close; the call's
      // own failure is already being thrown by the caller.
    },
  );
}

/**
 * Disconnect a room whose session never started, without losing the failure that got us
 * here. The caller is about to throw a specific, actionable error; a disconnect problem
 * on top of it is reported but must not replace it.
 */
async function disconnectQuietly(room: { disconnect(): Promise<unknown> }, why: string): Promise<void> {
  try {
    await room.disconnect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`curb: could not disconnect the room after ${why}: ${detail}`);
  }
}

/**
 * Serve one call, then return. Resolves when the call ended or a stop signal was handled.
 *
 * The process is stopped by the platform's executor signalling the process group, so
 * SIGTERM and SIGINT are the normal end of a runner, not an exception.
 */
export async function runHostedDirectJoin(config: DirectJoinConfig): Promise<void> {
  const leaked = scrubPlatformCredentials();
  if (leaked.length > 0) {
    // Loud, because it is a defect in whatever started this process, and silence would
    // let it spread to every deployment.
    console.error(
      `curb: ${leaked.join(" and ")} were present in this runner's environment and have ` +
        `been removed. A hosted runner joins one room with one token and must never ` +
        `receive the platform's LiveKit credentials.`,
    );
  }

  // One journal, and an events server if the platform gave this runner an address to be
  // read at. Direct-join is handed its call rather than offered one, so the server carries
  // no registry: it serves /v1/runner/events and refuses the session routes.
  //
  // Without an address the call runs and keeps no record, which is the right behaviour for
  // `curb dev`, the unit suite and `curb build`'s own verification -- all of them place
  // real calls that nothing is listening to. It is counted, not silent.
  const journal = new EventJournal();
  const eventsServer = await startManagementServer(null, { journal });
  if (eventsServer !== null) emit("events-listening", { address: eventsServer.address });

  // One reporter for this one call. A runner handed several calls builds one each. It
  // writes to the journal only when something serves it, so a call nobody reads counts its
  // records as undelivered and tells its agent there is no host.
  const reporter =
    config.reporter ??
    createCallReporter({
      journal: eventsServer === null ? undefined : journal,
      producer: config.sessionId ?? "call",
    });

  const session = await joinRoomAndServe({ ...config, reporter });

  // Hold the event loop open for the length of the call.
  //
  // Not decoration: the voice session lives behind rtc-node's native handles and a
  // pending promise keeps nothing alive on its own. Without this the process can reach
  // an idle loop and exit 0 mid-call, which is precisely the failure the hosted platform
  // cannot see -- it records a healthy runner for a call that stopped answering.
  const keepAlive = setInterval(() => {}, 60_000);

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      // A second signal means the operator is done waiting.
      console.error(`curb: ${signal} received again while stopping; exiting now.`);
      process.exit(1);
    }
    stopping = true;
    emit("stopping", { room: session.roomName, signal });
    void session.handle
      .close()
      .catch(async (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`curb: voice session ${session.roomName} did not close cleanly: ${detail}`);
        // close() disconnects the room itself; when it failed part-way the room may
        // still be joined, and a runner that leaves a participant behind holds the
        // platform's room open.
        await disconnectQuietly(session.connection, "an unclean shutdown");
      });
  };
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const signal of signals) process.on(signal, () => stop(signal));

  let outcome = "completed";
  try {
    await session.ended;
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    clearInterval(keepAlive);
    for (const signal of signals) process.removeAllListeners(signal);
    // LAST, and awaited. The terminal report and any events still batched go out here; a
    // process that exited without this would drop the end of every call, which is the part
    // anybody reviewing one reads first.
    await reporter.finish(outcome);
    if (reporter.undelivered > 0) {
      console.error(
        `curb: ${reporter.undelivered} conversation record(s) were not kept: this runner ` +
          `has no events stream (set ${MANAGEMENT_ADDRESS_ENV} to serve one).`,
      );
    }
    // Ends every open events stream, flushing the terminal record to a reader that is behind,
    // before the entry exits the process.
    await eventsServer?.close();
  }
  emit("ended", { room: session.roomName });
}
