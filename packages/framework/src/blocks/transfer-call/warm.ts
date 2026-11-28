import type { CallTrace } from "../../call-trace.js";
import type { AgentInfoStore } from "../../info-store.js";
import type { AgentRunRequest, AgentRunResponse } from "../../llm/types.js";
import { HostTimeoutError, HostUnavailableError, type AppMessages } from "../../messages.js";
import {
  consultDecisionRequest,
  readConsultDecision,
  type ConsultReading,
  type ConsultTurn,
} from "./consult-decision.js";
import type { TrackedTransfer } from "./ended.js";
import type { TransferAudio, TransferOutcome } from "./index.js";
import {
  CALL_TRANSFER_DECIDE_MESSAGE,
  CALL_TRANSFER_RESULT_MESSAGE,
  CALL_TRANSFER_WARM_MESSAGE,
  DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS,
  TRANSFER_REPLY_TIMEOUT_MS,
  TRANSFER_RESULT_MARGIN_MS,
  errorText,
  isRecord,
  readRefusal,
} from "./protocol.js";
import {
  WARM_INITIAL_STATE,
  decisionAttempt,
  step,
  warmOutcome,
  warmSettled,
  type WarmDialResult,
  type WarmEffect,
  type WarmEvent,
  type WarmState,
} from "./warm-state.js";

/**
 * A warm transfer: the person at the transfer number is asked before the caller is put through.
 *
 * The caller hears the announcement, then hold audio; the agent stops listening to them. The
 * host dials the person into a consultation room the caller cannot hear (`call.transfer.warm`,
 * accepted with that room's ticket), the voice host joins the agent to it ({@link ConsultLeg}),
 * the agent says the brief, and the model reads each reply as one structured decision
 * (`consult-decision.ts`). `warm-state.ts` decides what follows; this module runs it: the timers,
 * the lines said, `call.transfer.decide` to the host, the call's trace. A yes joins the person to
 * the caller and hands the call off; anything else ends their leg, and the agent takes the
 * caller back with the outcome.
 *
 * Browser-safe: what needs a room or a model comes from the voice host as a
 * {@link WarmTransferHost}, attached per call.
 */

/** What happens at the person's end of the consultation room. */
export type ConsultTargetEvent =
  | { type: "joined" }
  /** One finished reply of the person. */
  | { type: "turn"; text: string }
  | { type: "left" }
  /** The consultation room or its voice failed. */
  | { type: "lost"; message: string };

/** The agent's side of one consultation room. */
export interface ConsultLeg {
  /** Listen to the person's end. Events from before the first listener are delivered to it. */
  onTarget(listener: (event: ConsultTargetEvent) => void): () => void;
  /** Say `text` to the person; resolves once it played, or once they spoke over it or `signal`
   * aborted. */
  say(text: string, signal?: AbortSignal): Promise<void>;
  /** Leave the room. Never rejects. */
  close(): Promise<void>;
}

