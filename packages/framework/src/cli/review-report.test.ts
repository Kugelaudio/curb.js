import { describe, expect, it } from "vitest";
import { judgeAnswer, turn } from "../test-fixtures/conversations.js";
import { judge, type ConversationRecord } from "../testing/index.js";
import { judgePrompt, judgeQuestions, type JudgeQuestion } from "../testing/judge.js";
import { findingsOf, formatReview, reviewAsks, type ReviewReport } from "./review-report.js";

type Answers = NonNullable<Parameters<typeof judgeAnswer>[1]>;

/** A judge model that answers `answers`, no to the rest, and keeps every prompt it was sent. */
function answering(answers: Answers = {}) {
  const prompts: string[] = [];
  const model = async (system: string) => {
    prompts.push(system);
    return judgeAnswer({ systemPrompt: system, skillTitle: "", stateSnapshot: [], tools: [], messages: [] }, answers);
  };
  return { model, prompts };
}

const turns = [
  turn({ turn: 1, caller: "I need to move my appointment to Friday.", reply: "I can note that for the team." }),
  turn({ turn: 2, caller: "So is it moved?", reply: "Someone will call you back. Goodbye." }),
];
const call = (endedBy: "agent" | "caller" | null, recordsTools: boolean, of = turns): ConversationRecord => ({
  format: "curb.conversation",
  version: 1,
  source: "transcript",
  id: "call-a",
  caller: null,
  experiments: {},
  startedAt: null,
  durationMs: 0,
  turns: of,
  ending: { by: endedBy, unsaid: [], maxTurns: 2, caller: null },
  endState: null,
  unusedFakes: [],
  usage: null,
  ...(recordsTools ? {} : { recordsToolCalls: false as const }),
});

/** The ids of the questions a review asks of a call, as the judge's prompt lists them. */
async function ids(endedBy: "agent" | "caller" | null, recordsTools: boolean): Promise<string[]> {
  const { model, prompts } = answering();
  const record = call(endedBy, recordsTools);
  await judge(record, { ...reviewAsks(record), model });
  return [...prompts[0]!.matchAll(/^- ([a-z_0-9]+): /gm)].map((match) => match[1]!);
}

describe("the questions of a review", () => {
  it("asks only what a call's record can answer, and always whether the caller got what they called for", async () => {
    // The caller hung up: the agent did not end it early.
    expect(await ids("caller", true)).toEqual(["asked_again", "claimed_without_tool", "ignored_caller", "incoherent", "wrong_tool_use", "unresolved"]);
    // No recorded tool calls: a claim cannot be held against them. The agent ended it: was the caller's last line a goodbye?
    expect(await ids("agent", false)).toEqual(["asked_again", "ignored_caller", "incoherent", "caller_closed", "unresolved"]);
    // Nobody knows who ended the call: it cannot have been ended early.
    expect(await ids(null, true)).toEqual(["asked_again", "claimed_without_tool", "ignored_caller", "incoherent", "wrong_tool_use", "unresolved"]);
    expect(await ids(null, false)).toEqual(["asked_again", "ignored_caller", "incoherent", "unresolved"]);
  });

  it("words the built-in findings as curb test does, and adds no goal", async () => {
    const { model, prompts } = answering();
    const record = call("agent", true);
    await judge(record, { ...reviewAsks(record), model });
    const own: JudgeQuestion[] = judgeQuestions(null, []).filter((question) => question.id !== "ended_early");
    expect(prompts[0]).toContain("- caller_closed: Is this true of the call? In the caller's last line before the agent ended the call, the caller said goodbye");
    expect(prompts[0]).toContain(
      "- unresolved: Is this true of the call? The caller did not get what they called for by the end of the call: it was not done, not answered, or only promised for later.",
    );
    expect(prompts[0]).toContain("Start the reason with what the caller called for, in a few words.");
    expect(prompts[0]!.startsWith(judgePrompt(own).split("\n\nAnswer with one JSON object")[0]!)).toBe(true);
    expect(prompts[0]).not.toContain("- goal:");
  });
});

describe("judging a call for a review", () => {
  it("counts unresolved with a quote from the call, the caller's words included", async () => {
    const { model } = answering({
      unresolved: { answer: "yes", turn: 2, quote: "So is it moved?", reason: "Moving an appointment: it was only promised." },
      ignored_caller: { answer: "yes", turn: 2, quote: "Someone will call you back", reason: "It did not answer the question." },
    });
    const record = call(null, false);
    const judged = await judge(record, { ...reviewAsks(record), model });
    expect(judged.answers.map((answer) => answer.id)).toEqual(["asked_again", "ignored_caller", "incoherent", "unresolved"]);
    expect(findingsOf(record, judged)).toEqual([
      { call: "call-a", kind: "ignored_caller", turn: 2, quote: "Someone will call you back", reason: "It did not answer the question." },
      { call: "call-a", kind: "unresolved", turn: 2, quote: "So is it moved?", reason: "Moving an appointment: it was only promised." },
    ]);
  });

  it("does not count unresolved without a quote the transcript holds", async () => {
    const { model } = answering({ unresolved: { answer: "yes", turn: 2, quote: "I give up", reason: "Moving an appointment." } });
    const record = call("caller", true);
    const judged = await judge(record, { ...reviewAsks(record), model });
    expect(judged.answers.find((answer) => answer.id === "unresolved")).toMatchObject({ answer: "unknown", quote: null });
    expect(findingsOf(record, judged)).toEqual([]);
  });

  it("finds ended_early when the agent ended the call and the caller's last line was no goodbye, quoting the agent", async () => {
    const record = call("agent", false, [turns[0]!, { ...turns[1]!, endedCall: true }]);
    const open = await judge(record, { ...reviewAsks(record), model: answering({ caller_closed: { answer: "no", turn: 2, quote: "So is it moved?", reason: "The caller asked a question." } }).model });
    expect(findingsOf(record, open)).toEqual([
      { call: "call-a", kind: "ended_early", turn: 2, quote: "Someone will call you back. Goodbye.", reason: "The caller asked a question." },
    ]);
    // A goodbye, or no answer, finds nothing.
    for (const answer of ["yes", "unknown"] as const) {
      const closed = await judge(record, { ...reviewAsks(record), model: answering({ caller_closed: { answer, turn: 2, quote: "So is it moved?", reason: "-" } }).model });
      expect(findingsOf(record, closed)).toEqual([]);
    }
  });
});

