/**
 * LiveKit-backed voice host: the agent participant of one live call.
 *
 * THE voice session of every route: `curb dev`, `curb start` and the built artifact's
 * worker, direct-join and managed modes all run {@link startLivekitVoiceAgent}. A project
 * carries no session code of its own; its voice settings are `<Agent>` props.
 *
 * Voice is an I/O modality of the SAME conversation the connection's chat
 * uses — the host is handed the connection's session bundle and never builds
 * its own. The LiveKit `AgentSession` owns audio, VAD, endpointing and
 * barge-in; curb owns the LLM loop via {@link CurbVoiceAgent}, which drives
 * `bundle.session.runTurnStream(text, { spoken: true })` so spoken turns get
 * the framework's spoken-reply rules on top of the one authored prompt.
 *
 * Kept curb semantics on top of the LiveKit backbone:
 * - the opening (`call-opening.ts`): the caller's `caller.*` info, then for
 *   `firstTurn: "agent"` a greeting that cannot be interrupted, or for
 *   `firstTurn: { say }` the conversation's fixed first line, spoken as written
 *   with no model call and no interruption.
 * - skip_turn: the model's zero-reply turn (llmNode emits nothing).
 * - silence follow-up: after skip_turn, ~6s of continued quiet triggers a
 *   short check-in via `session.generateReply` (recorded as a synthetic
 *   user message so UIs can hide it).
 * - end_call: the model hangs up itself. The tool is only in context while
 *   this host is attached, and the disconnect waits for the closing line to
 *   finish playing (see `../end-call.ts`).
 * - handed-off mode (`transfer-handoff.ts`): while a transfer target is in the room the
 *   agent neither listens nor speaks; when the target leaves and the caller stays it resumes
 *   with a system note, or ends the call, as the transfer's `onEnded` decides.
 * - transfer audio (`transfer-audio.ts`): while a phone call is transferred the caller hears
 *   the transfer's announcement, then a ringback until the outcome, on a track of their own.
 * - typed input mid-call: `handle.sendText` feeds a typed message through
 *   the same pipeline, so the reply is spoken like any other.
 * - clip mapping: each transcript message is annotated with the clip
 *   ordinals of the audio that produced it (exact STT input / TTS output),
 *   served by the dev server's GET /voice/clip route.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeLogger, voice, type VAD } from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import type { AgentSessionBundle } from "../../connection.js";
import type { VoiceCallRoom } from "../call-room.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import {
  buildVoiceProviders,
  buildVoiceStt,
  buildVoiceTts,
  type VoiceProviders,
} from "../providers.js";
import { logError, logInfo } from "../../log.js";
import { AGENT_FIRST_TURN_PROMPT, createCallOpening } from "./call-opening.js";
import { EMPTY_ROOM_GRACE_MS, createCallerWatchdog } from "./caller-watchdog.js";
import { createSilenceFollowup } from "./silence-followup.js";
import type {
  VoiceSessionHandle,
  VoiceSessionStartOptions,
} from "../orchestration.js";
import { createEndCallHangup, type SpokenReply } from "../end-call.js";
import { ConversationClips } from "./clip-store.js";
import { CurbLLMStub, CurbVoiceAgent } from "./curb-agent.js";
import { voiceAgentClass, voiceSessionOptions } from "./pipeline.js";
import { createProviderSwitch } from "./provider-swap.js";
import { attachTransferAudio } from "../../../transfer.js";
import { livekitCallRoom } from "./livekit-call-room.js";
import { startS2sCall } from "../s2s/call.js";
import { createTransferAudio, synthesizedFrames } from "./transfer-audio.js";
import { reportVoiceLatencies } from "./latency.js";
import {
  TRANSFER_ENDED_PROMPT,
  callerSide,
  createTransferHandoff,
  isTransferTarget,
  settleTransferEnded,
} from "./transfer-handoff.js";
import { decideTransferEnded, moveTrackedTransfer } from "../../../transfer-ended.js";

// agents-js asserts its logger exists before any session work; the worker
// CLI normally does this — we host sessions directly, so do it here.
initializeLogger({ pretty: false, level: process.env.LIVEKIT_AGENTS_LOG_LEVEL ?? "warn" });

// The rtc-node NATIVE logger (pino "lk-rtc") is separate, defaults to debug,
// and prints raw JSON lines into dev logs. It exposes no level API and its
// exports map hides the module — resolve the file directly; the package's own
// relative imports share the instance, so setting the level here quiets it.
try {
  const require = createRequire(import.meta.url);
  const distDir = dirname(require.resolve("@livekit/rtc-node"));
  const { log } = (await import(pathToFileURL(join(distDir, "log.js")).href)) as {
    log: { level: string };
  };
  log.level = process.env.LIVEKIT_RTC_LOG_LEVEL ?? "warn";
} catch {
  // KEEP-JUSTIFIED: cosmetic log-noise control over a private module path —
  // an rtc-node layout change must not break voice, it only gets noisier.
}

/** Synthetic input for the silence follow-up (same contract as before). */
const SILENCE_FOLLOWUP_PROMPT =
  "(The user has been quiet for about six seconds since you skipped your turn. Check in now with one short, natural line — vary it, never reuse an earlier check-in. If they had asked you to wait, acknowledge the wait — something like \"No rush — I'm here.\" Otherwise something like \"Still there?\", or pick up their trailing thought. Do not call skip_turn.)";

