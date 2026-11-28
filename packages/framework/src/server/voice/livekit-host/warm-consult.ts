/**
 * The voice host's side of a warm transfer (`blocks/transfer-call/warm.ts`): the consultation
 * with the person at the transfer number, in a room of its own the caller is not in.
 *
 * The host's acceptance of `call.transfer.warm` carries a ticket for that room, the same kind a
 * call's own join takes: a LiveKit URL and token, or a media relay's (`../../../relay-wire.ts`).
 * The agent joins it as a second participant of this process and runs a second LiveKit
 * `AgentSession` there with the call's own voice settings. That session only speaks what the
 * transfer gives it and hands each of the person's turns to the transfer, which asks the model
 * for one structured decision per turn: it never generates a reply of its own.
 *
 * The ticket's token is never logged.
 */

import { Room } from "@livekit/rtc-node";
import { llm, voice, type VAD } from "@livekit/agents";
import type { AgentRunRequest, AgentRunResponse } from "../../../llm/types.js";
import type { ConsultLeg, ConsultTargetEvent, WarmTransferHost } from "../../../blocks/transfer-call/warm.js";
import { isRelayUrl } from "../../../relay-wire.js";
import { errorText } from "../../../blocks/transfer-call/protocol.js";
import type { VoiceCallRoom } from "../call-room.js";
import { openRelayCall } from "../relay-host/relay-call-room.js";
import { buildVoiceProviders, type VoiceProviders, type VoiceProviderSettings } from "../providers.js";
import { isCaller, type CallParticipant } from "./call-opening.js";
import { CurbLLMStub } from "./curb-agent.js";
import { livekitCallRoom } from "./livekit-call-room.js";

/** How long joining the consultation room may take. */
export const CONSULT_JOIN_TIMEOUT_MS = 15_000;

export type ConsultTicket = { url: string; token: string };

export type ConsultJoinSeams = {
  timeoutMs?: number;
  /** A LiveKit room, connected with the ticket. */
  connectLivekit?: (ticket: ConsultTicket) => Promise<{ room: VoiceCallRoom; disconnect(): Promise<void> }>;
  /** A relay call, opened with the ticket. */
  openRelay?: (ticket: ConsultTicket) => Promise<{ room: VoiceCallRoom; disconnect(): Promise<void> }>;
};

const connectLivekit = async (ticket: ConsultTicket, name: string) => {
  const room = new Room();
  // As a call's own join (`bundler/direct-join.ts`): one subscriber, so no dynacast.
  await room.connect(ticket.url, ticket.token, { autoSubscribe: true, dynacast: false });
  return { room: livekitCallRoom(room, room.name ?? name), disconnect: () => room.disconnect() };
};

