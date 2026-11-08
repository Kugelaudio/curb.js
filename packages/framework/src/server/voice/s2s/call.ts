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
import { logError, logInfo } from "../../log.js";
import { createCallOpening, runOpeningStep, type GreetingReply } from "../livekit-host/call-opening.js";
import { createCallerWatchdog, EMPTY_ROOM_GRACE_MS } from "../livekit-host/caller-watchdog.js";
import { ConversationClips } from "../livekit-host/clip-store.js";
import type { VoiceAgentStartOptions } from "../livekit-host/host.js";
import { voiceSessionOptions } from "../livekit-host/pipeline.js";
import { createSilenceFollowup, silenceFollowupDelayMs } from "../livekit-host/silence-followup.js";
import { callerSide } from "../livekit-host/transfer-handoff.js";
import { createEndCallHangup } from "../end-call.js";
import type { AgentSessionBundle } from "../../connection.js";
import type { VoiceSessionHandle } from "../orchestration.js";
import { createBackOffice } from "./back-office.js";
import { createS2sCallRecord } from "./call-record.js";
import { s2sVoice, type S2sVoice } from "./voices.js";

/** How the model works with the back office, after the agent's own prompt. */
const BACK_OFFICE_RULES = [
  "A back office works behind you: it can open the skills and run the tools listed here, and you cannot.",
  "Hand over anything that needs one of them, and never say something was done until the back office reports it.",
  "It can do more than this list shows, so hand over whatever you cannot do yourself, and never tell the caller something cannot be done.",
  "When the back office gives you a question or a line to confirm, ask it. Keep every name, number, date and time exactly as written.",
  "You cannot hang up. When the caller is finished or says goodbye, do not say goodbye yourself: hand that over, and the back office ends the call and gives you the goodbye to say.",
].join(" ");

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

/** The model reads the agent's `<SystemPrompt>`: who it is and how it sounds. Everything else the
 * agent renders (an `<Instruction>`, text, a skill) is the procedure, which `llm` runs behind it;
 * the model only needs to know what to hand over, and learns the rest from commentary. */
export function voiceInstructions(runtime: AgentSiteRuntime): string {
  return [
    runtime.snapshot().context.systemPrompt ?? "",
    `${BACK_OFFICE_RULES}\n${backOfficeWork(runtime).map((work) => `- ${work}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the model hands over: the agent's tools and skills. */
function backOfficeWork(runtime: AgentSiteRuntime): string[] {
  const { tools, links } = runtime.snapshot().context;
  return [
    ...tools
      .filter((tool) => tool.name !== "skip_turn" && tool.name !== "read_skill")
      .map((tool) => tool.description ?? tool.name),
    ...links.map((link) => `${link.label}${link.description ? `: ${link.description}` : ""}`),
  ];
}

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
    verbatim: descriptor.options.verbatim === true,
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
      closeFromRoom();
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

  let closing: Promise<void> | null = null;
  const closeNow = async () => {
    silence.stop();
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
  session.on(voice.AgentSessionEventTypes.Close, closeFromRoom);

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
        closeFromRoom();
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

  const watchdog = createCallerWatchdog({
    remoteCount: () => [...room.participants()].length,
    giveUp: closeFromRoom,
    log: (message) => logInfo("voice", `${roomName}: ${message}`),
    emptyRoomMs: EMPTY_ROOM_GRACE_MS,
    noCallerMs: NO_CALLER_GRACE_MS,
  });
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
