import { FINDINGS, type ConversationRecord, type Finding, type judge } from "../testing/index.js";
import { CALLED_FOR, formatCoverage, type Coverage } from "./review-coverage.js";
import { throttledLine, usageLine } from "./scenarios/report.js";
import type { ReviewPattern, RunUsage, ThrottleStats } from "./scenarios/types.js";

/**
 * What `curb review` asks of each call, and its report. The judge of `curb test` answers the
 * questions a call's record can answer, `groupFindings` sorts the findings into patterns, and
 * code counts them: a number in the report is counted, and a quote is from a call.
 */

/** The one question only a review asks: a real call has no goal written down to judge. */
export const UNRESOLVED = {
  id: "unresolved",
  text:
    "The caller did not get what they called for by the end of the call: it was not done, not answered, or only promised for later. " +
    "A caller who got it and wanted nothing more does not count. Answer unknown when the call does not show what the caller wanted. " +
    "Start the reason with what the caller called for, in a few words. " +
    "Quote the words that show it was left open.",
} as const;

/**
 * What a review asks instead of `ended_early` when the agent ended the call. A real call has no
 * goal written down, so "did the agent end it early" is a judgement the judge makes poorly
 * without one; whether the caller's last line was a goodbye is a fact it reads well. Code makes
 * a "no" the `ended_early` finding.
 */
export const CALLER_CLOSED = {
  id: "caller_closed",
  text:
    'In the caller\'s last line before the agent ended the call, the caller said goodbye or said that they need nothing else ("that\'s all", "nothing else, thanks"). ' +
    "A thank-you alone, a new request, an answer to the agent's question, or a request the agent then carried out is not a goodbye. " +
    "Quote the caller's last line.",
} as const;

/** What a review can find, in one sentence each: the built-in findings and `unresolved`. */
export const REVIEW_FINDINGS: Readonly<Record<string, string>> = {
  ...FINDINGS,
  unresolved: "The caller did not get what they called for by the end of the call.",
};

/** Why a question is not asked of a call, by what its record lacks. */
export const NOT_ASKED = {
  tools: { questions: ["claimed_without_tool", "wrong_tool_use"], of: "without recorded tool calls" },
  ending: { questions: ["ended_early"], of: "whose record does not say who ended the call" },
} as const;

/** Whether a call's source records the agent's tool calls. */
export const recordsTools = (call: Pick<ConversationRecord, "recordsToolCalls">) => call.recordsToolCalls !== false;

/** What the judge is asked of one call: every built-in finding its record can answer and
 * `unresolved`; `ended_early` is asked as {@link CALLER_CLOSED}, and only of a call the agent ended;
 * and what the caller called for ({@link CALLED_FOR}), for the coverage. */
export function reviewAsks(call: Pick<ConversationRecord, "recordsToolCalls" | "ending">): { findings: Record<string, string>; expectations: Record<string, string> } {
  const left: readonly string[] = [...(recordsTools(call) ? [] : NOT_ASKED.tools.questions), ...NOT_ASKED.ending.questions];
  const findings: Record<string, string> = Object.fromEntries(Object.entries(FINDINGS).filter(([id]) => !left.includes(id)));
  findings[UNRESOLVED.id] = UNRESOLVED.text;
  return { findings, expectations: { ...(call.ending.by === "agent" ? { [CALLER_CLOSED.id]: CALLER_CLOSED.text } : {}), [CALLED_FOR.id]: CALLED_FOR.text } };
}

/** What the caller of a judged call called for, from the reason of the judge's yes to
 * {@link CALLED_FOR}; null when the call did not show it. */
export function calledFor(judged: Awaited<ReturnType<typeof judge>>): string | null {
  const answer = judged.answers.find((candidate) => candidate.id === CALLED_FOR.id);
  return answer?.answer === "yes" && !answer.reason.startsWith("(") ? answer.reason : null;
}

/** Longest quote of the agent's last words an `ended_early` finding keeps. */
const MAX_LAST_WORDS = 200;

/** The judge's findings about a call, with `ended_early` among them when the agent ended the call
 * and the caller's last line was no goodbye, quoting the agent's last words. */
