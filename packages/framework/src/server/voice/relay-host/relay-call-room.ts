/**
 * A call whose room a media relay holds (`../call-room.ts`, `../../../relay-wire.ts`).
 *
 * The session runs as it does on a local call: the same audio input and output and the same
 * transcription synchronizer, over a socket. Everything a LiveKit `Room` gives a call crosses that
 * socket too: participants, the agent's state, transcripts for the caller's app, typed text, app
 * messages and settings RPCs, and a transfer's track. The room's token stays with the relay, so
 * neither it nor WebRTC runs in this process.
 */

import { ParticipantKind, RpcError, type AudioFrame, type RpcInvocationData } from "@livekit/rtc-node";
import { tts, voice } from "@livekit/agents";
import { WebSocket, type RawData } from "ws";
import type { LocalVoiceServerMessage } from "../../../local-voice-wire.js";
import {
  parseRelayRoomMessage,
  RELAY_STREAM,
  RELAY_TRANSFER_SAMPLE_RATE,
  relaySocketUrl,
  type RelayAgentMessage,
  type RelayParticipant,
  type RelayRoomMessage,
} from "../../../relay-wire.js";
import { logError, logInfo } from "../../log.js";
import type { VoiceCallRoom } from "../call-room.js";
import { isCaller, type CallParticipant } from "../livekit-host/call-opening.js";
import type { MessagingRoom } from "../livekit-host/messages.js";
import type { TransferAudioSink } from "../livekit-host/transfer-audio.js";
import { isTransferTarget } from "../livekit-host/transfer-handoff.js";
import { PageAudioInput, PageAudioOutput } from "../local-host/local-call-room.js";
import { createSynchronizer, type TranscriptSink } from "../local-host/synchronizer.js";

const JOIN_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 5_000;
/** A relay on a lost node sends no close: three silent heartbeats end the call instead of leaving it silent. */
const HEARTBEAT_MISSES = 3;
/** Far above any audio frame or message, and a bound on what a broken relay can make this process hold. */
const MAX_FRAME_BYTES = 1024 * 1024;
/**
 * How far ahead of real time a transfer's audio may run. A ringback never ends and the transfer
 * loop paces itself on the sink, so without this it would fill the socket as fast as it can yield.
 */
const TRANSFER_LEAD_MS = 200;

export type RelayCall = {
  /** The room's name, as the relay reports it. */
  readonly name: string;
  readonly room: VoiceCallRoom;
  /** What app messages and settings use (`../livekit-host/messages.ts`). */
  readonly messaging: MessagingRoom;
  disconnect(): Promise<void>;
};

export type RelayConnect = (url: string, token: string) => WebSocket;

const connectSocket: RelayConnect = (url, token) =>
  new WebSocket(relaySocketUrl(url), {
    headers: { authorization: `Bearer ${token}` },
    handshakeTimeout: JOIN_TIMEOUT_MS,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
  });

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

/** The agent's words for the caller's app, without expressive markup, as `RoomIO` publishes them. */
function agentTranscriptSink(session: voice.AgentSession, send: (message: RelayAgentMessage) => void): TranscriptSink {
  let stripper = new tts.TranscriptMarkupStripper();
  return {
    captureText: async (text) => {
      const raw = typeof text === "string" ? text : text.text;
      const clean = session._expressiveEverActive ? stripper.push(raw) : raw;
      if (clean) send({ type: "agent_text", text: clean });
    },
    flush: () => {
      const rest = session._expressiveEverActive ? stripper.flush() : "";
      if (rest) send({ type: "agent_text", text: rest });
      stripper = new tts.TranscriptMarkupStripper();
      send({ type: "agent_text_end" });
    },
    onAttached: () => undefined,
    onDetached: () => undefined,
  };
}

/**
 * Connect to the relay and wait for it to join the room. Rejects with what went wrong, and a
 * call that loses the relay later reports that through `onDisconnected`.
 */
