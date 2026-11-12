import { endCallGoodbye, unexpectedToolFailureMessage, type AgentSiteRuntime } from "./runtime.js";
import { traceToolRun, type SkillChange, type SpanAttributes } from "./tool-span.js";
import {
  isToolInputStart,
  type AgentChatMessage,
  type AgentMessageAudio,
  type AgentRunRequest,
  type AgentRunResponse,
  type AgentStreamPart,
  type AgentToolCallRecord,
  type AgentTurnError,
  type AgentTurnStreamEvent,
  type LlmCallRecord,
} from "./llm/types.js";
import {
  CALL_STAYS_OPEN,
  checkAnswer,
  confirmationRequest,
  confirmedCall,
  cutReadBackNote,
  declinedNote,
  heldCallOf,
  heldMark,
  holdCall,
  newestReplyAsks,
  oneQuestionAtATime,
  pendingLine,
  unclearNote,
  withConfirmNote,
  type HeldCall,
  type PendingConfirmation,
} from "./llm/confirmation.js";
import {
  agentLanguage,
  dateLine,
  DEFAULT_TIME_ZONE,
  fallbackReplies,
  isTimeZone,
  type AgentLanguage,
} from "./llm/localized.js";
import { toolMessage } from "./llm/tool-messages.js";
import { capTranscript, contextEvent, interruptedReply, withAudio, withToolCallRecord } from "./llm/transcript.js";
import { closeAbandonedStream, llmTimeoutFromEnv, LlmTimeoutError, untilAborted } from "./llm/deadline.js";
import { serializeLlmInput } from "./llm/serialize-input.js";
import { TurnSpeech } from "./llm/turn-speech.js";
import {
  END_CALL_TOOL_NAME,
  SKIP_TURN_TOOL_NAME,
  type ToolCallOutcome,
  type ToolDefinition,
} from "./types.js";
import { END_CALL_VOICE_STYLE } from "./voice-style.js";
import { continuesHeardLine, joinHeardLine } from "./heard-line.js";

export { normalizeLlmPunctuation } from "./llm/punctuation.js";

/**
 * Pluggable LLM transport. The preview injects a `fetch("/api/agent")` client;
 * tests inject a mock. The session itself never touches the network or React.
 * `request.signal` aborts when the turn is cancelled or times out.
 */
export type AgentLlmClient = (request: AgentRunRequest) => Promise<AgentRunResponse>;

/** Optional streaming transport — one LLM step at a time, yields token deltas and the
 * start of each tool call (`{ type: "tool-input-start", toolName }`). */
export type AgentLlmStreamStep = (
  request: AgentRunRequest,
) => AsyncGenerator<AgentStreamPart, AgentRunResponse>;

/** The interaction surface a turn arrives on. Selects the system prompt. */
export type AgentSessionOptions = {
  maxSteps?: number;
  /** Cap on transcript messages sent to the LLM per step (the full transcript
   * is kept for the UI). Oldest messages fall off first. Default: 60. */
  maxTranscriptMessages?: number;
  streamLlm?: AgentLlmStreamStep;
  /** Appended after the compiled system prompt on SPOKEN turns only (turns run
   * with `{ spoken: true }`). The host sets this to the framework's
   * spoken-reply rules — the authored `<SystemPrompt>` stays exactly what the
   * author wrote, and typed turns never see the speech rules. */
  spokenStyleSuffix?: string;
  /** Deadline for one LLM request, in ms. A request still open after it is
   * aborted and the turn ends with a `timeout` error and the fixed apology.
   * Default: env `AGENT_LLM_TIMEOUT_MS`, else 60000. */
  llmTimeoutMs?: number;
  /** How many inputs may wait behind a running turn. One more is refused with
   * a `busy` error event instead of being dropped silently. Default: 8. */
  maxQueuedTurns?: number;
  /** IANA time zone of the date line every LLM request carries
   * (`defineAgent({ timeZone })`). Default: "UTC". */
  timeZone?: string;
  /** The line each conversation opens with, said without the model (`firstTurn: { say }`). */
  opening?: (info: Readonly<Record<string, unknown>>) => string;
  /** Which agent and conversation this session is, read when a span starts (`tool-span.ts`):
   * the conversation's id exists only once its first message is recorded. */
  traceAttributes?: () => SpanAttributes;
};

/** Per-turn options — one session serves typed and spoken turns alike. */
export type AgentTurnOptions = {
  /** The reply will be spoken aloud: apply the session's spokenStyleSuffix.
   * A spoken input arriving mid-turn is a barge-in: it cancels the turn in
   * flight, then runs. */
  spoken?: boolean;
  /** The caller's words may be the newest transcript entry already ({@link AgentSession.recordHeard}). */
  heard?: boolean;
  /** A speech-to-speech model says the reply in its own words, and its line is what the transcript
   * keeps ({@link AgentSession.recordHeard}), so this turn records its tools but not its words. */
  unsaid?: boolean;
  /** Marks framework-generated user input (e.g. the silence follow-up) so
   * UIs can hide it; the LLM still sees it as a plain user message. */
  kind?: "synthetic";
  /** Cancels THIS turn: while queued it never starts, while running its LLM
   * request is aborted and it ends without an apology. Aborting after the
   * turn ended does nothing. Returning the stream generator cancels the same
   * way; the signal is for callers that wrap the generator. */
  signal?: AbortSignal;
  /** The reply plays out on a voice host that reports how each reply ended
   * ({@link AgentSession.replyPlayed}, {@link AgentSession.reconcileInterruptedReply}). A
   * read-back this turn asks (`<Tool confirm>`) then counts as heard only once the host
   * reports it played to its end. Without it, it counts as heard as soon as it is said
   * (typed chat, `curb say`, `curb test`). */
  readBackHeardOnPlayout?: boolean;
};

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TRANSCRIPT_MESSAGES = 60;
const DEFAULT_MAX_QUEUED_TURNS = 8;
/** Lines of a call closer than this, with no reply between them, are one thing the caller said. */
const HEARD_LINE_GAP_MS = 2000;

