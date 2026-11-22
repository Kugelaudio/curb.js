import type { StyleLimitResult, StyleReport } from "./types.js";

/** The style numbers as `curb test` prints them. */

const percent = (share: number | null) => (share === null ? "n/a" : `${Math.round(share * 100)}%`);
const plain = (value: number | null) => (value === null ? "n/a" : String(value));

/** The numbers on one line, as the terminal and the Markdown report show them. */
export function styleLine(style: StyleReport): string {
  if (style.replies === 0) return "no agent reply to count";
  return [
    `words per reply p50 ${plain(style.wordsP50)}, p90 ${plain(style.wordsP90)}`,
    `ends on a question ${percent(style.questionShare)}`,
    `repeated opening ${percent(style.repeatedOpeningShare)}, closing ${percent(style.repeatedClosingShare)}`,
    ...(style.sameGoodbyeShare === null ? [] : [`same goodbye ${percent(style.sameGoodbyeShare)}`]),
    `steps per turn ${plain(style.stepsPerTurn)} (max ${plain(style.stepsPerTurnMax)})`,
    `refused tool calls per run ${plain(style.refusedToolCallsPerRun)}`,
  ].join(" · ");
}

/** A limit that was broken, in words: "wordsP90 is 52, above the limit of 40". */
export function styleLimitLine(result: StyleLimitResult): string {
  return `${result.metric} is ${plain(result.value)}, ${result.pass ? "within" : "above"} the limit of ${result.limit}`;
}