export async function openRelayCall(
  url: string,
  token: string,
  options: { connect?: RelayConnect; joinTimeoutMs?: number; heartbeatMs?: number } = {},
): Promise<RelayCall> {
  const socket = (options.connect ?? connectSocket)(url, token);
  const participants = new Map<string, CallParticipant>();
  const joinedListeners = new Set<(participant: CallParticipant | undefined) => void>();
  const leftListeners = new Set<(participant: CallParticipant | undefined) => void>();
  const lostListeners = new Set<(reason: string) => void>();
  const rpcHandlers = new Map<string, (data: RpcInvocationData) => Promise<string>>();
  const pendingText = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const pendingPlayout = new Map<number, () => void>();
  let transferOpening: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let input: PageAudioInput | null = null;
  let output: PageAudioOutput | null = null;
  let linked: string | null = null;
  let typedText: ((text: string) => void) | null = null;
  let nextId = 1;
  let lost: string | null = null;
  let left = false;

  const sendMessage = (message: RelayAgentMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const sendAudio = (stream: number, pcm: Buffer | Uint8Array) => {
    if (socket.readyState !== socket.OPEN) return;
    const view = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    socket.send(Buffer.concat([Buffer.of(stream), view]), { binary: true });
  };

  const link = (identity: string | null) => {
    linked = identity;
    sendMessage({ type: "listen", identity });
  };
  /** The call's caller, as `RoomIO` picks one: the first person or line, never a transfer target. */
  const linkCaller = () => {
    if (input === null || (linked !== null && participants.has(linked))) return;
    const caller = [...participants.values()].find((p) => isCaller(p) && !isTransferTarget(p));
    link(caller?.identity ?? null);
  };

  const answerRpc = (message: Extract<RelayRoomMessage, { type: "rpc_request" }>) => {
    const handler = rpcHandlers.get(message.method);
    const invocation: RpcInvocationData = {
      method: message.method,
      requestId: String(message.id),
      callerIdentity: message.callerIdentity,
      payload: message.payload,
      responseTimeout: message.responseTimeoutMs,
    };
    const answered = handler ? handler(invocation) : Promise.reject(RpcError.builtIn("UNSUPPORTED_METHOD"));
    answered.then(
      (payload) => sendMessage({ type: "rpc_response", id: message.id, payload }),
      (error: unknown) => {
        const failure =
          error instanceof RpcError
            ? { code: Number(error.code), message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
            : { code: Number(RpcError.ErrorCode.APPLICATION_ERROR), message: "the agent could not answer this request" };
        if (!(error instanceof RpcError)) {
          logError("voice", `relay call: RPC ${message.method} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        sendMessage({ type: "rpc_response", id: message.id, error: failure });
      },
    );
  };

  const onRoomMessage = (message: RelayRoomMessage) => {
    switch (message.type) {
      case "joined":
        throw new Error("the relay said it joined twice");
      case "participant_connected":
        participants.set(message.participant.identity, asParticipant(message.participant));
        linkCaller();
        for (const listener of joinedListeners) listener(participants.get(message.participant.identity));
        return;
      case "participant_updated":
        participants.set(message.participant.identity, asParticipant(message.participant));
        return;
      case "participant_disconnected": {
        const participant = participants.get(message.identity);
        participants.delete(message.identity);
        if (linked === message.identity) linked = null;
        for (const listener of leftListeners) listener(participant);
        return;
      }
      case "playout_done":
      case "playout_cleared":
        if (output === null) throw new Error(`the relay reported ${message.type} before the session started`);
        output.report(message);
        return;
      case "typed_text":
        if (typedText === null) throw new Error("the relay sent typed text before the session started");
        typedText(message.text);
        return;
      case "transfer_ready":
        transferOpening?.resolve();
        transferOpening = null;
        return;
      case "transfer_failed":
        transferOpening?.reject(new Error(`the relay could not publish the transfer track: ${message.message}`));
        transferOpening = null;
        return;
      case "transfer_played":
        pendingPlayout.get(message.id)?.();
        pendingPlayout.delete(message.id);
        return;
      case "rpc_request":
        answerRpc(message);
        return;
      case "send_text_result": {
        const pending = pendingText.get(message.id);
        pendingText.delete(message.id);
        if (message.error === undefined) pending?.resolve();
        else pending?.reject(new Error(message.error));
        return;
      }
      case "room_lost":
        loseCall(message.reason);
        return;
    }
  };

  /** The relay or its room is gone. Nothing will be heard again, so everything waiting on it stops. */
  const loseCall = (reason: string) => {
    if (lost !== null) return;
    lost = reason;
    output?.pageLeft();
    transferOpening?.reject(new Error(`the media relay is gone: ${reason}`));
    transferOpening = null;
    for (const release of pendingPlayout.values()) release();
    pendingPlayout.clear();
    for (const pending of pendingText.values()) pending.reject(new Error(`the media relay is gone: ${reason}`));
    pendingText.clear();
    void input?.close();
    for (const listener of lostListeners) listener(reason);
  };

  let name = "";
  let joining: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const joined = new Promise<void>((resolve, reject) => {
    joining = { resolve, reject };
  });
  const timer = setTimeout(
    () => failJoin(new Error(`the media relay did not join the room within ${options.joinTimeoutMs ?? JOIN_TIMEOUT_MS} ms`)),
    options.joinTimeoutMs ?? JOIN_TIMEOUT_MS,
  );
  const failJoin = (error: Error) => {
    const pending = joining;
    joining = null;
    clearTimeout(timer);
    if (pending === null) return;
    socket.terminate();
    pending.reject(error);
  };
  const onJoinMessage = (message: RelayRoomMessage) => {
    if (message.type === "room_lost") return failJoin(new Error(`the media relay could not join the room: ${message.reason}`));
    if (message.type !== "joined") return failJoin(new Error(`the media relay sent ${message.type} before it joined the room`));
    name = message.room;
    for (const participant of message.participants) participants.set(participant.identity, asParticipant(participant));
    const pending = joining;
    joining = null;
    clearTimeout(timer);
    pending?.resolve();
  };

  // One handler from the first byte: `ws` can emit several frames in one tick, so one attached
  // after the join resolved could miss whatever came right behind `joined`.
  socket.on("message", (data: RawData, isBinary: boolean) => {
    try {
      if (joining !== null) {
        if (isBinary) return failJoin(new Error("the media relay sent audio before it joined the room"));
        return onJoinMessage(parseRelayRoomMessage(data.toString()));
      }
      if (isBinary) {
        const frame = toBuffer(data);
        if (frame[0] !== RELAY_STREAM.main) throw new Error(`audio on unknown stream ${frame[0]}`);
        input?.push(frame.subarray(1));
        return;
      }
      onRoomMessage(parseRelayRoomMessage(data.toString()));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (joining !== null) return failJoin(failure);
      // KEEP-JUSTIFIED: one malformed frame must not end the call; it is logged with its cause,
      // and the next frame is read as usual.
      logError("voice", `relay call ${name}: ${failure.message}`);
    }
  });
  socket.on("error", (error) => {
    if (joining !== null) failJoin(new Error(`could not reach the media relay: ${error.message}`));
    else logError("voice", `relay call ${name}: ${error.message}`);
  });
  socket.on("close", (code) => {
    clearInterval(heartbeat);
    if (joining !== null) failJoin(new Error(`the media relay closed the socket (${code}) before it joined the room`));
    else if (!left) loseCall(`the socket closed (${code})`);
  });

  let silentBeats = 0;
  socket.on("pong", () => {
    silentBeats = 0;
  });
  const heartbeat = setInterval(() => {
    silentBeats += 1;
    if (silentBeats > HEARTBEAT_MISSES) {
      logError("voice", `relay call ${name}: no answer from the relay for ${HEARTBEAT_MISSES} heartbeats`);
      socket.terminate();
      return;
    }
    if (socket.readyState === socket.OPEN) socket.ping();
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  const room: VoiceCallRoom = {
    get name() {
      return name;
    },
    participants: () => participants.values(),
    onParticipantConnected: (listener) => void joinedListeners.add(listener),
    onParticipantDisconnected: (listener) => void leftListeners.add(listener),
    onDisconnected: (listener) => void lostListeners.add(listener),
    startSession: async ({ session, agent, onTypedText }) => {
      input = new PageAudioInput();
      output = new PageAudioOutput((message: LocalVoiceServerMessage | Buffer) => {
        if (Buffer.isBuffer(message)) sendAudio(RELAY_STREAM.main, message);
        else sendMessage(message);
      });
      const synchronizer = await createSynchronizer(output, agentTranscriptSink(session, sendMessage));
      session.input.audio = input;
      session.output.audio = synchronizer.audioOutput;
      session.output.transcription = synchronizer.textOutput;
      let segment = 0;
      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
        sendMessage({ type: "caller_text", id: `${name}-${segment}`, text: event.transcript, final: event.isFinal });
        if (event.isFinal) segment += 1;
      });
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
        sendMessage({ type: "agent_state", state: event.newState });
      });
      typedText = (text) => {
        onTypedText(session, text).catch((error: unknown) => {
          logError("voice", `relay call ${name}: typed text failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      await session.start({ agent });
      linkCaller();
      logInfo("voice", `relay call ${name}: session started`);
    },
    publishTransferTrack: () => openTransferSink(),
    disconnect: () => disconnect(),
  };

  const openTransferSink = async (): Promise<TransferAudioSink> => {
    if (lost !== null) throw new Error(`the media relay is gone: ${lost}`);
    await new Promise<void>((resolve, reject) => {
      transferOpening = { resolve, reject };
      sendMessage({ type: "transfer_open" });
    });
    let playsUntil = 0;
    return {
      captureFrame: async (frame: AudioFrame) => {
        if (frame.sampleRate !== RELAY_TRANSFER_SAMPLE_RATE || frame.channels !== 1) {
          throw new Error(`a transfer plays ${RELAY_TRANSFER_SAMPLE_RATE} Hz mono, got ${frame.sampleRate} Hz x${frame.channels}`);
        }
        sendAudio(RELAY_STREAM.transfer, new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
        const now = Date.now();
        playsUntil = Math.max(playsUntil, now) + (frame.samplesPerChannel / frame.sampleRate) * 1000;
        const ahead = playsUntil - now - TRANSFER_LEAD_MS;
        if (ahead > 0) await new Promise((resolve) => setTimeout(resolve, ahead));
      },
      waitForPlayout: () =>
        new Promise<void>((resolve) => {
          if (lost !== null) return resolve();
          const id = nextId++;
          pendingPlayout.set(id, resolve);
          sendMessage({ type: "transfer_wait", id });
        }),
      clearQueue: () => {
        playsUntil = 0;
        sendMessage({ type: "transfer_clear" });
      },
      close: async () => sendMessage({ type: "transfer_close" }),
    };
  };

  const disconnect = async () => {
    if (left) return;
    left = true;
    clearInterval(heartbeat);
    output?.pageLeft();
    await input?.close();
    if (socket.readyState === socket.OPEN) {
      sendMessage({ type: "leave" });
      socket.close(1000, "call ended");
    }
    if (lost === null) for (const listener of lostListeners) listener("call ended");
  };

  const messaging: MessagingRoom = {
    localParticipant: {
      registerRpcMethod: (method, handler) => {
        rpcHandlers.set(method, handler);
        sendMessage({ type: "rpc_register", method });
      },
      unregisterRpcMethod: (method) => {
        rpcHandlers.delete(method);
        sendMessage({ type: "rpc_unregister", method });
      },
      sendText: (text, sendOptions) =>
        new Promise<void>((resolve, reject) => {
          if (lost !== null) return reject(new Error(`the media relay is gone: ${lost}`));
          const id = nextId++;
          pendingText.set(id, { resolve, reject });
          sendMessage({ type: "send_text", id, topic: sendOptions?.topic ?? "", text });
        }),
    },
    get remoteParticipants() {
      return new Map(
        [...participants.values()].map((p) => [p.identity, { kind: p.kind ?? ParticipantKind.STANDARD }]),
      );
    },
  };

  await joined.catch((error: unknown) => {
    clearInterval(heartbeat);
    throw error;
  });
  return {
    get name() {
      return name;
    },
    room,
    messaging,
    disconnect,
  };
}

function asParticipant(wire: RelayParticipant): CallParticipant {
  return {
    identity: wire.identity,
    ...(wire.kind === undefined ? {} : { kind: wire.kind as ParticipantKind }),
    ...(wire.attributes === undefined ? {} : { attributes: wire.attributes }),
  };
}