/** `reply`: everything the turn said aloud. */
type TurnOutcome = { reply: string; error?: AgentTurnError };

/**
 * Surface-agnostic agent turn loop. Owns the conversation transcript and the
 * running flag, drives the runtime's tools, and notifies subscribers whenever
 * either changes so a UI (chat, voice, …) can re-render.
 *
 * One turn runs at a time. Input arriving meanwhile waits its turn (FIFO,
 * bounded by `maxQueuedTurns`); spoken input cancels the running turn first.
 */
export class AgentSession {
  private readonly runtime: AgentSiteRuntime;
  private readonly llm: AgentLlmClient;
  private readonly streamLlm?: AgentLlmStreamStep;
  private readonly maxSteps: number;
  private readonly maxTranscriptMessages: number;
  private readonly spokenStyleSuffix: string | undefined;
  private readonly llmTimeoutMs: number;
  private readonly maxQueuedTurns: number;
  private readonly traceAttributes: () => SpanAttributes;
  private readonly timeZone: string;
  private readonly opening: AgentSessionOptions["opening"];
  private readonly listeners = new Set<() => void>();
  /** Live token-delta listeners — fed the turn's cumulative assistant text
   * regardless of who drives the turn (chat WS or the voice pipeline). */
  private readonly deltaListeners = new Set<(text: string) => void>();
  // Replaced (never mutated in place) on every change so subscribers reading
  // `messages` get a stable reference between notifications.
  private conversation: AgentChatMessage[] = [];
  private running = false;
  /** Cancels the turn in flight (spoken input preempts it); null while idle. */
  private activeTurn: AbortController | null = null;
  /** Inputs waiting for the running turn to finish, oldest first. Each is
   * called when the session is handed to it. */
  private readonly waiting: Array<() => void> = [];
  private llmCalls: LlmCallRecord[] = [];
  // Fallback ids for mock transports that omit provider tool-call ids.
  private toolCallCounter = 0;
  /** The newest words this session said end in a fixed line (a fallback reply) that the
   * transcript does not hold. A voice host reporting THAT speech, or its cut-off, must not
   * attach its audio to or rewrite an earlier reply the model did say. */
  private endedOnFallbackLine = false;
  /** The running turn records no words ({@link AgentTurnOptions.unsaid}). */
  private unsaid = false;
  /** The action waiting for the caller's yes (`<Tool confirm>`); null when none. */
  private pending: PendingConfirmation | null = null;
  /** How many inputs have arrived. A held action is answered only by a later one. */
  private arrivals = 0;
  /** The voice host reported how the pending read-back ended: played, or cut off. */
  private readBackReported = false;
  /** The caller spoke over a read-back before the host reported it: the host's cut report
   * for it is still to come, and it is about a reply the conversation moved past. */
  private lateCutReport = false;

  constructor(runtime: AgentSiteRuntime, llm: AgentLlmClient, options: AgentSessionOptions = {}) {
    this.runtime = runtime;
    this.llm = llm;
    this.streamLlm = options.streamLlm;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxTranscriptMessages = options.maxTranscriptMessages ?? DEFAULT_MAX_TRANSCRIPT_MESSAGES;
    this.spokenStyleSuffix = options.spokenStyleSuffix;
    this.traceAttributes = options.traceAttributes ?? (() => ({}));
    this.llmTimeoutMs = options.llmTimeoutMs ?? llmTimeoutFromEnv();
    this.maxQueuedTurns = options.maxQueuedTurns ?? DEFAULT_MAX_QUEUED_TURNS;
    this.timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    this.opening = options.opening;
    if (!isTimeZone(this.timeZone)) {
      throw new Error(
        `AgentSession timeZone ${JSON.stringify(this.timeZone)} is not an IANA time zone. Use a name such as "Europe/Berlin", or leave it out for UTC.`,
      );
    }
  }