/** Join the consultation room of transfer `transferId` with the host's ticket. */
export async function joinConsultRoom(
  ticket: ConsultTicket,
  transferId: string,
  seams: ConsultJoinSeams = {},
): Promise<VoiceCallRoom> {
  const name = `consult-${transferId}`;
  const relayed = isRelayUrl(ticket.url);
  const joining = relayed
    ? (seams.openRelay ?? ((t) => openRelayCall(t.url, t.token)))(ticket)
    : (seams.connectLivekit ?? ((t) => connectLivekit(t, name)))(ticket);
  const timeoutMs = seams.timeoutMs ?? CONSULT_JOIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`joining the consultation room took longer than ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });
  // A join that completes after the deadline leaves at once: nobody uses that room any more.
  void joining.then(
    (joined) => {
      if (timedOut) void joined.disconnect().catch(() => {});
    },
    () => {},
  );
  try {
    const joined = await Promise.race([joining, deadline]);
    return joined.room;
  } catch (error) {
    const where = relayed ? "through the media relay" : "on the realtime server";
    throw new Error(`could not join the consultation room ${where} at ${ticket.url}: ${errorText(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The consultation's agent: speaks only what it is told, and hands every turn of the person
 * on, never answering one itself. */
class ConsultAgent extends voice.Agent {
  constructor(private readonly heard: (text: string) => void) {
    // Never reaches a model: no reply is ever generated in this session.
    super({ instructions: "warm transfer consultation (decided by curb per turn)" });
  }

  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    const text = message.textContent?.trim();
    if (text) this.heard(text);
    throw new voice.StopResponse();
  }
}

/** What the person did, kept until the transfer listens. */
function targetEvents() {
  const listeners = new Set<(event: ConsultTargetEvent) => void>();
  let early: ConsultTargetEvent[] | null = [];
  return {
    emit(event: ConsultTargetEvent) {
      if (early) early.push(event);
      else for (const listener of listeners) listener(event);
    },
    listen(listener: (event: ConsultTargetEvent) => void) {
      listeners.add(listener);
      const buffered = early;
      early = null;
      for (const event of buffered ?? []) listener(event);
      return () => void listeners.delete(listener);
    },
  };
}

export type ConsultLegOptions = {
  room: VoiceCallRoom;
  providers: VoiceProviders;
  vad: VAD;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  /** Tests hand in a fake. */
  createSession?: (options: ConstructorParameters<typeof voice.AgentSession>[0]) => voice.AgentSession;
};

/**
 * Run the consultation's voice session on `room`. The person is the first caller to join it
 * (a phone line, in practice); the session closes with {@link ConsultLeg.close}, which also
 * closes `room` and the providers.
 */
export async function startConsultLeg(options: ConsultLegOptions): Promise<ConsultLeg> {
  const { room, providers } = options;
  const env = options.env ?? process.env;
  const events = targetEvents();
  let target: string | null = null;
  // Set before anything closes, so the room's own events about it are not the person's.
  let closed = false;
  let closing: Promise<void> | null = null;

  const notice = (participant: CallParticipant | undefined) => {
    if (closed || target !== null || !participant || !isCaller(participant)) return;
    target = participant.identity;
    events.emit({ type: "joined" });
  };
  room.onParticipantConnected(notice);
  room.onParticipantDisconnected((participant) => {
    if (closed || !participant || participant.identity !== target) return;
    events.emit({ type: "left" });
  });
  room.onDisconnected((reason) => {
    if (closed) return;
    events.emit({ type: "lost", message: `the agent lost the consultation room (${reason})` });
  });

  const sessionOptions: ConstructorParameters<typeof voice.AgentSession>[0] = {
    stt: providers.stt,
    tts: providers.tts,
    vad: options.vad,
    // The gate LiveKit puts on reply generation; no reply is generated (`ConsultAgent`).
    llm: new CurbLLMStub(),
    turnHandling: {
      turnDetection: "vad",
      interruption: { mode: "vad" },
      endpointing: {
        minDelay: Number(env.VOICE_ENDPOINTING_MIN_MS ?? 300),
        maxDelay: Number(env.VOICE_ENDPOINTING_MAX_MS ?? 3000),
      },
      // One turn, one decision: nothing may run on a turn that is not over.
      preemptiveGeneration: { enabled: false },
    },
  };
  const session = options.createSession?.(sessionOptions) ?? new voice.AgentSession(sessionOptions);
  const close = async () => {
    closed = true;
    const results = await Promise.allSettled([
      session.close(),
      room.disconnect(),
      providers.stt.close?.(),
      providers.tts.close?.(),
    ]);
    for (const result of results) {
      if (result.status === "rejected") options.log(`closing the consultation left something behind: ${errorText(result.reason)}`);
    }
  };
  try {
    await room.startSession({
      session,
      agent: new ConsultAgent((text) => events.emit({ type: "turn", text })),
      // The person is on a phone: nothing is typed in this room.
      onTypedText: async () => {},
    });
  } catch (error) {
    await close();
    throw error;
  }
  for (const participant of room.participants()) notice(participant);

  return {
    onTarget: (listener) => events.listen(listener),
    say: async (text, signal) => {
      if (closed || signal?.aborted) return;
      // Interruptible: the person may answer before the question has played to its end.
      const handle = session.say(text, { allowInterruptions: true });
      const stop = () => {
        try {
          handle.interrupt(true);
        } catch {
          // KEEP-JUSTIFIED: the line already finished or the session closed; either way it is quiet.
        }
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        await handle.waitForPlayout();
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    close: () => (closing ??= close()),
  };
}

/** Join the consultation room and start its session with the call's current voice settings. */
export async function openConsultLeg(options: {
  ticket: ConsultTicket;
  transferId: string;
  settings: VoiceProviderSettings;
  vad: VAD;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  join?: ConsultJoinSeams;
}): Promise<ConsultLeg> {
  const room = await joinConsultRoom(options.ticket, options.transferId, options.join);
  let providers: VoiceProviders | null = null;
  try {
    providers = await buildVoiceProviders({ settings: options.settings, env: options.env });
    return await startConsultLeg({ room, providers, vad: options.vad, env: options.env, log: options.log });
  } catch (error) {
    // startConsultLeg closes what it was handed when it fails; before it, nothing else will.
    if (providers === null) await room.disconnect().catch(() => {});
    throw error;
  }
}

export type WarmTransferHostOptions = {
  /** The tone the caller hears while the person is asked; returns the stop. */
  hold: () => () => void;
  /** Stop the call's own agent listening and speaking; returns the resume. */
  pause: () => () => void;
  ask: (request: AgentRunRequest, signal?: AbortSignal) => Promise<AgentRunResponse>;
  openConsult: (ticket: ConsultTicket, transferId: string) => Promise<ConsultLeg>;
};

/** A {@link WarmTransferHost}, and the two facts the call's host tells it. */
export type CallWarmTransferHost = WarmTransferHost & {
  /** The caller left the call (or the call ends). */
  callerLeft(): void;
  /** A transfer target came into the call's room. */
  handedOff(): void;
};

export function createWarmTransferHost(options: WarmTransferHostOptions): CallWarmTransferHost {
  const callerLeft = new Set<() => void>();
  const handedOff = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const notify = (listeners: Set<() => void>) => {
    for (const listener of [...listeners]) listener();
  };
  return {
    hold: options.hold,
    pause: options.pause,
    ask: options.ask,
    openConsult: options.openConsult,
    onCallerLeft: subscribe(callerLeft),
    onHandedOff: subscribe(handedOff),
    callerLeft: () => notify(callerLeft),
    handedOff: () => notify(handedOff),
  };
}
