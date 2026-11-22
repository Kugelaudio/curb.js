import { STYLE_METRICS, type ScenarioTurn, type StyleLimits, type StyleMetric } from "./scenario.js";

/**
 * How the agent talks, in numbers anyone can recount from the transcripts: how long its replies
 * are, how often they end in a question, how often they open or close with a sentence it
 * already used, whether every run ends on the same goodbye, how many model steps a turn takes
 * and how many tool calls were refused. No model is asked: the same conversations always give
 * the same numbers. They are reported for every scenario and fail nothing unless a limit is set.
 */

/** One number per {@link StyleMetric}; null where the conversations give nothing to count. */
export type StyleNumbers = Record<StyleMetric, number | null>;

/** A limit that was set, the value it was held against, and whether the value is within it. */
export type StyleLimitResult = { metric: StyleMetric; limit: number; value: number | null; pass: boolean };

export type StyleReport = StyleNumbers & {
  /** The agent replies the numbers are counted over. */
  replies: number;
  /** One entry per limit that was set. */
  limits: StyleLimitResult[];
};

/** One conversation, as the style numbers read it. */
export type StyledConversation = { turns: readonly ScenarioTurn[] };

/** What the agent itself said in a turn: the reply without the framework's fallback line. */
export function agentWords(turn: ScenarioTurn): string {
  return (turn.fallback ? turn.reply.slice(0, -turn.fallback.length) : turn.reply).trim();
}

/** The sentences of `text`, in order. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["'”’»)\]]*)\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** A sentence as two of them are compared: ignoring case, punctuation and spacing. */
export function sentenceKey(sentence: string): string {
  return sentence.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The value at or below which `share` of the sorted values lie (nearest rank). */
function percentile(sorted: readonly number[], share: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))]!;
}

const rounded = (value: number) => Math.round(value * 100) / 100;
const shareOf = (count: number, total: number) => (total === 0 ? null : rounded(count / total));

/** The style numbers of a scenario's conversations, and how they hold against `limits`. */
export function styleReport(conversations: readonly StyledConversation[], limits: StyleLimits = {}): StyleReport {
  const words: number[] = [];
  const steps: number[] = [];
  let questions = 0;
  let repeatedOpenings = 0;
  let repeatedClosings = 0;
  let refused = 0;
  const goodbyes: string[] = [];

  for (const { turns } of conversations) {
    const openings = new Set<string>();
    const closings = new Set<string>();
    for (const turn of turns) {
      if (turn.steps > 0) steps.push(turn.steps);
      refused += turn.toolCalls.filter((call) => !call.ok && call.heldFor === undefined).length;
      const reply = agentWords(turn);
      const said = sentences(reply).map(sentenceKey).filter(Boolean);
      if (said.length === 0) continue;
      words.push(reply.split(/\s+/).length);
      if (/[?？]["'”’»)\]]*$/.test(reply)) questions += 1;
      const opening = said[0]!;
      const closing = said[said.length - 1]!;
      if (openings.has(opening)) repeatedOpenings += 1;
      if (closings.has(closing)) repeatedClosings += 1;
      openings.add(opening);
      closings.add(closing);
      if (turn.endedCall) goodbyes.push(sentenceKey(reply));
    }
  }

  words.sort((left, right) => left - right);
  const mostSaid = Math.max(0, ...[...new Set(goodbyes)].map((goodbye) => goodbyes.filter((other) => other === goodbye).length));
  const numbers: StyleNumbers = {
    wordsP50: percentile(words, 0.5),
    wordsP90: percentile(words, 0.9),
    questionShare: shareOf(questions, words.length),
    repeatedOpeningShare: shareOf(repeatedOpenings, words.length),
    repeatedClosingShare: shareOf(repeatedClosings, words.length),
    // One goodbye is the same as itself: only two or more runs can tell.
    sameGoodbyeShare: goodbyes.length < 2 ? null : rounded(mostSaid / goodbyes.length),
    stepsPerTurn: steps.length === 0 ? null : rounded(steps.reduce((sum, count) => sum + count, 0) / steps.length),
    stepsPerTurnMax: steps.length === 0 ? null : Math.max(...steps),
    refusedToolCallsPerRun: conversations.length === 0 ? null : rounded(refused / conversations.length),
  };
  return {
    replies: words.length,
    ...numbers,
    limits: STYLE_METRICS.flatMap((metric) => {
      const limit = limits[metric];
      if (limit === undefined) return [];
      const value = numbers[metric];
      return [{ metric, limit, value, pass: value === null || value <= limit }];
    }),
  };
}

/**
 * How the agent talks across conversations, counted from their transcripts: words per reply
 * (p50, p90), the share of replies that end on a question or open or close with a sentence the
 * agent already used, whether every call ends on the same goodbye, model steps per turn and
 * refused tool calls per conversation. `limits` holds the highest value accepted per number;
 * each one set is in `limits` of the result with whether it held. No model is asked.
 */
export function styleNumbers(records: readonly StyledConversation[], limits: StyleLimits = {}): StyleReport {
  return styleReport(records, limits);
}
