/**
 * Where a warm transfer is, and what moves it on: the runtime's state machine, pure, so every
 * transition is tested without a room, a model or a host (`warm-state.test.ts`).
 *
 * A warm transfer asks the person at the transfer number first. The host dials them into a
 * consultation room the caller is not in; the agent tells them who is calling and why, and each
 * of their replies gets one decision from the model: `yes`, `no`, `unclear` or `voicemail`. How
 * often a reply was unclear is counted here, never by the model: the first unclear reply is asked
 * again, the second declines.
 *
 * The consultation time bounds the wait for the person, never the agent's own reading: a reply
 * heard before it ran out and not decided yet gets one grace to be read. A yes, a no or a
 * voicemail then counts as ever; anything else, or a grace that runs out too, ends the
 * consultation unanswered, without asking again.
 *
 * `step` takes the state and one event and returns the next state and what to do: ask again,
 * or end the consultation with a decision for the host (`call.transfer.decide`). `warm.ts` runs
 * the effects.
 */

/** What the model reads one reply of the person as. */
export type ConsultDecision = "yes" | "no" | "unclear" | "voicemail";

/** What the agent tells the host with `call.transfer.decide`. */
export type WarmHostDecision = "connect" | "decline" | "no_answer" | "failed";

/** Why a consultation ended, as the call's timeline records it. */
export type ConsultEndReason =
  | "confirmed"
  | "declined"
  | "unclear_twice"
  | "voicemail"
  | "consult_timeout"
  | "target_left"
  | "dial_no_answer"
  | "dial_busy"
  | "dial_failed"
  | "join_failed"
  | "error"
  | "caller_left";

/** What a warm transfer came to. `answered`: the caller is with the person now. */
export type WarmOutcome = "answered" | "declined" | "no_answer" | "busy" | "failed" | "refused";

/** A dial outcome the host reports in `call.transfer.result`. */
export type WarmDialResult = "answered" | "declined" | "no_answer" | "busy" | "failed";

export type WarmEvent =
  /** The host accepted the request and sent the consultation room's ticket. */
  | { type: "accepted" }
  /** The host refused the request: nothing was dialed. */
  | { type: "refused" }
  /** The host neither accepted nor refused in time. */
  | { type: "no_reply" }
  /** The agent could not join the consultation room. */
  | { type: "join_failed" }
  /** The person answered: they are in the consultation room. */
  | { type: "target_joined" }
  /** Neither the person nor a dial result arrived within the ring time and its margin. */
  | { type: "dial_timeout" }
  | { type: "dial_result"; outcome: WarmDialResult }
  /** The model's reading of one reply of the person. */
  | { type: "decision"; decision: ConsultDecision }
  /** The consultation time ran out. `replyPending`: a reply of the person heard before it ran out
   * is not decided yet (the model is reading it, or it waits for the agent's line to finish). The
   * same event again ends the grace that pending reply got. */
  | { type: "consult_timeout"; replyPending?: boolean }
  /** The person hung up during the consultation. */
  | { type: "target_left" }
  /** The model, the voice or the room failed. */
  | { type: "error" }
  /** The person is in the caller's room: the call is theirs. */
  | { type: "handed_off" }
  /** After `connect`, neither the person nor a result arrived in time. */
  | { type: "connect_timeout" }
  | { type: "caller_left" };

export type WarmState =
  | { phase: "requesting" }
  | { phase: "dialing" }
  /** `unclear`: how many replies so far were unclear. `overtime`: the consultation time ran out
   * while a reply was being read; that reading is the last. */
  | { phase: "consulting"; unclear: number; overtime?: true }
  | { phase: "connecting" }
  | { phase: "handed_off" }
  | {
      phase: "ended";
      outcome: Exclude<WarmOutcome, "answered">;
      reason: ConsultEndReason | "refused" | "no_reply" | "connect_failed";
    };

export type WarmEffect =
  /** Ask the person once more whether they can take the call. */
  | { type: "ask_again" }
  /** The consultation time ran out while a reply was being read: give it the grace. */
  | { type: "grace" }
  /**
   * The consultation is over. `send`: tell the host with `call.transfer.decide`; false when the
   * host itself reported the end (a dial result). `farewell`: the person heard the question and
   * answered it, so the agent may say a closing line to them before the decision is sent.
   */
  | {
      type: "end_consult";
      decision: WarmHostDecision;
      reason: ConsultEndReason;
      send: boolean;
      farewell: boolean;
    };

export type WarmStep = { state: WarmState; effects: WarmEffect[] };

export const WARM_INITIAL_STATE: WarmState = { phase: "requesting" };

/** Whether the transfer has come to an outcome. */
export function warmSettled(state: WarmState): state is Extract<WarmState, { phase: "ended" | "handed_off" }> {
  return state.phase === "ended" || state.phase === "handed_off";
}

/** The outcome of a settled transfer. */
export function warmOutcome(state: Extract<WarmState, { phase: "ended" | "handed_off" }>): WarmOutcome {
  return state.phase === "handed_off" ? "answered" : state.outcome;
}

