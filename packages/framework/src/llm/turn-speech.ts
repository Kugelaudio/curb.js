import { normalizeLlmPunctuation } from "./punctuation.js";

/**
 * Where one sentence ends and the next one has begun: closing punctuation (plus any
 * closing quote or bracket) and whitespace, or a line break, followed by the next
 * sentence's first character.
 */
const SENTENCE_BREAK = /(?:[.!?…]+["'”’»)\]]*\s+|\n\s*)(?=\S)/g;

/**
 * Stage directions at the start of a step: narration in brackets or parentheses
 * ("[assistant turned their head away]", "(pauses)") that a model writes in place of words or
 * of skip_turn. Never said: TTS would read it out. A group needs a letter, so a reply opening
 * with "(030) 1234 567" is said.
 */
const LEADING_STAGE_DIRECTIONS = /^\s*(?:(?:\[[^[\]]*\p{L}[^[\]]*\]|\([^()]*\p{L}[^()]*\))\s*)+/u;

/** A step that opens with a bracket or parenthesis it has not closed yet. */
const OPEN_STAGE_DIRECTION = /^\s*(?:(?:\[[^[\]]*\]|\([^()]*\))\s*)*(?:\[[^\]]*|\([^)]*)$/;

/** The sentences of `text`, each with the break that follows it, so that joined they are `text`. */
function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let from = 0;
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    const end = match.index + match[0].length;
    sentences.push(text.slice(from, end));
    from = end;
  }
  return [...sentences, text.slice(from)].filter((sentence) => sentence.trim());
}

/** A sentence as two of them are compared: its words, whatever their case and punctuation. */
function wordsOf(sentence: string): string {
  return sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * What one turn says aloud, decided while its LLM steps stream.
 *
 * A step that calls a tool says nothing, whichever tool it is: words in front of a tool
 * ("Let me check that.") are narration of a wait, and the answer comes after the result. The
 * provider reveals the tool call only after the text, so the newest sentence of a step is
 * HELD: it is released once the next sentence starts, or when the step ends without a tool
 * call. When a tool call starts, the step falls silent: whatever is held stays held until the
 * step ends, and is dropped then. What a tool call says comes from its input or its tool, as
 * a {@link line} of its own once the call ran: an `end_call`'s goodbye, a `<Tool confirm>`
 * read-back. A model that wrote its goodbye as text too has said the start of it by then, so
 * only the rest of the goodbye is said ({@link unheard}).
 *
 * A step's opening stage directions ({@link LEADING_STAGE_DIRECTIONS}) are never said: a step
 * opening with a bracket says nothing until it closed. A step that wrote nothing else says
 * nothing at all.
 *
 * The transcript records exactly {@link stepText}, so what the model remembers saying is
 * what the caller heard. Steps are joined with one space, so the words of two steps never
 * run together ("for you.What's").
 */
export class TurnSpeech {
  /** Everything the turn said, in order. */
  private said = "";
  /** What the current step said. */
  private step = "";
  /** The current step's text that has not been said yet. */
  private held = "";
  /** A tool call started: nothing more of this step is said before it ends. */
  private muted = false;
  /** The step is a line the framework says word for word ({@link line}), not the model's. */
  private verbatim = false;

  /** What the turn said aloud, trimmed. */
  get reply(): string {
    return this.said.trim();
  }

  /** What the current step said aloud, trimmed. The transcript records exactly this. */
  get stepText(): string {
    return this.step.trim();
  }

  /** A new LLM step starts. */
  startStep(): void {
    this.step = "";
    this.held = "";
    this.muted = false;
    this.verbatim = false;
  }

  /** One streamed text delta. Returns what to say now: every complete sentence but the newest. */
  text(delta: string): string {
    this.held += delta;
    if (this.muted) return "";
    if (!this.step.trim() && OPEN_STAGE_DIRECTION.test(this.held)) return "";
    let cut = 0;
    for (const match of this.held.matchAll(SENTENCE_BREAK)) cut = match.index + match[0].length;
    return cut === 0 ? "" : this.release(cut);
  }

  /** The provider started a tool call: nothing more of this step is said. */
  toolInputStart(): void {
    this.muted = true;
  }

  /** The step's response is complete. `speaks`: it ended without a tool call. Returns the
   * held rest when it speaks; drops it otherwise. */
  endStep(speaks: boolean): string {
    if (speaks) return this.release(this.held.length);
    this.held = "";
    return "";
  }

  /** A step that arrived whole (non-streaming transport): said only when it speaks. */
  wholeStep(text: string, speaks: boolean): string {
    this.held = text;
    return this.endStep(speaks);
  }

  /** A line the framework says itself, word for word, as a step of its own: a tool call's
   * goodbye or read-back, or a fallback reply. */
  line(text: string): string {
    this.startStep();
    this.verbatim = true;
    return this.wholeStep(text, true);
  }

  /**
   * The part of `line` the caller has not heard: `line` without its leading sentences that
   * are, word for word, the last sentences this turn said. A model often writes its goodbye
   * as text and passes it to `end_call` as well; of that text every sentence but the newest
   * was said before the tool call showed, and saying the whole goodbye after it would say
   * them twice. Only whole sentences that were said are left out, compared by their words
   * (case and punctuation aside), so nothing the caller has not heard is dropped. "" when
   * the turn has said all of it.
   */
  unheard(line: string): string {
    const said = sentencesOf(this.said).map(wordsOf);
    const sentences = sentencesOf(line);
    for (let count = Math.min(said.length, sentences.length); count > 0; count -= 1) {
      const last = said.slice(-count);
      if (last.every((words, index) => words !== "" && words === wordsOf(sentences[index]!))) {
        return sentences.slice(count).join("").trim();
      }
    }
    return line;
  }

  private release(cut: number): string {
    const piece = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    return this.say(piece);
  }

  /** Append `piece` to what was said; returns the delta to stream ("" for nothing). */
  private say(piece: string): string {
    let delta = normalizeLlmPunctuation(piece);
    if (!this.step.trim()) {
      // The step's first words: no stage direction, no leading whitespace, one space after
      // the turn's last word.
      if (!this.verbatim) delta = delta.replace(LEADING_STAGE_DIRECTIONS, "");
      delta = delta.trimStart();
      if (!delta) return "";
      if (this.said && !/\s$/.test(this.said)) delta = ` ${delta}`;
    }
    this.said += delta;
    this.step += delta;
    return delta;
  }
}