/** What the voice host of a live call lends a warm transfer. */
export interface WarmTransferHost {
  /** Start the hold audio for the caller. Returns its stop. */
  hold(): () => void;
  /** Stop the agent listening and replying to the caller. Returns what starts it again. */
  pause(): () => void;
  /** The caller hung up. Returns the unsubscribe. */
  onCallerLeft(listener: () => void): () => void;
  /** The person was put through and is with the caller. Returns the unsubscribe. */
  onHandedOff(listener: () => void): () => void;
  /** Join the consultation room with the host's ticket. Rejects when it cannot. */
  openConsult(ticket: { url: string; token: string }, transferId: string): Promise<ConsultLeg>;
  /** One request to the call's model (`AgentSession.ask`). */
  ask(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentRunResponse>;
}

/** Keyed by the runtime's info store, whose identity is the runtime's. */
const warmHostByRuntime = new WeakMap<AgentInfoStore, WarmTransferHost>();

/** Attach (or detach, with `null`) the voice host's {@link WarmTransferHost} to the runtime that
 * owns `info`. The voice host calls it when a call starts, after a rewind, and at call end. */
export function attachWarmTransferHost(info: AgentInfoStore, host: WarmTransferHost | null): void {
  if (host) warmHostByRuntime.set(info, host);
  else warmHostByRuntime.delete(info);
}

/** The warm transfer host of the call the runtime that owns `info` is on. */
export function warmTransferHostOf(info: AgentInfoStore): WarmTransferHost | undefined {
  return warmHostByRuntime.get(info);
}

/** How long a consultation may run from the person's answer when the request names nothing. */
export const DEFAULT_CONSULT_TIMEOUT_SECONDS = 45;
export const MIN_CONSULT_TIMEOUT_SECONDS = 10;
export const MAX_CONSULT_TIMEOUT_SECONDS = 120;

/** The waits a warm transfer keeps, in milliseconds. Tests shorten them. */
export interface WarmTiming {
  /** How long the agent waits for the person's greeting before it says the brief. */
  greetingMs: number;
  /** After `connect`: how long the host may take to put the person through. */
  connectMs: number;
  /** After the end: how long a late `call.transfer.result` is still taken. */
  lingerMs: number;
  /** After the consultation time ran out: how long a reply heard before it may still be read. */
  graceMs: number;
  /** The consultation room ended, or could not be joined, while the phone still rang: how long
   * the host's own result is awaited before the transfer fails. */
  resultWaitMs: number;
}

const TIMING: WarmTiming = {
  greetingMs: 2_500,
  connectMs: 30_000,
  lingerMs: 15_000,
  graceMs: 10_000,
  resultWaitMs: 15_000,
};

/** A validated warm transfer request. */
export interface WarmRequest {
  to: string;
  ringTimeoutSeconds?: number;
  consultTimeoutSeconds?: number;
  brief: string;
  announce?: string;
  onEnded?: TrackedTransfer["onEnded"];
}

export interface WarmDeps {
  messages: AppMessages;
  host: WarmTransferHost;
  audio?: TransferAudio;
  trace?: CallTrace;
  log: (line: string) => void;
  tracking?: {
    track: (transfer: TrackedTransfer) => void;
    untrack: (transferId: string) => void;
  };
  timing?: Partial<WarmTiming>;
}

/** What drives the consultation: the host, the room, the model, the clock. */
type Input =
  | { kind: "leg"; leg: ConsultLeg }
  | { kind: "leg_failed"; message: string }
  | { kind: "target"; event: ConsultTargetEvent }
  | { kind: "result"; outcome: WarmDialResult; dialStatus?: string }
  | { kind: "caller_left" }
  | { kind: "handed_off" }
  | { kind: "timer"; which: "dial" | "consult" | "connect" | "greeting" | "room_gone" }
  | { kind: "decided"; seq: number; reading: ConsultReading | null }
  | { kind: "decide_failed"; seq: number; message: string }
  | { kind: "said"; seq: number; failed?: string };

function mailbox<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  return {
    push(item: T) {
      queue.push(item);
      wake?.();
      wake = null;
    },
    async next(): Promise<T> {
      while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      return queue.shift()!;
    },
  };
}

const DIAL_RESULTS: readonly WarmDialResult[] = ["answered", "declined", "no_answer", "busy", "failed"];

