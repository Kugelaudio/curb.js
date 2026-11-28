/**
 * A call on `<Agent s2s>`: the model is the whole voice, Curb the back office behind it.
 *
 * The model owns the microphone, the turn-taking, the transcript and the speech, so this call has
 * no STT, TTS, VAD or endpointing of its own, and no Curb turn runs unless the model hands one
 * over (`back-office.ts`). LiveKit carries the model's protocol between the room and the model
 * (`voices.ts`), and everything in this file is what is left of a call around that, the same for
 * every model.
 */

import { voice } from "@livekit/agents";
import type { S2sDescriptor } from "../../../providers.js";
import type { AgentSiteRuntime } from "../../../runtime.js";
import { fallbackReplies } from "../../../llm/localized.js";
import { logError, logInfo } from "../../log.js";
import { createCallOpening, runOpeningStep, type GreetingReply } from "../livekit-host/call-opening.js";
import { createCallerWatchdog, EMPTY_ROOM_GRACE_MS } from "../livekit-host/caller-watchdog.js";
import { ConversationClips } from "../livekit-host/clip-store.js";
import type { VoiceAgentStartOptions } from "../livekit-host/host.js";
import { voiceSessionOptions } from "../livekit-host/pipeline.js";
import { createSilenceFollowup, silenceFollowupDelayMs } from "../livekit-host/silence-followup.js";
import { callerSide } from "../livekit-host/transfer-handoff.js";
import { createEndCallHangup } from "../end-call.js";
import { callTraceOf } from "../../../call-trace.js";
import type { AgentSessionBundle } from "../../connection.js";
import type { VoiceSessionHandle } from "../orchestration.js";
import { createBackOffice } from "./back-office.js";
import { createS2sCallRecord } from "./call-record.js";
import { voiceInstructions } from "./instructions.js";
import { fallbackVoices, sayUnavailableLine } from "./unavailable-line.js";
import { s2sVoice, type S2sVoice } from "./voices.js";

/** How long a goodbye may take to start and play before the call ends anyway. */
const GOODBYE_MS = 15_000;
const GOODBYE_STOPPED_MS = 1_500;
const NO_CALLER_GRACE_MS = 60_000;

/** What the model is asked when the agent opens the call (`firstTurn: "agent"`). */
const OPEN_NOW = "Open the call now.";
/** What the model is asked when the agent opens with a fixed line (`firstTurn: { say }`). */
const openWith = (line: string) => `Open the call with this line, in these words: ${JSON.stringify(line)}`;

/** The model owns its playout: an opening it is asked for is not waited on. */
const MODEL_SPEAKS: GreetingReply = { done: () => true, waitForPlayout: async () => {} };