/**
 * How long the agent waits for a caller who has never arrived.
 *
 * A SEPARATE, LONGER DEADLINE, because "left" and "never came" are different situations.
 * Fifteen seconds is a sensible pause after a known participant disappears; applied to the
 * initial wait it would hang up on anyone whose browser is slow to negotiate ICE.
 *
 * WITHOUT THIS THE RUNNER WAITS FOREVER. The empty-room timer below is armed only by
 * `ParticipantDisconnected`, so a caller who never connects never disconnects, and nothing
 * ever starts it: the agent sits in an empty room holding a session — and, on a hosted
 * platform, a capacity slot — until something outside kills it. Measured, not theorised:
 * five runners were found alive with 5 to 9 minutes of uptime, each logging `agent joined
 * room` and no participant, on a platform whose only remaining backstop was the
 * capacity-reservation ceiling.
 */
const NO_CALLER_GRACE_MS = 60_000;

/**
 * What a warm (managed) runner hands a call instead of building it on the call path.
 *
 * Every field is optional and absent on `curb dev` and the cold hosted path, which then
 * build exactly what they always built, in the order they always built it.
 */
export type LivekitVoiceStartOptions = VoiceSessionStartOptions & {
  /** Silero VAD loaded once before `ready`. Shared: each session opens its own stream. */
  vad?: VAD;
  /** STT/TTS already built for THIS call, connecting while the room was. If the
   * conversation's settings differ by the time the session starts, the call swaps at once. */
  providers?: VoiceProviders;
  /** Called once, on the monotonic clock, when the first agent audio frame is published. */
  onFirstAudio?: (monotonicMs: number) => void;
};

/** Loads the VAD model. The expensive step a warm runner moves before `ready`. */
export function loadSileroVad(): Promise<VAD> {
  return silero.VAD.load({
    minSpeechDuration: 0.15,
    minSilenceDuration: 0.2,
    activationThreshold: 0.55,
  });
}

/** The subset of `voice.AgentSession` the first-audio watch needs, so it is testable. */
type AgentStateSource = {
  on(
    event: typeof voice.AgentSessionEventTypes.AgentStateChanged,
    listener: (event: { newState: string }) => void,
  ): unknown;
  off(
    event: typeof voice.AgentSessionEventTypes.AgentStateChanged,
    listener: (event: { newState: string }) => void,
  ): unknown;
};

/**
 * Call `onFirstAudio` once, when the agent first reaches `speaking`.
 *
 * LiveKit sets `speaking` when the audio output reports its first frame captured for
 * playout, i.e. the first agent frame published into the room. That is the moment a
 * caller can first hear the agent, and the end of the warm-runner latency budget.
 */
