/**
 * Curb behind a speech-to-speech model: the back office of OpenAI Live's client delegation.
 *
 * The model hears the caller, decides when to speak and speaks. A turn that needs more than
 * talking it hands over, naming no tool and no arguments, only that work is wanted: a delegation
 * on OpenAI Live, a call of one tool on Realtime (`voices.ts`). Curb then runs an ordinary turn
 * on `llm`, with its skills, tools and held actions, and the model says the outcome in its own words.
 *
 * It is a typed turn on purpose: queued rather than cancelled by the next words, with no voice
 * style, since this text is read by a model and not by a listener.
 */

import type { AgentSession } from "../../../agent-session.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import type { AgentTurnStreamEvent } from "../../../llm/types.js";
import { END_CALL_TOOL_NAME } from "../../../types.js";
import { reportTurnEvent } from "../turn-report.js";

/** Curb's way into the model when it did not ask, which LiveKit's `GPTLiveSession` fits. */
export type VoiceBackChannel = {
  appendCommentary(text: string, options: { delegationId: string | null; expectsReply?: boolean }): void;
};

/** An append holds 500 tokens; this stays well under it. */
const COMMENTARY_CHARS = 1400;

/** Every delegation gets an answer, even from an empty turn. */
const NOTHING_TO_ADD = "Nothing to add. Carry on with the caller.";

/** `text` in pieces that fit one append each, cut at sentence ends where it can. */
export function commentaryPieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > COMMENTARY_CHARS) {
    const end = rest.lastIndexOf(". ", COMMENTARY_CHARS);
    const cut = end > 0 ? end + 1 : COMMENTARY_CHARS;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return rest ? [...pieces, rest] : pieces;
}

/** A held action answers to the caller's own words, which `heard` brings; the model's retelling
 * of them could release it on a yes nobody said. Its tool call and its transcript of the answer
 * arrive in either order, so a call this close to the answer is about that same answer. */
const ANSWER_WINDOW_MS = 4000;

/** A transcript lags its speech by seconds, so a start this old belongs to no line still coming. */
const SPEECH_START_STALE_MS = 30_000;

/** A model may answer a goodbye by itself, in any language, so only `llm` can tell the call is over.
 * Only the goodbye of an `end_call` that ran reaches the model from this turn (`quiet`). */
const QUIET_NOTE = "(The caller has been quiet since the last line. If they said goodbye or are clearly finished, end the call. If not, reply with the one word: waiting.)";

const endedCall = (event: AgentTurnStreamEvent) => event.type === "tool" && event.ok && event.toolCall.name === END_CALL_TOOL_NAME;

const NO_ANSWER = "The caller has not answered yet. Ask the question again and wait for their answer.";
const ALREADY_REPORTED = "The back office has reported this already. Say nothing more about it.";

const sameWords = (text: string) => text.trim().toLowerCase();

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** A line whose words are mostly a reply's is that reply's transcript, however it was split. */
const TRANSCRIPT_SHARE = 0.7;