/** One warm transfer, from the announcement to its outcome. */
export async function warmTransfer(deps: WarmDeps, request: WarmRequest): Promise<TransferOutcome> {
  const { messages, host, audio, trace, log } = deps;
  const timing = { ...TIMING, ...deps.timing };
  const inbox = mailbox<Input>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const after = (ms: number, input: Input) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      inbox.push(input);
    }, ms);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer === null) return;
    clearTimeout(timer);
    timers.delete(timer);
  };

  let transferId: string | null = null;
  // Results that arrive before the acceptance names the transfer.
  const early = new Map<string, Record<string, unknown>>();
  let gotResult = false;
  const pushResult = (result: Record<string, unknown>) => {
    gotResult = true;
    const outcome = DIAL_RESULTS.find((known) => known === result.outcome);
    if (outcome === undefined)
      log(`[curb] warm transfer ${transferId}: unknown outcome ${JSON.stringify(result.outcome)}, read as failed`);
    inbox.push({
      kind: "result",
      outcome: outcome ?? "failed",
      ...(typeof result.dialStatus === "string" ? { dialStatus: result.dialStatus } : {}),
    });
  };
  const unsubscribeResults = messages.subscribe("host", CALL_TRANSFER_RESULT_MESSAGE, {
    onMessage: (result) => {
      if (!isRecord(result) || typeof result.transferId !== "string") return;
      if (transferId === null) early.set(result.transferId, result);
      else if (result.transferId === transferId) pushResult(result);
    },
  });
  const unsubscribers = [
    host.onCallerLeft(() => inbox.push({ kind: "caller_left" })),
    host.onHandedOff(() => inbox.push({ kind: "handed_off" })),
  ];

  // The agent stops listening to the caller first, so nothing they say meanwhile starts a reply.
  const resume = host.pause();
  let stopHold = () => {};
  let tracked: string | null = null;
  let answered = false;
  // What the closures below change, kept on one object so every read sees the latest.
  const live: {
    leg: ConsultLeg | null;
    asking: { seq: number; controller: AbortController; at: number } | null;
    speaking: { seq: number; controller: AbortController } | null;
    /** An ended consultation waiting for its closing line to play before the host hears it. */
    ending: Extract<WarmEffect, { type: "end_consult" }> | null;
    endingSeq: number;
    reading: ConsultReading | null;
    /** The room ended before anyone answered: what ends the transfer if the host's result does not. */
    roomGone: WarmEvent | null;
  } = {
    leg: null,
    asking: null,
    speaking: null,
    ending: null,
    endingSeq: -1,
    reading: null,
    roomGone: null,
  };
  let legClosed = false;
  const closeLeg = () => {
    legClosed = true;
    void live.leg?.close();
  };
  try {
    if (request.announce !== undefined) {
      if (!audio) log("[curb] warm transfer: this call has no voice output, so the announcement was not said");
      else {
        try {
          await audio.announce(request.announce);
        } catch (error) {
          // KEEP-JUSTIFIED: an announcement that failed to play must not keep the caller from
          // the person they asked for. The cause is logged; the transfer goes on.
          log(`[curb] warm transfer: the announcement could not be played: ${errorText(error)}`);
        }
      }
    }
    // From here until the outcome the caller hears hold audio, never silence.
    stopHold = host.hold();

    let state: WarmState = WARM_INITIAL_STATE;
    let reply: Record<string, unknown>;
    try {
      reply = await messages.send.askHost(
        CALL_TRANSFER_WARM_MESSAGE,
        {
          to: request.to,
          ...(request.ringTimeoutSeconds === undefined ? {} : { ringTimeoutSeconds: request.ringTimeoutSeconds }),
          ...(request.consultTimeoutSeconds === undefined
            ? {}
            : { consultTimeoutSeconds: request.consultTimeoutSeconds }),
        },
        { timeoutMs: TRANSFER_REPLY_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof HostTimeoutError || error instanceof HostUnavailableError) {
        const message = `the host did not accept or refuse the warm transfer: ${error.message}`;
        log(`[curb] warm transfer failed (transfer_no_reply): ${message}`);
        return { outcome: "failed", code: "transfer_no_reply", message };
      }
      throw error;
    }
    const refusal = readRefusal(reply);
    if (refusal) {
      log(`[curb] warm transfer refused (${refusal.code}): ${refusal.message}`);
      return { outcome: "refused", ...refusal };
    }
    const consult = isRecord(reply.consult) ? reply.consult : {};
    if (
      typeof reply.transferId !== "string" ||
      reply.transferId === "" ||
      typeof consult.url !== "string" ||
      typeof consult.token !== "string"
    ) {
      const id = typeof reply.transferId === "string" && reply.transferId !== "" ? reply.transferId : undefined;
      // Whatever the host dialed is ended: without the room's ticket nobody can be asked.
      if (id)
        messages.send.toHost(CALL_TRANSFER_DECIDE_MESSAGE, {
          transferId: id,
          decision: "failed",
        });
      log(
        "[curb] warm transfer failed (transfer_invalid_reply): the host's reply names no transferId and consultation room, or no code",
      );
      return {
        outcome: "failed",
        code: "transfer_invalid_reply",
        message: "The host's reply to call.transfer.warm names no transferId and consult ticket, or no code.",
        ...(id ? { transferId: id } : {}),
      };
    }
    const id = reply.transferId;
    transferId = id;
    state = step(state, { type: "accepted" }).state;
    const startedAt = Date.now();
    let answeredAt: number | null = null;
    trace?.consult({ kind: "started", transferId: id });
    deps.tracking?.track({
      to: request.to,
      transferId: id,
      onEnded: request.onEnded,
    });
    tracked = id;
    const earlyResult = early.get(id);
    if (earlyResult) pushResult(earlyResult);
    early.clear();

    host.openConsult({ url: consult.url, token: consult.token }, id).then(
      (opened) => inbox.push({ kind: "leg", leg: opened }),
      (error: unknown) => inbox.push({ kind: "leg_failed", message: errorText(error) }),
    );
    const ringSeconds = request.ringTimeoutSeconds ?? DEFAULT_TRANSFER_RING_TIMEOUT_SECONDS;
    let dialTimer: ReturnType<typeof setTimeout> | null = after(ringSeconds * 1000 + TRANSFER_RESULT_MARGIN_MS, {
      kind: "timer",
      which: "dial",
    });
    let consultTimer: ReturnType<typeof setTimeout> | null = null;
    let greetingTimer: ReturnType<typeof setTimeout> | null = null;
    let roomGoneTimer: ReturnType<typeof setTimeout> | null = null;

    const turns: ConsultTurn[] = [];
    const targetLines: string[] = [];
    // Where the conversation is: waiting for the person's hello, saying the brief, listening.
    let stage: "waiting" | "greeting" | "briefing" | "listening" = "waiting";
    let unheard = 0;
    let seq = 0;

    const sayToTarget = (text: string) => {
      live.speaking?.controller.abort();
      const said = ++seq;
      const controller = new AbortController();
      live.speaking = { seq: said, controller };
      turns.push({ speaker: "agent", text });
      trace?.consult({ kind: "turn", transferId: id, speaker: "agent", text });
      if (!live.leg) {
        inbox.push({
          kind: "said",
          seq: said,
          failed: "the consultation room is not joined",
        });
        return said;
      }
      live.leg.say(text, controller.signal).then(
        () => inbox.push({ kind: "said", seq: said }),
        (error: unknown) => inbox.push({ kind: "said", seq: said, failed: errorText(error) }),
      );
      return said;
    };
    const askModel = () => {
      live.asking?.controller.abort();
      const asked = ++seq;
      const controller = new AbortController();
      live.asking = { seq: asked, controller, at: Date.now() };
      unheard = 0;
      host.ask(consultDecisionRequest(turns), controller.signal).then(
        (response) =>
          inbox.push({
            kind: "decided",
            seq: asked,
            reading: readConsultDecision(response),
          }),
        (error: unknown) =>
          inbox.push({
            kind: "decide_failed",
            seq: asked,
            message: errorText(error),
          }),
      );
    };
    const finish = (effect: Extract<WarmEffect, { type: "end_consult" }>) => {
      live.ending = null;
      let decision = effect.decision;
      // The caller left while the closing line played: nobody is there to put through.
      if (decision === "connect" && state.phase === "ended" && state.reason === "caller_left") decision = "failed";
      if (effect.send)
        messages.send.toHost(CALL_TRANSFER_DECIDE_MESSAGE, {
          transferId: id,
          decision,
        });
      trace?.consult({
        kind: "ended",
        transferId: id,
        decision,
        reason: decision === effect.decision ? effect.reason : "caller_left",
        ...(answeredAt === null ? {} : { durationMs: Date.now() - answeredAt }),
      });
      closeLeg();
      if (decision === "connect") after(timing.connectMs, { kind: "timer", which: "connect" });
    };
    /**
     * The room ended, or could not be joined. While the phone still rings, that is most often the
     * host ending the dial, and its result says how (no answer, busy) on a channel of its own
     * that may arrive later: it is awaited for a while before `event` decides.
     */
    const roomEnded = (event: WarmEvent, what: string) => {
      if (state.phase !== "dialing") {
        apply(event);
        return;
      }
      if (live.roomGone) return;
      live.roomGone = event;
      log(`[curb] warm transfer ${id}: ${what} while the phone still rang; waiting up to ${timing.resultWaitMs} ms for the host's result`);
      roomGoneTimer = after(timing.resultWaitMs, { kind: "timer", which: "room_gone" });
    };
    const apply = (event: WarmEvent) => {
      const next = step(state, event);
      state = next.state;
      for (const effect of next.effects) {
        if (effect.type === "ask_again") {
          sayToTarget(live.reading?.say ?? request.brief);
          continue;
        }
        if (effect.type === "grace") {
          // The time bounds waiting for the person, not reading what they said in it.
          const why = live.asking
            ? `while the model read a reply (for ${Date.now() - live.asking.at} ms)`
            : "while a reply waited for the agent's line to finish";
          log(`[curb] warm transfer ${id}: the consultation time ran out ${why}; it may take ${timing.graceMs} ms more`);
          consultTimer = after(timing.graceMs, { kind: "timer", which: "consult" });
          continue;
        }
        cancel(dialTimer);
        cancel(consultTimer);
        cancel(greetingTimer);
        cancel(roomGoneTimer);
        dialTimer = consultTimer = greetingTimer = roomGoneTimer = null;
        live.asking?.controller.abort();
        live.asking = null;
        const farewell = effect.farewell ? live.reading?.say : undefined;
        if (farewell && live.leg) {
          live.ending = effect;
          live.endingSeq = sayToTarget(farewell);
        } else {
          live.speaking?.controller.abort();
          live.speaking = null;
          finish(effect);
        }
      }
    };

    // Until there is an outcome and its closing line, if any, has played.
    while (!(warmSettled(state) && live.ending === null)) {
      const input = await inbox.next();
      switch (input.kind) {
        case "leg":
          live.leg = input.leg;
          // The consultation ended before the room was joined: leave it at once.
          if (legClosed || warmSettled(state)) {
            closeLeg();
            break;
          }
          unsubscribers.push(input.leg.onTarget((event) => inbox.push({ kind: "target", event })));
          break;
        case "leg_failed":
          log(`[curb] warm transfer ${id}: could not join the consultation room: ${input.message}`);
          roomEnded({ type: "join_failed" }, "the consultation room could not be joined");
          break;
        case "target": {
          const event = input.event;
          if (event.type === "joined") {
            if (state.phase !== "dialing") break;
            cancel(dialTimer);
            dialTimer = null;
            answeredAt = Date.now();
            trace?.consult({
              kind: "answered",
              transferId: id,
              durationMs: answeredAt - startedAt,
            });
            apply({ type: "target_joined" });
            const consultSeconds = request.consultTimeoutSeconds ?? DEFAULT_CONSULT_TIMEOUT_SECONDS;
            consultTimer = after(consultSeconds * 1000, {
              kind: "timer",
              which: "consult",
            });
            greetingTimer = after(timing.greetingMs, {
              kind: "timer",
              which: "greeting",
            });
            stage = "greeting";
          } else if (event.type === "turn") {
            const text = event.text.trim();
            if (!text || state.phase !== "consulting") break;
            turns.push({ speaker: "target", text });
            targetLines.push(text);
            trace?.consult({
              kind: "turn",
              transferId: id,
              speaker: "target",
              text,
            });
            if (stage === "greeting") {
              // Their hello: the brief answers it, no decision yet.
              cancel(greetingTimer);
              greetingTimer = null;
              stage = "briefing";
              sayToTarget(request.brief);
              break;
            }
            unheard += 1;
            if (state.phase === "consulting" && state.overtime) {
              // Past the time, the reading under way is the last: words after it never restart it.
              if (!live.asking && !live.speaking) askModel();
            }
            // A reading of the words before these is stale: read them all again.
            else if (live.asking || !live.speaking) askModel();
          } else if (event.type === "left") {
            apply({ type: "target_left" });
          } else {
            log(`[curb] warm transfer ${id}: the consultation room failed: ${event.message}`);
            roomEnded({ type: "error" }, "the consultation room ended");
          }
          break;
        }
        case "result":
          if (input.outcome === "failed" && input.dialStatus)
            log(`[curb] warm transfer ${id}: the dial failed (dial status ${input.dialStatus})`);
          apply({ type: "dial_result", outcome: input.outcome });
          break;
        case "caller_left":
          apply({ type: "caller_left" });
          break;
        case "handed_off":
          apply({ type: "handed_off" });
          break;
        case "timer":
          if (input.which === "greeting") {
            greetingTimer = null;
            if (stage === "greeting" && state.phase === "consulting") {
              stage = "briefing";
              sayToTarget(request.brief);
            }
          } else if (input.which === "room_gone") {
            roomGoneTimer = null;
            if (live.roomGone && state.phase === "dialing") {
              log(`[curb] warm transfer ${id}: no result from the host within ${timing.resultWaitMs} ms`);
              apply(live.roomGone);
            }
          } else if (input.which === "dial") {
            dialTimer = null;
            apply({ type: "dial_timeout" });
          } else if (input.which === "consult") {
            consultTimer = null;
            if (state.phase === "consulting" && state.overtime)
              log(`[curb] warm transfer ${id}: the reply was not read within the grace either`);
            apply({ type: "consult_timeout", replyPending: live.asking !== null || unheard > 0 });
          } else {
            apply({ type: "connect_timeout" });
          }
          break;
        case "said":
          if (live.speaking?.seq === input.seq) live.speaking = null;
          if (live.ending !== null && input.seq === live.endingSeq) {
            finish(live.ending);
            break;
          }
          if (input.failed) {
            log(`[curb] warm transfer ${id}: could not speak in the consultation room: ${input.failed}`);
            apply({ type: "error" });
            break;
          }
          if (stage === "briefing") stage = "listening";
          if (unheard > 0 && !live.asking && state.phase === "consulting") askModel();
          break;
        case "decided": {
          if (live.asking?.seq !== input.seq) break;
          live.asking = null;
          live.reading = input.reading;
          const decision = input.reading?.decision ?? "unclear";
          if (state.phase !== "consulting") break;
          trace?.consult({
            kind: "decision",
            transferId: id,
            decision,
            attempt: decisionAttempt(state),
          });
          apply({ type: "decision", decision });
          break;
        }
        case "decide_failed":
          if (live.asking?.seq !== input.seq) break;
          live.asking = null;
          log(`[curb] warm transfer ${id}: the model could not read the reply: ${input.message}`);
          apply({ type: "error" });
          break;
      }
    }

    const outcome = warmOutcome(state as Extract<WarmState, { phase: "ended" | "handed_off" }>);
    answered = outcome === "answered";
    const targetReply = targetLines.join(" ");
    const reason = state.phase === "ended" ? state.reason : undefined;
    return {
      outcome,
      transferId: id,
      ...(targetReply ? { targetReply } : {}),
      ...(outcome === "failed" && reason ? { message: failureMessage(reason) } : {}),
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    stopHold();
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (!legClosed) closeLeg();
    if (!answered) resume();
    if (tracked !== null && !answered) deps.tracking?.untrack(tracked);
    // The host's own result may still be on its way; one nobody listens for is refused.
    if (gotResult || transferId === null) unsubscribeResults();
    else setTimeout(unsubscribeResults, timing.lingerMs);
  }
}

function failureMessage(reason: string): string {
  switch (reason) {
    case "join_failed":
      return "The agent could not join the consultation room.";
    case "connect_failed":
      return "The person agreed, but the host did not put them through.";
    case "caller_left":
      return "The caller hung up during the transfer.";
    case "dial_failed":
      return "The transfer call failed.";
    case "no_reply":
      return "The host did not answer the warm transfer request.";
    default:
      return "The consultation failed.";
  }
}