export function watchFirstAgentAudio(
  session: AgentStateSource,
  onFirstAudio: (monotonicMs: number) => void,
  now: () => number = () => performance.now(),
): void {
  const event = voice.AgentSessionEventTypes.AgentStateChanged;
  const listener = (change: { newState: string }) => {
    if (change.newState !== "speaking") return;
    session.off(event, listener);
    try {
      onFirstAudio(now());
    } catch (error) {
      // KEEP-JUSTIFIED: latency telemetry must not terminate a person's call. The failure
      // is loud in the runner log, and the record is simply absent rather than invented.
      logError(
        "voice",
        `could not report first agent audio: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  session.on(event, listener);
}

/** The reply being spoken, as a graceful close sees it. LiveKit's `SpeechHandle` fits. */
export type PlayingReply = SpokenReply & {
  /** True once the reply has finished playing or was cut short. */
  done(): boolean;
};

/**
 * Wait for the current reply to finish playing, but never longer than `graceMs`.
 *
 * Returns `idle` without waiting when there is no grace or nothing left to play,
 * `played` when the reply finished inside the grace, and `timed-out` otherwise.
 */
export async function waitForCurrentReply(
  reply: PlayingReply | null,
  graceMs: number,
): Promise<"idle" | "played" | "timed-out"> {
  if (!(graceMs > 0) || reply === null || reply.done()) return "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timed-out"), graceMs);
  });
  try {
    return await Promise.race([reply.waitForPlayout().then(() => "played" as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run the voice session on an already-connected agent room until it empties.
 * Returns a handle for explicit teardown. */
export function startLivekitVoiceAgent(options: LivekitVoiceStartOptions): Promise<VoiceSessionHandle> {
  return startVoiceAgent({ ...options, room: livekitCallRoom(options.room, options.roomName) });
}

/** {@link LivekitVoiceStartOptions} on any transport: a LiveKit room or the page's socket. */
export type VoiceAgentStartOptions = Omit<LivekitVoiceStartOptions, "room"> & { room: VoiceCallRoom };

/** Run the voice session on a call (see `../call-room.ts`) until it empties. Returns a
 * handle for explicit teardown. */
export async function startVoiceAgent(options: VoiceAgentStartOptions): Promise<VoiceSessionHandle> {
  // `<Agent s2s>`: the model is the whole voice, so that call shares nothing below (see `../s2s/`).
  if (options.bundle.runtime.settings.s2s()) return startS2sCall(options);
  const env = options.env ?? process.env;
  // Mutable: the connection swaps in a rebuilt bundle on rewind; every
  // handler reads it at call time.
  let bundle = options.bundle;
  // The caller's app may already be talking to the agent: serve it before the slow part
  // (providers, VAD) rather than after.
  const clientMessages = options.client;
  clientMessages.bind(bundle.runtime);
  const clips = new ConversationClips();
  // Clip mapping: user clips close one per STT final; a committed turn may
  // merge several finals, so each turn claims the ordinal range it consumed.
  let finalsSeen = 0;
  let finalsConsumed = 0;
  // Assistant clips close one per spoken reply (conversation_item_added).
  let assistantClipsSeen = 0;
  // Typed messages injected via sendText — distinguished from STT turns so
  // they don't claim user audio clips.
  const pendingTyped: string[] = [];

  // A warm runner hands both in; everything else builds them here from the conversation's
  // effective settings (`<Agent stt tts>`, the active `<Skill>`'s override).
  const initialProviders: VoiceProviders =
    options.providers ??
    (await buildVoiceProviders({
      settings: bundle.runtime.settings.current(),
      env,
      reporter: options.reporter,
    }));
  const { stt, tts } = initialProviders;
  const vad = options.vad ?? (await loadSileroVad());

  const room = options.room;

  let session: voice.AgentSession | null = null;
  // What a phone caller hears while their call is transferred: the announcement, then a
  // ringback until the outcome. On a track of its own; see transfer-audio.ts.
  const transferAudio = createTransferAudio({
    publish: () => room.publishTransferTrack(),
    synthesize: (text) => {
      // Spoken outside any reply, like the fixed first line, so it is reported here.
      options.reporter?.turn({ speaker: "agent", text, final: true });
      return synthesizedFrames(providerSwitch.current().tts, text);
    },
    log: (message) => logError("voice", `${options.roomName}: transfer audio: ${message}`),
  });
  // The note the agent last resumed with after a transfer, so its turn reads as synthetic.
  let transferPrompt = TRANSFER_ENDED_PROMPT;
  // A transfer's onEnded that failed, or whose goodbye did not play: logged and in the record.
  const reportTransferEnded = (message: string) => {
    logError("voice", `${options.roomName}: ${message}`);
    options.reporter?.event("error", { kind: "transfer_ended", message });
  };
  // Handed-off mode: a transfer target is on the call, so the agent neither listens nor
  // speaks until it leaves while the caller stays; then the transfer's onEnded decides.
  // See transfer-handoff.ts and transfer-ended.ts.
  const handoff = createTransferHandoff({
    participants: () => room.participants(),
    pause: () => {
      silence.cancel();
      // The target is on the line: the ringback is over even before the outcome arrives.
      transferAudio.stop();
      const active = session;
      if (!active) return;
      active.input.setAudioEnabled(false);
      active.output.setAudioEnabled(false);
      // A reply already playing would talk over the caller and the target.
      if (active.agentState === "speaking") active.interrupt({ force: true });
      options.reporter?.event("transfer_handed_off", {});
    },
    resume: () => {
      const active = session;
      if (!active) return;
      // The agent stays quiet until the transfer's onEnded decided (a function gets at most
      // TRANSFER_ENDED_TIMEOUT_MS); without one this resolves at once with `continue`.
      void settleTransferEnded(() => decideTransferEnded(bundle.runtime.info, { error: reportTransferEnded }), {
        stale: () => closing !== null || handoff.handedOff() || callerSide(room.participants()).length === 0,
        resume: (prompt) => {
          active.input.setAudioEnabled(true);
          active.output.setAudioEnabled(true);
          options.reporter?.event("transfer_resumed", {});
          transferPrompt = prompt;
          active.generateReply({ userInput: prompt });
        },
        sayGoodbye: (goodbye) => transferAudio.announce(goodbye),
        endCall: () => {
          options.reporter?.event("transfer_ended_call", {});
          closeFromRoom();
        },
        log: (message) => logInfo("voice", `${options.roomName}: ${message}`),
        error: reportTransferEnded,
      }).catch((error: unknown) => {
        // KEEP-JUSTIFIED: runs outside the room event that started it, and even the recovery
        // failed; the cause is logged and the call stays up for the caller to end.
        const message = error instanceof Error ? error.message : String(error);
        logError("voice", `${options.roomName}: taking the call back after a transfer failed: ${message}`);
      });
    },
    log: (message) => logInfo("voice", `${options.roomName}: ${message}`),
  });
  const silence = createSilenceFollowup({
    delayMs: Number(env.VOICE_SILENCE_FOLLOWUP_MS ?? 6000),
    handedOff: () => handoff.handedOff(),
    reply: () => session?.generateReply({ userInput: SILENCE_FOLLOWUP_PROMPT }),
    onError: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      logError("voice", `${options.roomName}: silence check-in failed: ${detail}`);
    },
  });

  /** One spoken turn on the shared session. Typed and synthetic inputs claim
   * no user clips; STT turns claim the final ordinals they merged. */
  async function* runCurbTurn(userText: string, signal: AbortSignal) {
    const typedAt = pendingTyped.indexOf(userText);
    const typed = typedAt >= 0;
    if (typed) pendingTyped.splice(typedAt, 1);
    const synthetic =
      userText === SILENCE_FOLLOWUP_PROMPT ||
      userText === AGENT_FIRST_TURN_PROMPT ||
      userText === transferPrompt;
    const from = finalsConsumed;
    const to = finalsSeen - 1;
    if (!typed && !synthetic) finalsConsumed = finalsSeen;
    try {
      yield* bundle.session.runTurnStream(userText, {
        spoken: true,
        signal,
        // Every reply is reported below, so a read-back is heard only once it played to its end.
        readBackHeardOnPlayout: true,
        ...(synthetic ? { kind: "synthetic" as const } : {}),
      });
    } finally {
      if (!typed && !synthetic && to >= from) {
        const ordinals = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        bundle.session.annotateAudio("user", { room: options.roomName, role: "user", ordinals });
      }
    }
  }

  // Every agent of this call is built here: the first one, and one per provider swap.
  const VoiceAgent = voiceAgentClass(options.pipeline);
  const createAgent = (swap: Pick<ConstructorParameters<typeof CurbVoiceAgent>[0], "id" | "stt" | "tts" | "chatCtx">) =>
    new VoiceAgent({
      // Placeholder only — curb compiles its own system prompt per turn inside
      // runTurnStream; LiveKit's instructions never reach the model.
      instructions: "curb agent (context compiled per turn by the curb runtime)",
      runTurn: (userText, signal) => runCurbTurn(userText, signal),
      clips,
      reporter: options.reporter,
      callbacks: { onSkipTurn: silence.arm },
      ...swap,
    });
  const agent = createAgent({ id: "curb_agent_0" });

  session = new voice.AgentSession(
    voiceSessionOptions(
      {
        stt,
        tts,
        vad,
        llm: new CurbLLMStub(),
        turnHandling: {
          turnDetection: "vad",
          // Interruption strategy: plain
          // VAD, not the adaptive ML detector.
          interruption: { mode: "vad" },
          endpointing: {
            minDelay: Number(env.VOICE_ENDPOINTING_MIN_MS ?? 300),
            maxDelay: Number(env.VOICE_ENDPOINTING_MAX_MS ?? 3000),
          },
        },
      },
      options.pipeline,
    ),
  );
  options.pipeline?.onSession?.({
    session,
    roomName: options.roomName,
    events: voice.AgentSessionEventTypes,
  });

  // Mid-call provider swaps: the tree's effective stt/tts changed (a re-render with another
  // prop, or the active skill switched to one with its own). See provider-swap.ts.
  const providerSwitch = createProviderSwitch({
    session,
    initial: initialProviders,
    initialAgent: agent,
    createAgent,
    build: {
      stt: (descriptor) => buildVoiceStt({ descriptor, env, reporter: options.reporter }),
      tts: (descriptor) => buildVoiceTts({ descriptor, env }),
    },
    log: (message) => logInfo("voice", `${options.roomName}: ${message}`),
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logError("voice", `${options.roomName}: provider swap failed, keeping the current one: ${message}`);
      options.reporter?.event("error", { kind: "provider_swap", message });
    },
  });

  // Any user speech cancels a pending follow-up (they came back on their own);
  // a FINAL closes the current user debug clip (one clip per user message).
  // The SDK closes the session itself when the caller leaves, before `close` below runs.
  session.on(voice.AgentSessionEventTypes.Close, silence.stop);
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
    silence.cancel();
    if (event.isFinal) {
      finalsSeen += 1;
      clips.finish("user");
    }
  });
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    if (event.newState === "speaking") silence.cancel();
  });
  if (options.onFirstAudio) watchFirstAgentAudio(session, options.onFirstAudio);

  // The caller's info, then the greeting or the fixed first line. The agent may be in the room
  // before its caller (`curb dev`, a hosted runner) or after (a dispatched worker), so both wait
  // for a caller; the opening also waits for the session to run. See call-opening.ts.
  const agentSession = session;
  const opening = createCallOpening({
    firstTurn: options.firstTurn,
    // A transfer target is never the caller.
    participants: () => callerSide(room.participants()),
    // Read at call time: a rewind swaps the bundle.
    recordCaller: (info) => {
      bundle.session.updateInfo(info);
      // A phone call may be transferred: publish the transfer audio track now, so the phone
      // line has subscribed to it before an announcement's first word plays on it.
      if (info["caller.phoneNumber"]) {
        void transferAudio.prepare().catch((error: unknown) => {
          // KEEP-JUSTIFIED: the call goes on without it; a transfer tries again and logs.
          logError("voice", `${options.roomName}: transfer audio track not published: ${String(error)}`);
        });
      }
    },
    openConversation: () => bundle.session.open(),
    generateReply: (reply) => agentSession.generateReply(reply),
    // The fixed line never reaches llmNode, which reports the model's turns: it is reported here.
    // Its audio clip and a cut-off reconcile like any reply's (ConversationItemAdded below).
    say: (text, sayOptions) => {
      options.reporter?.turn({ speaker: "agent", text, final: true });
      return agentSession.say(text, sayOptions);
    },
  });
  // Runs inside the call's room events (rtc-node's, on LiveKit), where a throw would escape
  // into its event loop and could end every call this process serves, and once the session starts, where a throw (a
  // `firstTurn: { say }` function that returns no line) would fail a call that can go on.
  const openCall = (step: () => void = () => opening.update()) => {
    try {
      step();
    } catch (error) {
      // KEEP-JUSTIFIED: the caller can still speak to an agent that failed to greet; the
      // cause is logged and lands in the call's record.
      const message = error instanceof Error ? error.message : String(error);
      logError("voice", `${options.roomName}: could not open the call: ${message}`);
      options.reporter?.event("error", { kind: "call_opening", message });
    }
  };
  room.onParticipantConnected(() => openCall());
  // A caller already in the room is on the conversation before anything else can run.
  openCall();

  // A reply finished playing (fully or interrupted): close its debug clip,
  // map it onto the transcript message, and — for barge-ins — rewrite curb's
  // history entry to the playback-synchronized (word-timestamp-aligned)
  // prefix the user actually heard.
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
    const item = event.item;
    if (item.type === "agent_handoff") {
      // The previous agent's activity has closed: what the swap replaced can close too.
      providerSwitch.handedOver(item.newAgentId);
      return;
    }
    if ("metrics" in item) {
      try {
        reportVoiceLatencies(options.reporter, item.metrics);
      } catch (error) {
        // KEEP-JUSTIFIED: latency telemetry must not terminate a person's call. The
        // malformed measurement is still loud in the runner log and is not stored as a
        // plausible-looking zero.
        logError(
          "voice",
          `could not report conversation latency: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!("role" in item) || item.role !== "assistant" || !("interrupted" in item)) return;
    clips.finish("assistant"); // one debug clip per spoken reply
    const ordinal = assistantClipsSeen;
    assistantClipsSeen += 1;
    bundle.session.annotateAudio("assistant", {
      room: options.roomName,
      role: "assistant",
      ordinals: [ordinal],
    });
    if (!item.interrupted) {
      bundle.session.replyPlayed();
      return;
    }
    const spoken = ("textContent" in item ? item.textContent : undefined) ?? "";
    // The LENGTH is the diagnosis. If it matches the generated reply, LiveKit
    // did not cut anything — the aligned-transcript path was off, or the TTS
    // returned no word timings — and nothing downstream can recover a cut point
    // that was never computed.
    logInfo(
      "voice",
      `interrupted reply reconciled — heard ${spoken.length} chars: ${JSON.stringify(spoken.slice(0, 80))}`,
    );
    bundle.session.reconcileInterruptedReply(spoken);
  });

  // The reply being spoken right now. `end_call` waits on this handle's
  // playout before disconnecting; LiveKit creates one per reply, and while a
  // reply is playing no other speech can be created (interruption replaces
  // it), so the newest handle is the one carrying the model's closing line.
  let currentReply: PlayingReply | null = null;
  session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) => {
    currentReply = event.speechHandle;
  });

  await room.startSession({
    session,
    agent,
    /**
     * A typed message on the call's own channel is a caller turn: reported, then answered the
     * SDK's own way (`interrupt`, then `generateReply`), kept deliberately: this hook exists to
     * observe the turn, not to change how it is answered. Except that it first lets the
     * greeting finish: LiveKit refuses to interrupt a reply that disallows interruptions, so
     * the message would be lost.
     */
    onTypedText: async (activeSession, text) => {
      options.reporter?.turn({ speaker: "caller", text, final: true });
      await opening.greeted();
      activeSession.interrupt();
      activeSession.generateReply({ userInput: text });
    },
  });
  openCall(() => opening.sessionStarted());
  logInfo("voice", `voice agent joined call ${options.roomName}`);
  // Follow the conversation's provider settings from here on, and catch up once in case
  // they moved between building the providers and starting the session.
  const followSettings = () => {
    const settings = bundle.runtime.settings;
    void providerSwitch.apply(settings.current());
    return settings.subscribe((next) => void providerSwitch.apply(next));
  };
  let unfollowSettings = followSettings();

  let closing: Promise<void> | null = null;
  const close = (closeOptions: { graceMs?: number } = {}): Promise<void> => {
    closing ??= closeNow(closeOptions.graceMs ?? 0);
    return closing;
  };
  const closeNow = async (graceMs: number) => {
    silence.stop();
    try {
      const outcome = await waitForCurrentReply(currentReply, graceMs);
      if (outcome !== "idle") logInfo("voice", `closing ${options.roomName}: current reply ${outcome}`);
    } catch (error) {
      // KEEP-JUSTIFIED: the grace is a courtesy to the caller; a reply that fails to play
      // out must not keep the call from ending. The cause is logged.
      const detail = error instanceof Error ? error.message : String(error);
      logError("voice", `closing ${options.roomName}: waiting for the current reply failed: ${detail}`);
    }
    clientMessages.detach();
    unfollowSettings();
    // There is no call to end any more — take end_call back out of context.
    bundle.runtime.setEndCallRequest(null);
    attachTransferAudio(bundle.runtime.info, null);
    const cleanup = [
      // First: a ringback still playing stops with the call.
      transferAudio.close(),
      session?.close(),
      room.disconnect(),
      providerSwitch.close(),
    ].filter((pending): pending is Promise<void> => pending !== undefined);
    const results = await Promise.allSettled(cleanup);
    logInfo("voice", `voice agent left call ${options.roomName}`);
    options.onClosed?.();
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    // REPORTED, NEVER THROWN. This runs when a call is already over: the room is
    // gone, the participants have left, and there is nothing a caller could do
    // with the failure except log it — which happens here, with the cause.
    //
    // Throwing cost a running dev server. `@livekit/agents` can reject inside
    // its own session close (`Cannot read properties of undefined (reading
    // 'currentSpeech')`), and the callers that hang up fire this as
    // `void call.close()`; an unhandled rejection then takes the whole process
    // down. A bug in someone else's teardown must not end a session that had
    // already finished successfully.
    for (const failure of failures) {
      const detail = failure instanceof Error ? (failure.stack ?? failure.message) : String(failure);
      logError("voice", `closing voice session ${options.roomName} left something behind: ${detail}`);
    }
  };

  const closeFromRoom = () => {
    void close().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      logError("voice", `failed to close room ${options.roomName}: ${detail}`);
    });
  };

  // The model's own hang-up: `end_call` exists in the compiled context only
  // while it is registered, so it appears with this call and leaves with it.
  const hangup = createEndCallHangup({
    currentReply: () => currentReply,
    close: closeFromRoom,
    onCancelled: () => bundle.runtime.endCallCancelled(),
    log: (message) => logInfo("voice", message),
    onError: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      logError("voice", `end_call could not hang up room ${options.roomName}: ${detail}`);
    },
  });
  bundle.runtime.setEndCallRequest(hangup.request);
  attachTransferAudio(bundle.runtime.info, transferAudio);

  // Tear down when the human leaves (the browser tab closed / hung up).
  //
  // On a GRACE, not immediately. "Zero remote participants" means "the human hung up"
  // only when the human was there first, which holds for `curb dev`: the browser opens
  // the room and the agent is dispatched into it. It does not hold on the hosted path,
  // where the agent joins FIRST and the caller arrives after. There, any transient
  // moment with an empty room read as a hangup and tore down a call the caller was
  // still on, right after the first reply.
  //
  // An empty room now starts a timer, and anyone joining cancels it. A caller who
  // really left stays gone and the timer still fires; a caller whose transport blinked
  // keeps their call.
  // The rule itself lives in `caller-watchdog.ts` and is tested there. This block is only
  // the wiring: room events in, one decision out.
  // Runs inside rtc-node's room events, where a throw would escape into its event loop.
  const followHandoff = (step: () => void) => {
    try {
      step();
    } catch (error) {
      // KEEP-JUSTIFIED: the call goes on between caller and target either way; the cause is
      // logged and lands in the call's record.
      const message = error instanceof Error ? error.message : String(error);
      logError("voice", `${options.roomName}: transfer hand-off failed: ${message}`);
      options.reporter?.event("error", { kind: "transfer_handoff", message });
    }
  };
  const watchdog = createCallerWatchdog({
    // A transfer target alone does not keep the call: the caller leaving ends it.
    remoteCount: () => [...room.participants()].filter((p) => !isTransferTarget(p)).length,
    giveUp: closeFromRoom,
    log: (message) => logInfo("voice", `${options.roomName}: ${message}`),
    emptyRoomMs: EMPTY_ROOM_GRACE_MS,
    noCallerMs: NO_CALLER_GRACE_MS,
  });

  room.onParticipantDisconnected((participant) => {
    logInfo(
      "voice",
      `participant left ${options.roomName}: ${participant?.identity ?? "unknown"} ` +
        `(remaining=${[...room.participants()].length})`,
    );
    watchdog.onParticipantLeft();
    if (participant) followHandoff(() => handoff.onParticipantLeft(participant));
  });
  room.onParticipantConnected((participant) => {
    logInfo("voice", `participant joined ${options.roomName}: ${participant?.identity ?? "unknown"}`);
    watchdog.onParticipantJoined();
    if (participant) followHandoff(() => handoff.onParticipantJoined(participant));
  });

  // Armed at the point the agent is in the room and waiting, which is the only moment the
  // never-arrived case becomes distinguishable: from here, either somebody joins or nobody
  // ever does.
  watchdog.armForArrival();

  room.onDisconnected((reason) => {
    // The AGENT lost the room. No grace: there is nothing left to keep alive.
    logInfo("voice", `agent disconnected from ${options.roomName}: reason=${reason}`);
    closeFromRoom();
  });

  return {
    close,
    clips,
    sendText: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      silence.cancel();
      const activeSession = session;
      if (!activeSession) return;
      // The greeting cannot be interrupted, and LiveKit throws rather than queue when
      // asked to: a message typed during it is answered once it has played.
      await opening.greeted();
      // A typed turn is semantically the same barge-in as speech. Wait until
      // LiveKit commits the interrupted, playback-aligned assistant item so
      // curb reconciles the heard prefix before the next turn reads history.
      await activeSession.interrupt().await;
      pendingTyped.push(trimmed);
      activeSession.generateReply({ userInput: trimmed, inputModality: "text" });
    },
    setBundle: (next: AgentSessionBundle) => {
      // The call survives a rewind, so the hang-up has to move with it onto
      // the rebuilt runtime — otherwise end_call would quietly vanish.
      bundle.runtime.setEndCallRequest(null);
      attachTransferAudio(bundle.runtime.info, null);
      // A transfer under way goes on in the rebuilt runtime, with its onEnded.
      moveTrackedTransfer(bundle.runtime.info, next.runtime.info);
      bundle = next;
      clientMessages.bind(bundle.runtime);
      unfollowSettings();
      unfollowSettings = followSettings();
      bundle.runtime.setEndCallRequest(hangup.request);
      attachTransferAudio(bundle.runtime.info, transferAudio);
    },
    interrupt: () => {
      silence.cancel();
      session?.interrupt({ force: true });
    },
  };
}