export function createBackOffice(options: {
  session: () => AgentSession;
  voice: () => VoiceBackChannel | null;
  /** The call's record: every turn's tools and failures go there, as on a cascaded call. */
  reporter?: CallReporter;
  /** The model says each reply as written (`openai.live({ verbatim: true })`). */
  verbatim?: boolean;
}) {
  /** Turns running or done for words, so a delegation and a held answer share one. */
  const turns = new Map<string, Promise<string>>();
  /** Words a turn recorded itself, so the transcript does not take them twice. */
  const taken = new Set<string>();
  /** Lines heard while a turn ran: a running turn owns the transcript. */
  const waiting: Array<{ role: "user" | "assistant"; text: string }> = [];
  let latest: string | null = null;
  let running = 0;
  let settled = Promise.resolve();
  let lastCallerLine = "";
  /** The latest answer to a held action. A tool call that comes for it takes its outcome. */
  let answer: { outcome: Promise<string>; at: number; done: boolean; claimed: boolean } | null = null;
  let answerArrived: (() => void) | null = null;
  /** When the caller began each line whose transcript has not arrived, oldest first. */
  const speechStarts: number[] = [];
  /** When the back office learned an action is held; words begun earlier cannot answer it. */
  let heldSince: number | null = null;
  /** The words of the last reply said as written, whose transcript is not a new line. */
  let lastVerbatimWords: ReadonlySet<string> = new Set();

  const noteHeld = () => {
    if (!options.session().pendingConfirmation) heldSince = null;
    else heldSince ??= Date.now();
  };

  const flush = () => {
    const session = options.session();
    while (!session.isRunning && waiting.length > 0) {
      const line = waiting.shift()!;
      session.recordHeard(line.role, line.text);
    }
  };

  /** Only a delegation can open a reply the model says as written. */
  const saysAsWritten = (delegationId: string | null) => options.verbatim === true && delegationId !== null;

  /** `request` is the model's own wording, which no caller said; anything else is the caller's.
   * `saidAsWritten` keeps the reply as said. `observe` sees the events of a turn this call starts,
   * after the call's record did. */
  const turnFor = (
    words: string,
    { request = false, saidAsWritten = false, observe }: { request?: boolean; saidAsWritten?: boolean; observe?: (event: AgentTurnStreamEvent) => void } = {},
  ): Promise<string> => {
    const key = sameWords(words);
    const known = turns.get(key);
    if (known) return known;
    if (!request) taken.add(key);
    const turn = options
      .session()
      .runTurn(words, { unsaid: !saidAsWritten, ...(request ? { kind: "synthetic" as const } : { heard: true }) }, (event) => {
        reportTurnEvent(options.reporter, event);
        observe?.(event);
      })
      .finally(() => {
        turns.delete(key);
        noteHeld();
        flush();
      });
    turns.set(key, turn);
    return turn;
  };

  const counted = <T>(work: Promise<T>): Promise<T> => {
    running += 1;
    const counting = work.finally(() => {
      running -= 1;
    });
    settled = Promise.allSettled([settled, counting]).then(() => undefined);
    return counting;
  };

  const tell = (reply: string, delegationId: string | null) => {
    // An empty turn has nothing to say, so its note stays a note to the model.
    const verbatim = saysAsWritten(delegationId) && reply.trim() !== "";
    if (verbatim) lastVerbatimWords = new Set(wordsOf(reply));
    for (const piece of commentaryPieces(reply || NOTHING_TO_ADD)) {
      options.voice()?.appendCommentary(piece, { delegationId, ...(verbatim ? { expectsReply: true } : {}) });
    }
  };

  const isVerbatimTranscript = (line: string) => {
    const words = wordsOf(line);
    return words.length > 0 && words.filter((word) => lastVerbatimWords.has(word)).length / words.length >= TRANSCRIPT_SHARE;
  };

  const ask = (words: string, delegationId: string | null): Promise<void> =>
    counted(turnFor(words, { saidAsWritten: saysAsWritten(delegationId) }).then((reply) => tell(reply, delegationId)));

  /** The caller answered a held action: a tool call waiting for it gets the outcome, else the model is told. */
  const answerHeld = (words: string) => {
    const held = { outcome: turnFor(words, { saidAsWritten: saysAsWritten(latest) }), at: Date.now(), done: false, claimed: false };
    answer = held;
    answerArrived?.();
    void counted(
      held.outcome.then((reply) => {
        held.done = true;
        if (!held.claimed) tell(reply, latest);
      }),
    );
  };

  const answerSoon = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ANSWER_WINDOW_MS);
      answerArrived = () => {
        clearTimeout(timer);
        answerArrived = null;
        resolve();
      };
    });

  return {
    /** The model handed a turn over. Its transcript may lag: the newest line stands in for it. */
    delegated(delegationId: string, pendingTranscript: string): Promise<void> {
      latest = delegationId;
      return ask(pendingTranscript.trim() || lastCallerLine, delegationId);
    },
    /** The model called its tool: the same turn, with the outcome as the tool's result. */
    async asked(request: string): Promise<string> {
      const recent = () => answer && (!answer.done || Date.now() - answer.at < ANSWER_WINDOW_MS);
      if (!recent() && !options.session().pendingConfirmation) return counted(turnFor(request, { request: true }).then((reply) => reply || NOTHING_TO_ADD));
      if (!recent()) await answerSoon();
      if (!recent()) return NO_ANSWER;
      if (answer!.done) return ALREADY_REPORTED;
      answer!.claimed = true;
      return answer!.outcome.then((reply) => reply || NOTHING_TO_ADD);
    },
    /** Words typed into a call, which the model cannot hear. */
    typed: (text: string) => ask(text, null),
    /** The caller began to speak. A transcript can arrive long after, even after the next line
     * began, so this is the only way to know a line came after the question. */
    callerStarted(): void {
      speechStarts.push(Date.now());
    },
    /** A finished line of the call. The caller's answer to a held action always reaches Curb:
     * the model does not know one waits, and nothing else can release it. A line begun before the
     * action was held is not its answer, however late its transcript. */
    heard(role: "user" | "assistant", text: string): void {
      let startedAt: number | undefined;
      if (role === "user") {
        while (speechStarts.length > 0 && Date.now() - speechStarts[0]! > SPEECH_START_STALE_MS) speechStarts.shift();
        startedAt = speechStarts.shift();
        lastCallerLine = text;
        if (taken.delete(sameWords(text))) return;
      }
      if (role === "assistant" && isVerbatimTranscript(text)) return; // the turn kept these words itself
      waiting.push({ role, text });
      flush();
      noteHeld();
      if (role === "user" && heldSince !== null && startedAt !== undefined && startedAt >= heldSince) {
        answerHeld(text);
      }
    },
    /** Nobody spoke for a while after the model's line: the call may be over. This turn may act,
     * but it speaks only to end the call: anything else it writes would be said over a caller who
     * is thinking, or about to answer the model's own question. */
    quiet(): void {
      if (running > 0 || !lastCallerLine || options.session().pendingConfirmation) return;
      let ended = false;
      const watch = (event: AgentTurnStreamEvent) => {
        if (endedCall(event)) ended = true;
      };
      void counted(turnFor(QUIET_NOTE, { request: true, observe: watch }).then((reply) => (ended && reply ? tell(reply, null) : undefined)));
    },
    /** Resolves once everything asked so far went back to the model. */
    settled: () => (running === 0 ? Promise.resolve() : settled),
  };
}
