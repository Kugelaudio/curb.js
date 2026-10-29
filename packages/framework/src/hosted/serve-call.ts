import type { AgentSessionBundle } from "../server/connection.js";
import type { VoiceSessionHandle } from "../server/voice/orchestration.js";
import { recordClientTraffic, type CallReporter } from "./call-reporter.js";
import { EventJournal } from "./event-journal.js";
import {
  localRegistrar,
  registrarFromEnv,
  startJobLink,
  JOB_LINK_ENV,
  type CallRegistrar,
  type JobLink,
} from "./call-link.js";
import {
  MANAGEMENT_ADDRESS_ENV,
  managementTokenFrom,
  startManagementServer,
  type ManagementServer,
} from "./management-server.js";
import { SessionRegistry, type AdoptedCall } from "./session-registry.js";

/**
 * The management port for calls this process did not place: `curb dev` (the preview places
 * them) and `curb start` (LiveKit dispatch places them).
 *
 * Opened exactly like a managed runner's: only when BOTH `CURB_MANAGEMENT_ADDR` and
 * `CURB_MANAGEMENT_TOKEN` are set. Every call the process runs is registered under its
 * LiveKit ROOM NAME as the session id, from the moment it starts until it ends, so a
 * self-hoster's host can list them, follow `GET /v1/runner/events`, send messages, change
 * settings and end them. Placing a call (`POST /v1/sessions`) is refused with 501.
 */
export interface CallManagement {
  readonly address: string;
  readonly registry: SessionRegistry;
  /** Registers a call in this process. */
  readonly registrar: CallRegistrar;
  close(): Promise<void>;
}

export async function openCallManagement(
  options: { env?: NodeJS.ProcessEnv; log?: (message: string) => void } = {},
): Promise<CallManagement | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.error(message));
  const address = env[MANAGEMENT_ADDRESS_ENV]?.trim() ?? "";
  if (address === "") return null;
  const journal = new EventJournal();
  const registry = new SessionRegistry({ journal, log });
  // Refuses (and says why) without a token: an unauthenticated port admits anything.
  const server: ManagementServer | null = await startManagementServer(registry, {
    address,
    token: managementTokenFrom(env),
    journal,
    log,
  });
  if (server === null) return null;
  return {
    address: server.address,
    registry,
    registrar: localRegistrar(registry),
    close: () => server.close(),
  };
}

/**
 * `curb start`: the management port in the worker process, and the job link its job
 * processes register their calls over (see `call-link.ts`). Sets {@link JOB_LINK_ENV} in
 * `env`, which LiveKit's forked job processes inherit.
 */
export async function openWorkerManagement(
  options: { env?: NodeJS.ProcessEnv; log?: (message: string) => void } = {},
): Promise<(CallManagement & { link: JobLink }) | null> {
  const env = options.env ?? process.env;
  const management = await openCallManagement(options);
  if (management === null) return null;
  const link = await startJobLink(management.registry, options.log ? { log: options.log } : {});
  env[JOB_LINK_ENV] = link.path;
  return {
    ...management,
    link,
    close: async () => {
      await link.close();
      await management.close();
    },
  };
}

/** What `serveCall` hands the voice session: spread it into `startLivekitVoiceAgent`'s options. */
export interface ServedCall {
  /** This call's reporter when a management port follows it; absent otherwise. */
  reporter?: CallReporter;
  /** Must reach the voice session's `onClosed`: it is how the port learns the call ended. */
  onClosed: () => void;
}

/**
 * Run one call so the management port can reach it, when there is one.
 *
 *   const handle = await serveCall({ sessionId: roomName, bundle }, (call) =>
 *     startLivekitVoiceAgent({ room, roomName, bundle, client, firstTurn, ...call }),
 *   );
 *
 * With no port (no `CURB_MANAGEMENT_ADDR`), it only runs `start`. With one, it registers the
 * call under `sessionId`, connects the agent's `useSend().toHost` to the events stream, and
 * serves the host's messages, settings changes and stop for as long as the call runs. A call
 * that cannot be registered (a second call in the same room) runs anyway, unreachable, and
 * says so.
 */
export async function serveCall(
  call: {
    sessionId: string;
    bundle: AgentSessionBundle;
    /** Where to register. Default: the job link `curb start` set up, if any. Null: nowhere. */
    registrar?: CallRegistrar | null;
    log?: (message: string) => void;
  },
  start: (served: ServedCall) => Promise<VoiceSessionHandle>,
): Promise<VoiceSessionHandle> {
  const log = call.log ?? ((message: string) => console.error(message));
  const registrar = call.registrar === undefined ? registrarFromEnv() : call.registrar;
  let adopted: AdoptedCall | null = null;
  if (registrar !== null) {
    try {
      adopted = await registrar.open(call.sessionId);
    } catch (error) {
      log(
        `curb: call ${call.sessionId} runs without the management port: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (adopted === null) return start({ onClosed: () => {} });
  const registered = adopted;

  // Mutable: a rewind in `curb dev` swaps the runtime mid-call.
  let bundle = call.bundle;
  const connectHost = (target: AgentSessionBundle) => {
    target.runtime.messages.connectHost((message) => registered.reporter.host(message));
    // Everything the agent sends the caller's app is in the call record.
    target.runtime.messages.connectRecorder(recordClientTraffic(registered.reporter));
  };
  /** Stop recording `from`, keeping what it failed to deliver in the call record. */
  const disconnect = (from: AgentSessionBundle) => {
    from.runtime.messages.connectHost(null);
    from.runtime.messages.connectRecorder(null);
    registered.reporter.count({ undeliveredToClient: from.runtime.messages.undeliveredCounts().toClient });
  };
  connectHost(bundle);

  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const onClosed = () => {
    // Requests still waiting on the host reject now rather than at their timeout.
    disconnect(bundle);
    resolveEnded();
  };

  let handle: VoiceSessionHandle;
  try {
    handle = await start({ reporter: registered.reporter, onClosed });
  } catch (error) {
    disconnect(bundle);
    registered.failed(error);
    throw error;
  }

  registered.connected({
    ended,
    deliver: async (message) => {
      // The host protocol names a key `name`; the origin is stamped here, by the transport.
      await bundle.runtime.messages.deliver("host", {
        id: message.id,
        key: message.name,
        payload: message.payload,
        ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      });
    },
    update: async (body) => bundle.runtime.settings.update("host", body),
    close: async (_reason, graceMs) => handle.close({ graceMs }),
  });

  return {
    ...handle,
    setBundle: (next) => {
      disconnect(bundle);
      bundle = next;
      connectHost(next);
      handle.setBundle(next);
    },
  };
}