export function findingsOf(call: Pick<ConversationRecord, "turns"> & { id?: string }, judged: Awaited<ReturnType<typeof judge>>): Finding[] {
  const ended: Finding[] = judged.answers.flatMap((answer): Finding[] => {
    if (answer.id !== CALLER_CLOSED.id) return [];
    const last = call.turns.findLast((turn) => turn.endedCall) ?? call.turns.at(-1);
    const words = last?.reply.trim() || last?.caller?.trim() || "";
    if (answer.answer !== "no" || !last || !words) return [];
    const quote = words.length > MAX_LAST_WORDS ? `…${words.slice(-MAX_LAST_WORDS)}` : words;
    return [{ call: call.id ?? "call", kind: "ended_early", turn: last.turn, quote, reason: answer.reason }];
  });
  // In the order the judge was asked: the built-in findings, the caller's goodbye, then the review's own.
  const builtIn = (finding: Finding) => Object.hasOwn(FINDINGS, finding.kind);
  return [...judged.findings.filter(builtIn), ...ended, ...judged.findings.filter((finding) => !builtIn(finding))];
}

const MAX_EXAMPLES = 3;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** What `curb review` reports, and prints as one JSON object with --json. */
export type ReviewReport = {
  calls: { reviewed: number; withoutFindings: number; withFindings: number; notJudged: number; skipped: number };
  patterns: ReviewPattern[];
  /** What the callers called about, by topic, and the scenarios that test each. */
  coverage: Coverage;
  /** The questions that were not asked of some calls, with how many and why. */
  notAsked: Array<{ questions: string[]; calls: number; why: string }>;
  notJudged: Array<{ call: string; reason: string }>;
  notes: string[];
  /** The judge's model as `provider:model`, or null when the host did not say. */
  judgeModel: string | null;
  judgePromptVersion: string;
  usage: RunUsage | null;
  throttled?: ThrottleStats & { concurrency: number };
  exitCode: 0 | 1;
};

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** The report as the terminal prints it. */
export function formatReview(report: ReviewReport): string {
  const { calls } = report;
  const judged = calls.reviewed - calls.notJudged;
  const lines = [
    `Reviewed ${calls.reviewed} call(s): ${calls.withoutFindings} with no finding, ${calls.withFindings} with findings, ${calls.notJudged} not judged.`,
    ...(calls.skipped > 0 ? [`Left out ${calls.skipped} call(s) that have no transcript.`] : []),
  ];
  report.patterns.forEach((pattern, index) => {
    lines.push(
      "",
      `${index + 1}. ${pattern.title}`,
      `   ${pattern.calls} of ${judged} judged call(s), ${percent(pattern.share)} · ${pattern.kinds.join(", ")}`,
      ...pattern.examples.map(({ call, turn, quote, reason }) => `   call ${call}${turn === null ? "" : `, turn ${turn}`}: ${JSON.stringify(quote)} (${oneLine(reason)})`),
    );
    const draft = pattern.scenario;
    if (!draft) return;
    const caller = [
      `goal: ${JSON.stringify(draft.caller.goal)}`,
      ...(draft.caller.knows ? [`knows: ${JSON.stringify(draft.caller.knows)}`] : []),
      ...(draft.caller.persona ? [`persona: ${JSON.stringify(draft.caller.persona)}`] : []),
    ];
    lines.push(`   Scenario to add${draft.from ? ` (its caller from call ${draft.from})` : ""}:`, `     caller: { ${caller.join(", ")} },`);
    if (draft.failOn) lines.push(`     failOn: ${JSON.stringify(draft.failOn)},`);
    if (draft.expectations) lines.push(`     expectations: ${JSON.stringify(draft.expectations)},`);
  });
  const coverage = formatCoverage(report.coverage);
  if (coverage.length > 0) lines.push("", ...coverage);
  const tokens = usageLine(report.usage);
  const after = [
    ...report.notAsked.map(({ questions, calls: count, why }) => `Not asked of ${count} call(s) ${why}: ${questions.join(", ")}.`),
    ...report.notJudged.slice(0, MAX_EXAMPLES).map(({ call, reason }) => `Not judged: call ${call}: ${reason}`),
    ...report.notes.map((note) => `Note: ${note}`),
    ...(tokens ? [`Tokens: ${tokens}`] : []),
    ...(report.throttled ? [throttledLine(report.throttled)] : []),
    ...(report.patterns.length > 0 ? ["Next: add a pattern's scenario under src/agent/, run `npx curb test` to see it fail, fix the agent, run it again."] : []),
  ];
  if (after.length > 0) lines.push("", ...after);
  return `${lines.join("\n")}\n`;
}