const stay = (state: WarmState): WarmStep => ({ state, effects: [] });

/** End the consultation: the transfer ends with `outcome`, the host hears `decision`. */
function end(
  outcome: Exclude<WarmOutcome, "answered">,
  decision: WarmHostDecision,
  reason: ConsultEndReason,
  options: { send?: boolean; farewell?: boolean } = {},
): WarmStep {
  return {
    state: { phase: "ended", outcome, reason },
    effects: [
      {
        type: "end_consult",
        decision,
        reason,
        send: options.send ?? true,
        farewell: options.farewell ?? false,
      },
    ],
  };
}

/** The host ended the person's leg itself: nothing to decide, only to record. */
function dialEnded(outcome: Exclude<WarmDialResult, "answered" | "declined">): WarmStep {
  switch (outcome) {
    case "no_answer":
      return end("no_answer", "no_answer", "dial_no_answer", { send: false });
    case "busy":
      return end("busy", "no_answer", "dial_busy", { send: false });
    case "failed":
      return end("failed", "failed", "dial_failed", { send: false });
  }
}

/** The next state after `event`, and what to do. Events a state does not expect leave it as it is. */
export function step(state: WarmState, event: WarmEvent): WarmStep {
  switch (state.phase) {
    case "requesting":
      switch (event.type) {
        case "accepted":
          return stay({ phase: "dialing" });
        case "refused":
          return stay({
            phase: "ended",
            outcome: "refused",
            reason: "refused",
          });
        case "no_reply":
          return stay({
            phase: "ended",
            outcome: "failed",
            reason: "no_reply",
          });
        case "caller_left":
          // Nothing was dialed yet, so there is nothing to end on the host.
          return stay({
            phase: "ended",
            outcome: "failed",
            reason: "caller_left",
          });
        default:
          return stay(state);
      }

    case "dialing":
      switch (event.type) {
        case "target_joined":
          return stay({ phase: "consulting", unclear: 0 });
        case "dial_result":
          if (event.outcome === "answered") return stay({ phase: "handed_off" });
          if (event.outcome === "declined") return end("declined", "decline", "declined", { send: false });
          return dialEnded(event.outcome);
        case "dial_timeout":
          return end("no_answer", "no_answer", "dial_no_answer");
        case "join_failed":
          return end("failed", "failed", "join_failed");
        case "error":
          return end("failed", "failed", "error");
        case "caller_left":
          return end("failed", "failed", "caller_left");
        default:
          return stay(state);
      }

    case "consulting":
      switch (event.type) {
        case "decision":
          switch (event.decision) {
            case "yes":
              return {
                state: { phase: "connecting" },
                effects: [
                  {
                    type: "end_consult",
                    decision: "connect",
                    reason: "confirmed",
                    send: true,
                    farewell: true,
                  },
                ],
              };
            case "no":
              return end("declined", "decline", "declined", { farewell: true });
            case "voicemail":
              return end("no_answer", "no_answer", "voicemail");
            case "unclear":
              if (state.overtime) return end("no_answer", "no_answer", "consult_timeout");
              if (state.unclear === 0)
                return {
                  state: { phase: "consulting", unclear: 1 },
                  effects: [{ type: "ask_again" }],
                };
              return end("declined", "decline", "unclear_twice", {
                farewell: true,
              });
          }
          return stay(state);
        case "consult_timeout":
          if (event.replyPending && !state.overtime)
            return { state: { ...state, overtime: true }, effects: [{ type: "grace" }] };
          return end("no_answer", "no_answer", "consult_timeout");
        case "target_left":
          return end("declined", "decline", "target_left");
        case "error":
        case "join_failed":
          return end("failed", "failed", "error");
        case "caller_left":
          return end("failed", "failed", "caller_left");
        case "dial_result":
          if (event.outcome === "answered") return stay({ phase: "handed_off" });
          if (event.outcome === "declined") return end("declined", "decline", "declined", { send: false });
          return dialEnded(event.outcome);
        default:
          return stay(state);
      }

    case "connecting":
      switch (event.type) {
        case "handed_off":
          return stay({ phase: "handed_off" });
        case "dial_result":
          if (event.outcome === "answered") return stay({ phase: "handed_off" });
          return stay({
            phase: "ended",
            outcome: "failed",
            reason: "connect_failed",
          });
        case "connect_timeout":
          return stay({
            phase: "ended",
            outcome: "failed",
            reason: "connect_failed",
          });
        case "caller_left":
          // The host was told to connect already; the end of the caller's session ends the leg.
          return stay({
            phase: "ended",
            outcome: "failed",
            reason: "caller_left",
          });
        default:
          // The person leaving the consultation room is the host moving them to the caller.
          return stay(state);
      }

    case "handed_off":
    case "ended":
      return stay(state);
  }
}

/** Which attempt a decision in `state` is: 1 for the first reply, 2 after an unclear one. */
export function decisionAttempt(state: WarmState): 1 | 2 {
  return state.phase === "consulting" && state.unclear > 0 ? 2 : 1;
}
