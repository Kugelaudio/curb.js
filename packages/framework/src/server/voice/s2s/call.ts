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
import { createCallOpening } from "../livekit-host/call-opening.js";
import { createCallerWatchdog, EMPTY_ROOM_GRACE_MS } from "../livekit-host/caller-watchdog.js";
import { ConversationClips } from "../livekit-host/clip-store.js";
import type { VoiceAgentStartOptions } from "../livekit-host/host.js";
import { voiceSessionOptions } from "../livekit-host/pipeline.js";
import { callerSide } from "../livekit-host/transfer-handoff.js";
import { createEndCallHangup } from "../end-call.js";
import type { AgentSessionBundle } from "../../connection.js";
import type { VoiceSessionHandle } from "../orchestration.js";
import { createBackOffice } from "./back-office.js";
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
/** Quiet after the model's line this long, and `llm` is asked whether the call is over. */
const QUIET_MS = 6_000;
const NO_CALLER_GRACE_MS = 60_000;

/** The model starts with the agent's prompt and learns the rest from commentary; it only needs
 * to know what to hand over. */
export function voiceInstructions(runtime: AgentSiteRuntime, firstLine: string | null): string {
  return [
    runtime.snapshot().context.systemPrompt ?? "",
    `${BACK_OFFICE_RULES}\n${backOfficeWork(runtime).map((work) => `- ${work}`).join("\n")}`,
    firstLine ? `Open the call with this line, in these words: ${JSON.stringify(firstLine)}` : "",
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

  let modelVoice: S2sVoice | null = null;
  const backOffice = createBackOffice({ session: () => bundle.session, voice: () => modelVoice?.channel() ?? null });
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
  });
  const { model: voiceModel, tools } = modelVoice;

  const session = new voice.AgentSession(voiceSessionOptions({ llm: voiceModel }, options.pipeline));
  options.pipeline?.onSession?.({ session, roomName, events: voice.AgentSessionEventTypes });

  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    clearTimeout(quietTimer);
    if (newState === "speaking") backOffice.callerStarted();
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, ({ newState }) => {
    if (newState === "speaking") clearTimeout(quietTimer);
  });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) return;
    const text = item.textContent?.trim();
    if (!text) return;
    backOffice.heard(item.role, text);
    clearTimeout(quietTimer);
    if (item.role === "assistant") quietTimer = setTimeout(() => backOffice.quiet(), QUIET_MS);
    options.reporter?.turn({ speaker: item.role === "user" ? "caller" : "agent", text, final: true });
  });

  let closing: Promise<void> | null = null;
  const closeNow = async () => {
    clearTimeout(quietTimer);
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

  // A model may speak as soon as its session starts, so that waits for a caller.
  let ready: Promise<void> | null = null;
  const startModel = () => {
    const firstLine = bundle.session.open();
    const agent = new voice.Agent({ instructions: voiceInstructions(bundle.runtime, firstLine), tools });
    ready = room
      .startSession({ session, agent, onTypedText: async (_session, text) => void backOffice.typed(text) })
      .then(() => {
        if (firstLine || options.firstTurn === "agent") session.generateReply({ instructions: "Open the call now." });
      });
    ready.catch((error: unknown) => {
      logError("voice", `${roomName}: could not start the call: ${String(error)}`);
      closeFromRoom();
    });
  };
  const opening = createCallOpening({
    firstTurn: undefined,
    participants: () => callerSide(room.participants()),
    recordCaller: (info) => bundle.session.updateInfo(info),
    openConversation: () => {
      startModel();
      return null;
    },
    generateReply: () => ({ done: () => true, waitForPlayout: async () => {} }),
    say: () => ({ done: () => true, waitForPlayout: async () => {} }),
  });
  room.onParticipantConnected(() => opening.update());
  opening.sessionStarted();

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
