/**
 * Split `fullText` after as many words as the caller actually HEARD.
 *
 * The spoken prefix comes from the TTS provider's forced alignment, so it is a
 * run of bare words — no punctuation, none of the model's original whitespace.
 * `"Hey I'm Juno here "` is not a character-prefix of `"Hey, I'm Juno, here to
 * help."`, so `startsWith` fails and slicing by its length cuts several
 * characters short, landing mid-word. Counting WORDS and cutting the original
 * at that boundary keeps the author's punctuation on the spoken side and makes
 * the unspoken remainder exact — which is the whole point: the remainder is
 * what the preview greys out as never-said.
 *
 * There is deliberately NO `startsWith` fast path. When the alignment prefix
 * does happen to be a character-prefix it is one that stops just before the
 * punctuation attached to the last heard word — `"All set"` against `"All
 * set."` — so taking it verbatim strands a lone `"."` in the muted remainder.
 * The word walk gets that case right too.
 */
export function splitAtSpokenWords(
  fullText: string,
  spokenText: string,
): { spoken: string; unspoken: string } {
  const spoken = spokenText.trim();
  if (!spoken) return { spoken: "", unspoken: fullText };

  const heardWords = spoken.split(/\s+/).length;
  const word = /\S+/g;
  let seen = 0;
  let cut = fullText.length;
  for (let match = word.exec(fullText); match !== null; match = word.exec(fullText)) {
    seen += 1;
    if (seen < heardWords) continue;
    cut = match.index + match[0].length;
    break;
  }
  return {
    spoken: fullText.slice(0, cut).trimEnd(),
    unspoken: fullText.slice(cut).trimStart(),
  };
}

/** Bare word, lowercased, stripped of the punctuation forced alignment omits. */
function bareWord(word: string): string {
  return word.replace(/[^\p{L}\p{N}']/gu, "").toLowerCase();
}

/**
 * Does this spoken prefix belong to this reply?
 *
 * Audio outlives the text that produced it: the LLM finishes a turn well before
 * the voice does, and the transcript entry is committed somewhere in between.
 * So a live cursor can arrive while the newest committed message is still the
 * PREVIOUS reply — and applying it there would grey out words the caller
 * already heard, which is the opposite of the point.
 *
 * Comparing the first spoken word to the reply's first word is enough to tell
 * those apart, and it costs nothing. Alignment drops punctuation, so compare
 * bare words rather than raw ones.
 */
export function spokenBelongsToReply(fullText: string, spokenText: string): boolean {
  const heard = bareWord(spokenText.trim().split(/\s+/)[0] ?? "");
  const written = bareWord(fullText.trim().split(/\s+/)[0] ?? "");
  return heard.length > 0 && heard === written;
}

/**
 * Where the agent's current spoken reply is, as ONE value.
 *
 * This replaced a `string | null` that meant four different things depending on
 * who was reading it — no reply, reply coming, N words heard, all heard — and
 * every render bug in this feature came from two readers disagreeing about
 * which. The phases are explicit so they cannot be confused, and every
 * transition has exactly one cause:
 *
 *   idle     no reply in flight; a message renders as the finished text it is
 *   pending  a turn started; nothing has been heard, so the reply is all muted
 *   speaking `heard` words have reached the caller; the rest stays muted
 *   spoken   the transcript stream ran to its end, so all of it was heard
 *
 * `spoken` is distinct from `idle` on purpose even though both render the same:
 * conflating them is what made a finished reply flicker back to muted when the
 * next turn armed `pending`.
 */
export type ReplyPlayback =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "speaking"; heard: string }
  | { phase: "spoken" };

export const REPLY_IDLE: ReplyPlayback = { phase: "idle" };

/**
 * How to ink one reply, or `null` for "render it normally".
 *
 * The ONLY place the phases turn into pixels, so the panel cannot invent a
 * fifth rule. A reply carrying its own interruption record is not this
 * function's business — that record is the finished truth and wins upstream.
 */
export function replyInk(
  content: string,
  playback: ReplyPlayback,
): { spoken: string; unspoken: string } | null {
  switch (playback.phase) {
    case "idle":
    case "spoken":
      return null;
    case "pending":
      return { spoken: "", unspoken: content };
    case "speaking":
      // Audio outlives the text that produced it, so a cursor can arrive while
      // the newest committed message is still the PREVIOUS reply. Inking there
      // would grey out words already heard.
      return spokenBelongsToReply(content, playback.heard)
        ? splitAtSpokenWords(content, playback.heard)
        : null;
  }
}