  /** Current transcript. Treat as read-only; the session owns the array. */
  get messages(): AgentChatMessage[] {
    return this.conversation;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Serialized LLM inputs captured on every step. Treat as read-only. */
  get llmTrace(): LlmCallRecord[] {
    return this.llmCalls;
  }

  /** The action waiting for the caller's yes (`<Tool confirm>`), or null. Treat as read-only. */
  get pendingConfirmation(): PendingConfirmation | null {
    return this.pending;
  }

  /** Subscribe to `messages`/`isRunning` changes. Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to the in-flight turn's streaming assistant text (cumulative
   * per LLM step). Fires for EVERY streamed turn — typed or spoken — so UIs
   * render generation live no matter which pipeline drives the session. */
  subscribeDeltas(listener: (text: string) => void): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /**
   * Start a new conversation: clears the transcript and the LLM trace.
   * No-ops while a turn is running (the turn loop owns the transcript then).
   * Runtime state (loaded skills, tool results) is intentionally kept — it
   * reflects the app, not the conversation.
   */
  reset(): void {
    if (this.running) return;
    this.conversation = [];
    this.llmCalls = [];
    this.toolCallCounter = 0;
    this.endedOnFallbackLine = false;
    this.pending = null;
    this.lateCutReport = false;
    this.notify();
  }

  /**
   * Replace the transcript wholesale — the rewind path builds a fresh session,
   * replays the environment, and restores the kept conversation prefix here.
   * No-ops while a turn is running (the turn loop owns the transcript then).
   * `pending` is the action the restored conversation still asks about: the one `curb say`
   * saved, or the one a rewound transcript ends on (`heldAtEnd`). It counts as heard, and the
   * caller's next input answers it; without one, nothing is held.
   */
  restoreTranscript(messages: AgentChatMessage[], pending: HeldCall | null = null): void {
    if (this.running) return;
    this.pending = pending ? { ...pending, heldAt: this.arrivals, heardAt: this.arrivals } : null;
    this.lateCutReport = false;
    this.setMessages([...messages]);
  }

  /** Open the conversation, once, with the agent's fixed line (no model call), after a synthetic note: a transcript starts
   * on the caller's side, and a failing `opening` then throws only once. Every turn opens first. Null if none or begun. */
  open(): string | null {
    if (!this.opening || this.conversation.some((m) => m.role !== "user" || m.kind !== "context_event")) return null;
    this.setMessages([...this.conversation, { role: "user", kind: "synthetic", content: "(The conversation has just started.)", at: Date.now() }]);
    const line = this.opening(this.runtime.info.snapshot());
    this.setMessages([...this.conversation, { role: "assistant", content: line, at: Date.now() }]);
    return line;
  }

  /**
   * Record a state change the model did not cause (e.g. the user opened a skill or
   * called a tool from the preview UI) as a `context_event` user message, so
   * the model learns of it chronologically. No-ops while a turn is running:
   * mid-turn state changes are already visible in the next step's snapshot,
   * and appending here would race the turn loop's local message list.
   */
  /** A line of a call no turn ran for: the speech-to-speech model heard or said it on its own. */
  recordHeard(role: "user" | "assistant", text: string): void {
    const content = text.trim();
    if (!content || this.running) return;
    const at = Date.now();
    const joined = role === "user" ? this.joinedHeardLine(content, at) : null;
    if (joined) {
      this.setMessages(joined);
      return;
    }
    this.setMessages([...this.conversation, { role, content, at }]);
  }

  /** The transcript with `content` added to the caller's newest line, when a pause only cut one
   * sentence in two, or null. A model can send a part twice, or the whole line again as it grows,
   * after any pause (`heard-line.ts`). An answer to a held action stays whole. */
  private joinedHeardLine(content: string, at: number): AgentChatMessage[] | null {
    const newest = this.conversation.at(-1);
    if (newest?.role !== "user" || newest.kind || this.pending) return null;
    if (at - (newest.at ?? 0) >= HEARD_LINE_GAP_MS && !continuesHeardLine(newest.content, content)) return null;
    return [...this.conversation.slice(0, -1), { ...newest, content: joinHeardLine(newest.content, content), at }];
  }

  recordContextEvent(lines: string[]): void {
    const content = lines.join("\n").trim();
    if (!content || this.running) return;
    this.setMessages([...this.conversation, contextEvent(content)]);
  }

  /**
   * Push external session info (caller number, CRM data, …) into the runtime.
   * When the change is visible in the compiled context, the LLM additionally
   * gets a context event so it learns about it mid-conversation instead of
   * only on the next snapshot.
   */
  updateInfo(values: Record<string, unknown>): void {
    const contextDiff = this.runtime.updateInfo(values);
    if (contextDiff.length > 0) {
      this.recordContextEvent(contextDiff);
    }
  }

  /**
   * Run one full agent turn and return what it said (its steps' words joined
   * with a space). Same loop as {@link runTurnStream}, on the non-streaming
   * transport. Returns "" for empty input, a turn that only emitted tool calls,
   * or a cancelled one. A failed, timed-out or stuck turn returns its fixed
   * fallback line in the agent's language; a failure's cause is logged
   * (console.error) and recorded on the step's {@link llmTrace} entry. Throws
   * when the input queue is full.
   *
   * `observe` sees each event of the turn as it happens: the tools it ran and why it failed,
   * the same events {@link runTurnStream} yields, without its deltas.
   */
  async runTurn(
    userText: string,
    options: AgentTurnOptions = {},
    observe?: (event: AgentTurnStreamEvent) => void,
  ): Promise<string> {
    let reply = "";
    for await (const event of this.turn(userText, options, false)) {
      observe?.(event);
      if (event.type === "error" && event.error.kind === "busy") throw new Error(event.error.message);
      if (event.type === "done") reply = event.reply;
    }
    return reply;
  }

  /**
   * Voice path: stream LLM token deltas so TTS can start speaking early.
   *
   * A step that ends in a tool call says nothing, `end_call` included: its
   * goodbye is said once it ran. The provider shows the tool call only after
   * the text, so each step's newest sentence is held back: it is released once
   * the next sentence starts or the step ends without a tool call, and dropped
   * when a tool call starts. TTS still gets a step's first sentence while the
   * LLM writes its second. The transcript records exactly what was released,
   * and steps are joined with a space. See {@link TurnSpeech}.
   *
   * Uses the non-streaming transport when no streamLlm is configured. Every
   * non-empty input ends with a `done` event, preceded by `error` when the
   * input was refused or the turn did not end in a reply (failure, timeout,
   * step limit, an empty reply twice); such a turn also streams a fixed line
   * in the agent's language as a delta, so a voice caller hears it. The
   * transcript does not record that line: the model never said it.
   *
   * Returning the generator (or aborting `options.signal`) cancels this turn
   * and only this one: a queued turn never starts, a running one is aborted,
   * a finished one is unaffected.
   */
  runTurnStream(userText: string, options: AgentTurnOptions = {}): AsyncGenerator<AgentTurnStreamEvent> {
    const cancel = new AbortController();
    const stream = this.turn(userText, options, true, cancel);
    // A generator paused on an await (queued, or waiting on the provider)
    // only sees return() at its next yield; aborting first stops it now.
    const close = stream.return.bind(stream);
    stream.return = (value) => {
      cancel.abort();
      return close(value);
    };
    return stream;
  }

  private async *turn(
    userText: string,
    options: AgentTurnOptions,
    streaming: boolean,
    cancel = new AbortController(),
  ): AsyncGenerator<AgentTurnStreamEvent> {
    const trimmed = userText.trim();
    if (!trimmed) return;
    // Counted on arrival, before any wait: input that was already waiting when an action
    // was held was said before the caller heard its read-back, so it does not answer it.
    const arrival = ++this.arrivals;

    const { signal } = options;
    const onCancel = () => cancel.abort();
    if (signal?.aborted) cancel.abort();
    else signal?.addEventListener("abort", onCancel, { once: true });
    try {
      if (cancel.signal.aborted) {
        yield { type: "done", reply: "" };
        return;
      }
      if (options.spoken && options.kind !== "synthetic") this.activeTurn?.abort();
      const admission = await this.waitForTurn(cancel.signal);
      if (admission === "busy") {
        yield {
          type: "error",
          error: {
            kind: "busy",
            message: `${this.maxQueuedTurns} inputs are already waiting for the running turn; this one was not run: ${JSON.stringify(trimmed.slice(0, 80))}`,
          },
        };
        yield { type: "done", reply: "" };
        return;
      }
      if (admission === "cancelled") {
        yield { type: "done", reply: "" };
        return;
      }

      let outcome: TurnOutcome;
      this.activeTurn = cancel;
      try {
        outcome = yield* this.runLoop(trimmed, options, streaming, cancel, arrival);
      } finally {
        this.activeTurn = null;
        this.finishTurn();
      }
      if (outcome.error) yield { type: "error", error: outcome.error };
      yield { type: "done", reply: outcome.reply };
    } finally {
      signal?.removeEventListener("abort", onCancel);
    }
  }

  /** Resolves "run" once this input owns the session, "busy" when the queue is
   * full, "cancelled" when `cancelled` aborts first (it leaves the queue). */
  private async waitForTurn(cancelled: AbortSignal): Promise<"run" | "busy" | "cancelled"> {
    if (!this.running) {
      this.running = true;
      return "run";
    }
    if (this.waiting.length >= this.maxQueuedTurns) return "busy";
    const admitted = await new Promise<boolean>((resolve) => {
      const admit = () => {
        cancelled.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const at = this.waiting.indexOf(admit);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(false);
      };
      this.waiting.push(admit);
      cancelled.addEventListener("abort", leave, { once: true });
    });
    if (!admitted) return "cancelled";
    // Cancelled between the hand-over and this continuation: pass it on.
    if (cancelled.aborted) {
      this.finishTurn();
      return "cancelled";
    }
    return "run";
  }

  /** Hand the session to the next waiting input, or go idle. */
  private finishTurn(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running = false;
    this.notify();
  }

  /**
   * The turn loop: appends the user message, then up to `maxSteps` times asks
   * the LLM and runs the tools it requests. An empty step (no text, no tool
   * call) is asked again once. Every exit leaves a consistent transcript: a
   * tool call always has its result, words that were already said stay, and a
   * turn that cannot answer ends in a fixed line the transcript does not hold.
   *
   * While an action waits for the caller's yes, the caller's input (`arrival`, counted
   * on arrival) is first checked as the answer to it (see {@link answerPending}), or drops
   * it when it came before the caller heard the read-back to its end. A step that holds an
   * action ends the turn with its read-back, and a step whose end_call ran with its goodbye.
   */
  private async *runLoop(
    text: string,
    options: AgentTurnOptions,
    streaming: boolean,
    controller: AbortController,
    arrival: number,
  ): AsyncGenerator<AgentTurnStreamEvent, TurnOutcome> {
    try {
      this.open();
    } catch (error) {
      // A `say` function with no line: the caller still gets an answer, as on a voice call.
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", error: { kind: "failed", message } };
    }
    this.unsaid = options.unsaid === true;
    const newest = this.conversation.at(-1);
    const heardAlready = options.heard && newest?.role === "user" && newest.content.endsWith(text);
    let messages: AgentChatMessage[] = heardAlready
      ? this.conversation
      : ((options.heard ? this.joinedHeardLine(text, Date.now()) : null) ?? [
          ...this.conversation,
          { role: "user", content: text, at: Date.now(), ...(options.kind ? { kind: options.kind } : {}) },
        ]);
    this.setMessages(messages);

    const speech = new TurnSpeech();
    // The current step said words that no transcript entry holds yet.
    let unrecorded = false;
    // The current step's llmTrace entry, where a failure of the step is recorded.
    let stepCall: number | null = null;
    let settled = false;
    let failure: { error: unknown } | null = null;
    // Why a turn that ran to its end has no reply.
    let unanswered: AgentTurnError | undefined;
    try {
      // Framework input (the silence follow-up) is not the caller's: it neither answers nor drops.
      const pending = this.pending;
      if (pending && options.kind !== "synthetic" && arrival > pending.heldAt) {
        if (pending.heardAt !== undefined && arrival > pending.heardAt) {
          messages = yield* this.answerPending(text, messages, controller.signal);
        } else {
          // Said before the read-back played to its end: it was not asked, so nothing answers it.
          this.pending = null;
          this.lateCutReport = !this.readBackReported;
          messages = this.append(messages, contextEvent(cutReadBackNote(pending)));
        }
      }
      let steps = 0;
      let retriedEmpty = false;
      while (true) {
        controller.signal.throwIfAborted();
        if (steps >= this.maxSteps) {
          unanswered = {
            kind: "step_limit",
            message: `The turn used all ${this.maxSteps} LLM steps (maxSteps) with tool calls still pending. Raise defineAgent({ maxSteps }) if this task needs more.`,
          };
          break;
        }
        stepCall = null;
        const request: AgentRunRequest = {
          ...this.buildRequest(messages, options.spoken === true),
          signal: controller.signal,
        };
        stepCall = this.recordLlmInput(request);
        speech.startStep();
        unrecorded = true;
        const timer = setTimeout(
          () => controller.abort(new LlmTimeoutError(this.llmTimeoutMs)),
          this.llmTimeoutMs,
        );
        let response: AgentRunResponse;
        try {
          response =
            streaming && this.streamLlm
              ? yield* this.streamStep(this.streamLlm(request), speech, controller.signal)
              : await untilAborted(this.llm(request), controller.signal);
        } finally {
          clearTimeout(timer);
        }

        if (!response.text.trim() && response.toolCalls.length === 0 && !speech.stepText) {
          // The model ended the turn saying nothing, which is never an answer: ask again once.
          unrecorded = false;
          if (!retriedEmpty) {
            retriedEmpty = true;
            continue;
          }
          unanswered = {
            kind: "empty_reply",
            message: "The model answered with no text and no tool call, twice in a row.",
          };
          this.recordLlmError(stepCall, unanswered.message);
          break;
        }
        // A step that calls a tool says nothing of its own (see TurnSpeech).
        const speaks = response.toolCalls.length === 0;
        if (streaming && this.streamLlm) {
          const rest = speech.endStep(speaks);
          if (rest) yield this.spokenDelta(rest, speech);
        } else {
          speech.wholeStep(response.text, speaks);
        }
        unrecorded = false;

        if (speaks && !speech.stepText) {
          // The model wrote only a stage direction ("[assistant turned their head away]"), which
          // TurnSpeech never says. That is no answer: ask again once, as for an empty reply. A
          // second one ends the turn silent, as the skip_turn the model meant: an apology for a
          // failed turn would answer side talk.
          console.warn(`[curb] the model wrote only a stage direction, which is not said: ${JSON.stringify(response.text.trim())}`);
          if (!retriedEmpty) {
            retriedEmpty = true;
            continue;
          }
          break;
        }
        steps += 1;

        const asksCaller = response.toolCalls.some((call) => !call.error && this.runtime.confirms(call.name));
        const outcome = await this.applyLlmResponse(response, speech.stepText, messages, asksCaller);
        messages = outcome.messages;
        for (const executed of outcome.toolCalls) {
          const { skill, ...tool } = executed;
          yield { type: "tool", ...tool };
          if (skill) yield { type: "skill", ...skill };
        }
        const closing = outcome.held?.readBack ?? outcome.goodbye;
        if (closing !== undefined) {
          // The turn ends with the held action's question, or the goodbye of the end_call that
          // ran, word for word, as its own step. Said only now: a cancelled turn says neither, and
          // input that arrived before the question is said never answers it. On a voice host the
          // question is heard once it played to its end, and the call hangs up once the goodbye did.
          controller.signal.throwIfAborted();
          if (outcome.held) {
            const heardAt = options.readBackHeardOnPlayout ? {} : { heardAt: this.arrivals };
            this.pending = { ...outcome.held, heldAt: this.arrivals, ...heardAt };
            this.readBackReported = false;
          }
          const delta = speech.line(closing);
          messages = this.keepSpokenText(messages, speech.stepText);
          if (streaming && delta) yield this.spokenDelta(delta, speech);
        }
        if (outcome.done) break;
      }
      settled = true;
    } catch (error) {
      // An abort without a timeout is a cancellation, not a failure.
      if (!controller.signal.aborted) failure = { error };
      else if (controller.signal.reason instanceof LlmTimeoutError) failure = { error: controller.signal.reason };
    } finally {
      if (!settled) {
        // Cancelled, failed, or the consumer stopped reading: stop the provider,
        // and keep what was already said in the transcript, where an
        // interrupted-reply reconcile can find it.
        controller.abort();
        if (unrecorded) messages = this.keepSpokenText(messages, speech.stepText);
      }
      // Whatever this turn said so far is in the transcript.
      if (speech.reply) this.endedOnFallbackLine = false;
    }

    if (failure) {
      const kind = failure.error instanceof LlmTimeoutError ? "timeout" : "failed";
      const detail = describeError(failure.error);
      // KEEP-JUSTIFIED: the caller only gets the fixed apology; the cause goes to
      // the developer log, the error event and the step's trace entry.
      console.error(`[curb] turn ${kind}:`, failure.error);
      if (stepCall !== null) this.recordLlmError(stepCall, detail);
      unanswered = { kind, message: detail };
    }
    if (!unanswered) return { reply: speech.reply };

    // The caller hears a fixed line in the agent's language, right after whatever
    // the turn already said. The transcript does not record it: the model never
    // said it, and the next request must not show it as the model's words.
    const fallback = fallbackReplies(this.language());
    const line = unanswered.kind === "step_limit" ? fallback.stepLimit : fallback.turnFailed;
    const delta = speech.line(line);
    this.endedOnFallbackLine = true;
    if (streaming && delta) yield { type: "delta", delta, text: line };
    return { reply: speech.reply, error: unanswered };
  }

  /** One streamed LLM step: what the step may say is released as it arrives (see
   * {@link TurnSpeech}) and yielded as deltas. Returns the provider's final response. */
  private async *streamStep(
    stream: AsyncGenerator<AgentStreamPart, AgentRunResponse>,
    speech: TurnSpeech,
    signal: AbortSignal,
  ): AsyncGenerator<AgentTurnStreamEvent, AgentRunResponse> {
    let drained = false;
    try {
      while (true) {
        // Aborted while the consumer held a delta: close the stream where it
        // paused instead of asking it for more.
        signal.throwIfAborted();
        const next = await untilAborted(stream.next(), signal);
        if (next.done) {
          drained = true;
          return next.value;
        }
        const part = next.value;
        if (isToolInputStart(part)) {
          speech.toolInputStart();
          continue;
        }
        const said = speech.text(part.delta);
        if (said) yield this.spokenDelta(said, speech);
      }
    } finally {
      if (!drained) closeAbandonedStream(stream);
    }
  }

  /** The delta event for words the turn says, also fed to the live delta listeners. */
  private spokenDelta(delta: string, speech: TurnSpeech): AgentTurnStreamEvent {
    const text = speech.stepText;
    for (const listener of this.deltaListeners) listener(text);
    return { type: "delta", delta, text };
  }

  /** Record the words a step said (before it was cut off, or a read-back). */
  private keepSpokenText(messages: AgentChatMessage[], said: string): AgentChatMessage[] {
    if (!said || this.unsaid) return messages;
    return this.append(messages, { role: "assistant", content: said, at: Date.now() });
  }

  /** `messages` with `message` appended, published as the transcript. */
  private append(messages: AgentChatMessage[], message: AgentChatMessage): AgentChatMessage[] {
    const next = [...messages, message];
    this.setMessages(next);
    return next;
  }

  /** The language the agent speaks now (TTS, else STT, else English). Read per use: a
   * skill with its own voice changes it mid-call. */
  private language(): AgentLanguage {
    return agentLanguage(this.runtime.settings.view());
  }

  private buildRequest(messages: AgentChatMessage[], spoken: boolean): AgentRunRequest {
    const snapshot = this.runtime.snapshot();
    const authored = snapshot.context.systemPrompt ?? "";
    const spokenRules = spoken ? this.spokenRulesFor(snapshot.context.tools) : "";
    return {
      systemPrompt: spokenRules ? `${authored}\n\n${spokenRules}` : authored,
      skillTitle: snapshot.context.title,
      // Today's date and time lead the current context. Built here, per request, and never
      // rendered into the tree, so it causes no context events; kept out of the system
      // prompt, so the prompt's prefix does not change every minute. An action waiting for
      // the caller's yes follows, so the model never forgets it.
      stateSnapshot: [
        dateLine(new Date(), this.timeZone, this.language()),
        ...(this.pending ? [pendingLine(this.pending)] : []),
        ...snapshot.stateSnapshot,
      ],
      tools: snapshot.context.tools.map((tool) => (this.runtime.confirms(tool.name) ? withConfirmNote(tool) : tool)),
      messages: capTranscript(messages, this.maxTranscriptMessages),
    };
  }

  /** The spoken-reply rules for THIS turn: the session's suffix, plus the
   * hang-up rules when `end_call` is actually on the tool surface. The tool
   * exists only while a call is attached, and prompting for a tool the model
   * does not have is how you get a call to a tool that does not exist. */
  private spokenRulesFor(tools: readonly ToolDefinition[]): string {
    if (!this.spokenStyleSuffix) return "";
    if (!tools.some((tool) => tool.name === END_CALL_TOOL_NAME)) return this.spokenStyleSuffix;
    return `${this.spokenStyleSuffix}\n${END_CALL_VOICE_STYLE.join("\n")}`;
  }

  /**
   * Apply one LLM step: record the assistant message (the words the step said
   * aloud, `said`, and/or its native tool calls — a text-less tool step keeps
   * its tool calls with empty text so tool_use/tool_result pairing survives),
   * then execute each tool and append its result with the context diff it
   * caused. Returns the updated transcript and whether the turn loop should
   * stop — no tool calls were made, or the model called one of the framework's
   * turn-ending tools (see runtime.ts): skip_turn, which ends the turn
   * immediately with no reply, or end_call, which ends it with its `goodbye`
   * once it ran (refused, it hangs up nothing and the turn goes on). The model's
   * call of a `confirm` tool (`asksCaller`) is held for the caller's yes instead
   * of run, and the turn ends with its read-back; see {@link refusal} for what
   * such a step refuses.
   */
  private async applyLlmResponse(
    response: AgentRunResponse,
    said: string,
    messages: AgentChatMessage[],
    asksCaller: boolean,
  ): Promise<{
    messages: AgentChatMessage[];
    done: boolean;
    /** Tool calls executed this step, with their success — streaming callers
     * yield these; runTurn ignores them. */
    toolCalls: Array<{ toolCall: AgentToolCallRecord; ok: boolean; durationMs?: number; skill?: SkillChange }>;
    /** The action this step held: the turn ends asking the caller about it. */
    held?: HeldCall;
    /** The goodbye of the end_call this step ran: the turn ends saying it. */
    goodbye?: string;
  }> {
    const planned = response.toolCalls.map((toolCall) => {
      const skillPath = this.runtime.toolDefinition(toolCall.name)?.skillPath;
      const record: AgentToolCallRecord = {
        id: toolCall.id ?? this.nextToolCallId(),
        name: toolCall.name,
        input: toolCall.input,
        ...(skillPath ? { skillPath } : {}),
        ...(toolCall.error ? { invalid: toolCall.error } : {}),
      };
      // The model's call of a `confirm` tool never runs here, and its first stored copy says so.
      const asks = !record.invalid && this.runtime.confirms(record.name);
      return { record, published: asks ? { ...record, invalid: heldMark() } : record };
    });
    const toolCalls = planned.map((call) => call.published);
    // skip_turn ends the turn here, whatever else the model queued, and so does an end_call
    // that runs below.
    const staysSilent = planned.some(({ record }) => record.name === SKIP_TURN_TOOL_NAME && !record.invalid);

    let next = messages;
    const assistantAt = next.length;
    if ((said && !this.unsaid) || toolCalls.length > 0) {
      next = [
        ...next,
        {
          role: "assistant",
          content: this.unsaid ? "" : said,
          at: Date.now(),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
      ];
      this.setMessages(next);
    }

    if (toolCalls.length === 0) return { messages: next, done: true, toolCalls: [] };

    const executed: Array<{ toolCall: AgentToolCallRecord; ok: boolean; durationMs?: number; skill?: SkillChange }> = [];
    let held: HeldCall | undefined;
    let goodbye: string | undefined;
    for (const { record, published } of planned) {
      let toolCall = record;
      // An earlier call of this step may have changed the tool surface, so a
      // tool is known or unknown, and asks the caller or not, only now. The
      // record says how the call ended (refused, held, run); rewind reads it.
      const refusal = toolCall.invalid ? undefined : this.refusal(toolCall.name, asksCaller, held);
      if (refusal) toolCall = { ...toolCall, invalid: refusal };
      let outcome: ToolCallOutcome;
      let durationMs: number | undefined;
      let skill: SkillChange | undefined;
      if (!toolCall.invalid && this.runtime.confirms(toolCall.name)) {
        // The model's call of a `confirm` tool never runs it; runLoop asks the caller.
        const hold = await holdCall(this.runtime, toolCall, this.pending);
        toolCall = hold.toolCall;
        outcome = hold.outcome;
        held ??= hold.held;
      } else {
        ({ outcome, durationMs, skill } = await this.executeToolCall(toolCall));
      }
      if (toolCall !== published) next = withToolCallRecord(next, assistantAt, toolCall);
      const ok = outcome.result.ok !== false;
      // Refused (invalid input, or CALL_STAYS_OPEN), an end_call hung up nothing and says nothing.
      if (ok && toolCall.name === END_CALL_TOOL_NAME) goodbye ??= endCallGoodbye(toolCall.input);
      executed.push({ toolCall, ok, ...(durationMs === undefined ? {} : { durationMs }), ...(skill ? { skill } : {}) });
      next = this.append(next, toolMessage(toolCall, outcome));
    }

    // Ends the turn loop immediately even if the model queued other tool
    // calls alongside skip_turn/end_call — every queued call still ran above
    // (so tool_use/tool_result pairing holds), the turn just does not continue
    // into another step.
    return {
      messages: next,
      done: staysSilent || goodbye !== undefined || held !== undefined,
      toolCalls: executed,
      ...(held ? { held } : {}),
      ...(goodbye ? { goodbye } : {}),
    };
  }

  /** Why a call of `name` must not run now, or undefined. `asksCaller`: the step calls a
   * `confirm` tool, so the call stays open. `held`: the step already holds an action. */
  private refusal(name: string, asksCaller: boolean, held: HeldCall | undefined): string | undefined {
    if (!this.runtime.toolDefinition(name)) return `Unknown tool "${name}". Call only the tools you currently have.`;
    if (asksCaller && name === END_CALL_TOOL_NAME) return CALL_STAYS_OPEN;
    if (held && this.runtime.confirms(name)) return oneQuestionAtATime(held);
    return undefined;
  }

  /**
   * The caller's input while an action waits for their yes: one small check on the agent's
   * own LLM (`llm/confirmation.ts`) decides how `words` answer the read-back, before the
   * model speaks. A yes runs the action, recorded as a call of its own that the words
   * confirmed, and the model speaks from its result. A no drops it; anything else keeps
   * it. The model reads which as a context event.
   */
  private async *answerPending(
    words: string,
    messages: AgentChatMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<AgentTurnStreamEvent, AgentChatMessage[]> {
    const pending = this.pending!;
    const request = confirmationRequest(pending.readBack, words);
    const call = this.recordLlmInput(request);
    const { verdict, failed } = await checkAnswer(this.llm, request, signal, this.llmTimeoutMs);
    if (failed) {
      // KEEP-JUSTIFIED: an unanswered check neither runs the action nor fails the turn: it
      // counts as unclear (the model asks again); the cause goes to the log and the trace.
      console.error("[curb] the confirmation check failed; the answer counts as unclear:", failed.error);
      this.recordLlmError(call, describeError(failed.error));
    }
    if (verdict !== "yes") {
      if (verdict === "no") this.pending = null;
      return this.append(
        messages,
        contextEvent(verdict === "no" ? declinedNote(pending, words) : unclearNote(pending, words)),
      );
    }
    this.pending = null;
    const toolCall = confirmedCall(this.runtime, pending, words);
    let next = this.append(messages, { role: "assistant", content: "", at: Date.now(), toolCalls: [toolCall] });
    const { outcome, durationMs, skill } = await this.executeToolCall(toolCall);
    next = this.append(next, toolMessage(toolCall, outcome));
    yield { type: "tool", toolCall, ok: outcome.result.ok !== false, ...(durationMs === undefined ? {} : { durationMs }) };
    if (skill) yield { type: "skill", ...skill };
    return next;
  }

  /** Run one recorded tool call. Always yields a result: the call is already
   * in the transcript, and a call without a result would make every later
   * request invalid (tool_use/tool_result pairing). A call the model cannot
   * make (`invalid`) gets a failed result it can correct itself from, and no
   * duration: it never ran. A call that ran is a span (`tool-span.ts`). */
  private async executeToolCall(
    toolCall: AgentToolCallRecord,
  ): Promise<{ outcome: ToolCallOutcome; durationMs?: number; skill?: SkillChange }> {
    if (toolCall.invalid) return { outcome: { result: { ok: false, message: toolCall.invalid }, contextDiff: [] } };
    return traceToolRun(toolCall, this.traceAttributes(), () => this.runTool(toolCall), () => {
      const { path, title } = this.runtime.snapshot().context;
      return { path, title };
    });
  }

  private async runTool(toolCall: AgentToolCallRecord): Promise<ToolCallOutcome> {
    try {
      return await this.runtime.callTool(toolCall.name, toolCall.input);
    } catch (error) {
      // KEEP-JUSTIFIED: handler errors are already results (runtime.callTool);
      // this is a failure around the handler (e.g. the re-render). The model
      // gets a failed result, the developer the real error.
      console.error(`[curb] tool "${toolCall.name}" failed outside its handler:`, error);
      return { result: { ok: false, message: unexpectedToolFailureMessage(toolCall.name) }, contextDiff: [] };
    }
  }

  private nextToolCallId(): string {
    this.toolCallCounter += 1;
    return `call_${this.toolCallCounter}`;
  }

  private setMessages(next: AgentChatMessage[]) {
    this.conversation = next;
    this.notify();
  }

  /** Attach real call-audio references to the newest matching message that
   * doesn't have any yet (the voice host maps its clip store onto the
   * transcript so the UI can replay exactly what was heard/said). Skips
   * framework-generated user messages and text-less assistant tool steps. */
  annotateAudio(role: "user" | "assistant", audio: AgentMessageAudio): void {
    // That reply ended in a fallback line no message holds; its audio belongs to none.
    if (role === "assistant" && this.endedOnFallbackLine) return;
    const next = withAudio(this.conversation, role, audio);
    if (next) this.setMessages(next);
  }

  /** Voice hosts call this when a reply played to its end, uninterrupted. On a turn run with
   * `readBackHeardOnPlayout`, the read-back of the action waiting for the caller's yes counts
   * as heard only now, so the caller's next words answer it. Any other reply changes nothing. */
  replyPlayed(): void {
    // A reply that played to its end is never the cut one still to come.
    this.lateCutReport = false;
    const pending = this.pending;
    if (!pending || pending.heardAt !== undefined || this.endedOnFallbackLine) return;
    if (!newestReplyAsks(this.conversation, pending)) return;
    this.readBackReported = true;
    this.pending = { ...pending, heardAt: this.arrivals };
  }

  /** Reconcile the last assistant reply with what was actually SPOKEN. Voice
   * hosts call this when playback was cut off: the generated text went into
   * history in full, but the user only heard a prefix — replace the entry so
   * the model's memory matches the user's ears (LiveKit reports the spoken
   * prefix from playback-synchronized transcripts). It never decides a held
   * action: a read-back that did not play to its end is not heard, and the
   * caller's next words drop it. A report that lands after their next input
   * (a turn is running, or it is the cut read-back they spoke over) is about a
   * reply the conversation moved past, and changes nothing. */
  reconcileInterruptedReply(spokenText: string): void {
    if (this.lateCutReport) {
      this.lateCutReport = false;
      return;
    }
    // The cut-off speech ended in a fallback line the transcript does not hold: the last
    // assistant message is an earlier reply, which played in full.
    if (this.running || this.endedOnFallbackLine) return;
    for (let i = this.conversation.length - 1; i >= 0; i -= 1) {
      const message = this.conversation[i];
      if (message?.role !== "assistant") continue;
      if (this.pending && heldCallOf(this.conversation, i)?.id === this.pending.toolCallId) {
        this.readBackReported = true;
      }
      const cut = interruptedReply(message, spokenText);
      if (cut) this.setMessages(this.conversation.map((entry, at) => (at === i ? cut : entry)));
      return;
    }
  }

  /** Returns the record's index, for {@link recordLlmError}. */
  private recordLlmInput(request: AgentRunRequest): number {
    const index = this.llmCalls.length;
    this.llmCalls = [
      ...this.llmCalls,
      {
        index,
        at: new Date().toISOString(),
        input: serializeLlmInput(request),
      },
    ];
    this.notify();
    return index;
  }

  private recordLlmError(index: number, error: string) {
    const call = this.llmCalls[index];
    // A reset() during the turn cleared the trace; nothing left to annotate.
    if (!call) return;
    this.llmCalls = this.llmCalls.map((entry) => (entry === call ? { ...entry, error } : entry));
    this.notify();
  }

  private notify() {
    // Listeners must not throw — a throwing listener propagates loudly rather
    // than silently leaving other subscribers un-notified.
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
