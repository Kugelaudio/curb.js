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

/** Curb's way into the model when it did not ask, which LiveKit's `GPTLiveSession` fits. */
export type VoiceBackChannel = {
  appendCommentary(text: string, options: { delegationId: string | null }): void;
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
 * of them could release it on a yes nobody said. */
const HELD = "The back office is taking the caller's answer. Say nothing until it reports.";

/** The model's tool call and its transcript of a held answer arrive in either order, so a call
 * this soon after the answer was taken is about that same answer. */
const ANSWER_WINDOW_MS = 4000;

const sameWords = (text: string) => text.trim().toLowerCase();

export function createBackOffice(options: { session: () => AgentSession; voice: () => VoiceBackChannel | null }) {
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
  let answeredAt = Number.NEGATIVE_INFINITY;

  const flush = () => {
    const session = options.session();
    while (!session.isRunning && waiting.length > 0) {
      const line = waiting.shift()!;
      session.recordHeard(line.role, line.text);
    }
  };

  const turnFor = (words: string): Promise<string> => {
    const key = sameWords(words);
    const known = turns.get(key);
    if (known) return known;
    taken.add(key);
    const turn = options
      .session()
      .runTurn(words, { heard: true })
      .finally(() => {
        turns.delete(key);
        flush();
      });
    turns.set(key, turn);
    return turn;
  };

  const ask = (words: string, delegationId: string | null): Promise<void> => {
    running += 1;
    const work = turnFor(words)
      .then((reply) => {
        for (const piece of commentaryPieces(reply || NOTHING_TO_ADD)) {
          options.voice()?.appendCommentary(piece, { delegationId });
        }
      })
      .finally(() => {
        running -= 1;
      });
    settled = Promise.allSettled([settled, work]).then(() => undefined);
    return work;
  };

  return {
    /** The model handed a turn over. Its transcript may lag: the newest line stands in for it. */
    delegated(delegationId: string, pendingTranscript: string): Promise<void> {
      latest = delegationId;
      return ask(pendingTranscript.trim() || lastCallerLine, delegationId);
    },
    /** The model called its tool: the same turn, with the outcome as the tool's result. */
    asked(request: string): Promise<string> {
      if (options.session().pendingConfirmation || Date.now() - answeredAt < ANSWER_WINDOW_MS) return Promise.resolve(HELD);
      running += 1;
      const work = turnFor(request)
        .then((reply) => reply || NOTHING_TO_ADD)
        .finally(() => {
          running -= 1;
        });
      settled = Promise.allSettled([settled, work]).then(() => undefined);
      return work;
    },
    /** Words typed into a call, which the model cannot hear. */
    typed: (text: string) => ask(text, null),
    /** A finished line of the call. The caller's answer to a held action always reaches Curb:
     * the model does not know one waits, and nothing else can release it. */
    heard(role: "user" | "assistant", text: string): void {
      if (role === "user") {
        lastCallerLine = text;
        if (taken.delete(sameWords(text))) return;
      }
      waiting.push({ role, text });
      flush();
      if (role === "user" && options.session().pendingConfirmation) {
        answeredAt = Date.now();
        void ask(text, latest);
      }
    },
    /** Resolves once everything asked so far went back to the model. */
    settled: () => (running === 0 ? Promise.resolve() : settled),
  };
}