const EARLY = { title: "Ends the call right after booking, before the caller says goodbye" };
const CALLBACK = { title: "Promises a callback instead of moving the appointment" };

describe("the review report", () => {
  const report: ReviewReport = {
    calls: { reviewed: 48, withoutFindings: 29, withFindings: 17, notJudged: 2, skipped: 3 },
    patterns: [
      {
        title: EARLY.title,
        calls: 9,
        share: 9 / 46,
        findings: 9,
        kinds: ["ended_early"],
        examples: [
          { call: "0f3a51c2", kind: "ended_early", turn: 5, quote: "You're all set for Tuesday at ten. Goodbye!", reason: "The caller had not said goodbye." },
          { call: "77b1e0aa", kind: "ended_early", turn: null, quote: 'Done. "Bye"', reason: "It hung up after booking." },
        ],
        scenario: { caller: { goal: "Book a haircut and then ask what it costs", knows: "Name Alex Example" }, failOn: ["ended_early"] },
      },
      {
        title: CALLBACK.title,
        calls: 4,
        share: 4 / 46,
        findings: 6,
        kinds: ["ignored_caller", "unresolved"],
        examples: [{ call: "c41d9e07", kind: "unresolved", turn: 3, quote: "So is it moved?", reason: "Moving an appointment: it was only promised." }],
        scenario: { caller: { goal: "Move an appointment to another day" }, expectations: ["The agent moves the appointment during the call."] },
      },
      { title: "The agent ignored or misread something the caller said.", calls: 1, share: 1 / 46, findings: 1, kinds: ["ignored_caller"], examples: [], scenario: null },
    ],
    notAsked: [
      { questions: ["claimed_without_tool", "wrong_tool_use"], calls: 48, why: "without recorded tool calls" },
      { questions: ["ended_early"], calls: 5, why: "whose record does not say who ended the call" },
    ],
    notJudged: [
      { call: "9d2e", reason: "HTTP 503: overloaded" },
      { call: "a8f0", reason: "the judge's answer could not be read: \"\"" },
    ],
    notes: ["A note."],
    judgeModel: "openai:gpt-5.4-mini",
    judgePromptVersion: "3",
    usage: { agent: null, caller: null, judge: { inputTokens: 91_000, outputTokens: 4_200, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalTokens: 95_200 },
    throttled: { waits: 1, waitedMs: 12_000, concurrency: 2 },
    exitCode: 0,
  };

  it("prints the counts, each pattern with its share, quotes and scenario, then what was not asked", () => {
    expect(formatReview(report)).toBe(
      [
        "Reviewed 48 call(s): 29 with no finding, 17 with findings, 2 not judged.",
        "Left out 3 call(s) that have no transcript.",
        "",
        "1. Ends the call right after booking, before the caller says goodbye",
        "   9 of 46 judged call(s), 20% · ended_early",
        '   call 0f3a51c2, turn 5: "You\'re all set for Tuesday at ten. Goodbye!" (The caller had not said goodbye.)',
        '   call 77b1e0aa: "Done. \\"Bye\\"" (It hung up after booking.)',
        "   Scenario to add:",
        '     caller: { goal: "Book a haircut and then ask what it costs", knows: "Name Alex Example" },',
        '     failOn: ["ended_early"],',
        "",
        "2. Promises a callback instead of moving the appointment",
        "   4 of 46 judged call(s), 9% · ignored_caller, unresolved",
        '   call c41d9e07, turn 3: "So is it moved?" (Moving an appointment: it was only promised.)',
        "   Scenario to add:",
        '     caller: { goal: "Move an appointment to another day" },',
        '     expectations: ["The agent moves the appointment during the call."],',
        "",
        "3. The agent ignored or misread something the caller said.",
        "   1 of 46 judged call(s), 2% · ignored_caller",
        "",
        "Not asked of 48 call(s) without recorded tool calls: claimed_without_tool, wrong_tool_use.",
        "Not asked of 5 call(s) whose record does not say who ended the call: ended_early.",
        "Not judged: call 9d2e: HTTP 503: overloaded",
        'Not judged: call a8f0: the judge\'s answer could not be read: ""',
        "Note: A note.",
        "Tokens: 95,200 tokens (judge 91,000 in / 4,200 out)",
        "Slowed down by the provider's rate limit: 1 wait(s), 12 s, then 2 conversation(s) at a time.",
        "Next: add a pattern's scenario under src/agent/, run `npx curb test` to see it fail, fix the agent, run it again.",
        "",
      ].join("\n"),
    );
  });

  it("is one line and no next step when nothing was found", () => {
    const clean: ReviewReport = { ...report, calls: { reviewed: 3, withoutFindings: 3, withFindings: 0, notJudged: 0, skipped: 0 }, patterns: [], notAsked: [], notJudged: [], notes: [], usage: null, throttled: undefined };
    expect(formatReview(clean)).toBe("Reviewed 3 call(s): 3 with no finding, 0 with findings, 0 not judged.\n");
  });
});