export async function startS2sCall(options: VoiceAgentStartOptions): Promise<VoiceSessionHandle> {
  const env = options.env ?? process.env;
  const { room, roomName } = options;
  // Mutable: the connection swaps in a rebuilt bundle on rewind.
  let bundle: AgentSessionBundle = options.bundle;
  options.client.bind(bundle.runtime);
  const descriptor = bundle.runtime.settings.s2s() as S2sDescriptor;
  const clips = new ConversationClips();

  const record = createS2sCallRecord(options.reporter);
  let modelVoice: S2sVoice | null = null;
  const backOffice = createBackOffice({
    session: () => bundle.session,
    voice: () => modelVoice?.channel() ?? null,
    reporter: options.reporter,
    verbatim: descriptor.protocol === "live" && descriptor.options.verbatim === true,
  });
  /** The caller's microphone carries speech now, whether or not the model sent words for it yet. */
  let callerAudio = false;
  modelVoice = s2sVoice(descriptor, env, {
    delegated: (id, words) => {
      void backOffice.delegated(id, words).catch((error: unknown) => {
        logError("voice", `${roomName}: back office failed: ${String(error)}`);
      });
    },
    asked: (request) => backOffice.asked(request),
    say: (instructions) => session.generateReply({ instructions }),
    lost: () => {
      logError("voice", `${roomName}: the model keeps dropping the call, ending it`);
      failCall();
    },
    callerAudio: (speaking) => {
      callerAudio = speaking;
      silence.cancel();
    },
  });
  const { model: voiceModel, tools } = modelVoice;

  const session = new voice.AgentSession(voiceSessionOptions({ llm: voiceModel }, options.pipeline));
  options.pipeline?.onSession?.({ session, roomName, events: voice.AgentSessionEventTypes });

  // After each line of the model's, quiet from the caller asks `llm` once whether the call is
  // over (`backOffice.quiet`). Any sign of the caller cancels it for that line: they have the
  // floor, and the model answers them.
  const silence = createSilenceFollowup({
    delayMs: silenceFollowupDelayMs(env),
    // A call on a speech-to-speech model is never transferred.
    handedOff: () => false,
    callerAway: () => callerSide(room.participants()).length === 0,
    callerSpeaking: () => callerAudio || session.userState === "speaking",
    reply: () => backOffice.quiet(),
    onError: (error) => logError("voice", `${roomName}: silence check-in failed: ${String(error)}`),
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    silence.cancel();
    if (newState === "speaking") backOffice.callerStarted();
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, () => silence.cancel());
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, ({ newState }) => {
    if (newState === "speaking") silence.cancel();
  });

  /** The model was asked to say the agent's fixed first line, which the conversation and the record
   * hold already: its next line is that one, said, not a line to keep again. */
  let openingAsked = false;
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) return;
    const text = item.textContent?.trim();
    if (!text) return;
    if (item.role === "user") {
      silence.cancel();
      record.callerSaid(text);
      backOffice.heard("user", text);
      return;
    }
    if (openingAsked) openingAsked = false;
    else {
      record.agentSaid(text);
      backOffice.heard("assistant", text);
    }
    silence.arm();
  });

  /** The model could not take the call or keep it: the caller is told before it ends. */
  let failed = false;
  /** What a cascaded turn the provider refused ends on, in a voice that does not hang on what
   * failed (`unavailable-line.ts`). Kept in the record only once the caller has heard it. */
  const tellCaller = async () => {
    const settings = bundle.runtime.settings;
    const language = settings.language();
    const line = fallbackReplies(language).refused;
    const voices = fallbackVoices({ s2s: descriptor, descriptor: settings.current().tts, language, env, given: options.providers?.tts });
    const log = (message: string) => logError("voice", `${roomName}: ${message}`);
    if (await sayUnavailableLine({ line, voices, publish: () => room.publishTransferTrack(), log })) record.agentSaid(line);
  };

  let closing: Promise<void> | null = null;
  const closeNow = async () => {
    watchdog.cancel();
    silence.stop();
    if (failed) await tellCaller();
    record.close();
    bundle.runtime.setEndCallRequest(null);
    options.client.detach();
    const results = await Promise.allSettled([session.close(), room.disconnect()]);
    logInfo("voice", `voice agent left call ${roomName}`);
    options.onClosed?.();
    for (const result of results) {
      if (result.status === "rejected") logError("voice", `closing ${roomName} left something behind: ${String(result.reason)}`);
    }
  };
  const close = () => (closing ??= closeNow());
  const closeFromRoom = () => void close();
  const failCall = () => {
    failed = true;
    closeFromRoom();
  };
  const watchdog = createCallerWatchdog({
    remoteCount: () => [...room.participants()].length,
    giveUp: closeFromRoom,
    log: (message) => logInfo("voice", `${roomName}: ${message}`),
    emptyRoomMs: EMPTY_ROOM_GRACE_MS,
    noCallerMs: NO_CALLER_GRACE_MS,
  });
  // A model that failed for good closes the session with its error.
  session.on(voice.AgentSessionEventTypes.Close, ({ error }) => (error ? failCall() : closeFromRoom()));

  /** The goodbye went to the model: wait for it to start speaking and to stop. It may be speaking
   * already, and may stop between a filler and the goodbye, so a stop only counts if it lasts. */
  const goodbyePlayed = async () => {
    await backOffice.settled();
    await new Promise<void>((resolve) => {
      let spoke = session.agentState === "speaking";
      let stopped: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        clearTimeout(stopped);
        session.off(voice.AgentSessionEventTypes.AgentStateChanged, follow);
        resolve();
      };
      const follow = (change: { newState: string }) => {
        clearTimeout(stopped);
        if (change.newState === "speaking") spoke = true;
        else if (spoke) stopped = setTimeout(done, GOODBYE_STOPPED_MS);
      };
      const timer = setTimeout(done, GOODBYE_MS);
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, follow);
    });
  };
  const hangup = createEndCallHangup({
    currentReply: () => ({ waitForPlayout: goodbyePlayed, interrupted: false }),
    close: closeFromRoom,
    log: (message) => logInfo("voice", message),
  });
  bundle.runtime.setEndCallRequest(hangup.request);

  // The call opens as a cascaded call does (`call-opening.ts`): the caller's info, then the
  // greeting or the agent's fixed line, which the conversation and the record keep as written.
  // Only the model says it. A model may speak as soon as its session starts, so the session
  // starts once a caller is there.
  const startModel = () => {
    const agent = new voice.Agent({ instructions: voiceInstructions(bundle.runtime), tools });
    room
      .startSession({ session, agent, onTypedText: async (_session, text) => void backOffice.typed(text) })
      .then(() => runOpeningStep(() => opening.sessionStarted(), options))
      .catch((error: unknown) => {
        logError("voice", `${roomName}: could not start the call: ${String(error)}`);
        callTraceOf(bundle.runtime.info)?.fail(error);
        failCall();
      });
  };
  const opening = createCallOpening({
    firstTurn: options.firstTurn,
    participants: () => callerSide(room.participants()),
    recordCaller: (info) => {
      bundle.session.updateInfo(info);
      startModel();
    },
    openConversation: () => bundle.session.open(),
    generateReply: () => {
      session.generateReply({ instructions: OPEN_NOW });
      return MODEL_SPEAKS;
    },
    say: (line) => {
      record.agentSaid(line);
      openingAsked = true;
      session.generateReply({ instructions: openWith(line) });
      return MODEL_SPEAKS;
    },
  });
  room.onParticipantConnected(() => runOpeningStep(() => opening.update(), options));
  runOpeningStep(() => opening.update(), options);

  room.onParticipantConnected(() => watchdog.onParticipantJoined());
  room.onParticipantDisconnected(() => watchdog.onParticipantLeft());
  watchdog.armForArrival();
  room.onDisconnected(closeFromRoom);

  logInfo("voice", `voice agent joined call ${roomName}`);
  return {
    close,
    clips,
    sendText: async (text) => {
      if (text.trim()) await backOffice.typed(text.trim());
    },
    setBundle: (next) => {
      bundle.runtime.setEndCallRequest(null);
      bundle = next;
      options.client.bind(bundle.runtime);
      bundle.runtime.setEndCallRequest(hangup.request);
    },
    interrupt: () => session.interrupt({ force: true }),
  };
}
