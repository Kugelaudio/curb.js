import { describe, expect, it } from "vitest";
import { refused, turn } from "../test-fixtures/conversations.js";
import { styleLine, styleReport } from "./style.js";

describe("style numbers", () => {
  const first = {
    turns: [
      turn({ turn: 0, caller: null, reply: "Hello, this is Lena. How can I help?", steps: 1 }),
      turn({ turn: 1, reply: "Of course. Which day suits you?", steps: 2, toolCalls: [refused("book", "No such slot."), refused("book", "No such slot.")] }),
      turn({ turn: 2, reply: "Of course. I have booked that for you.", steps: 3 }),
      turn({ turn: 3, reply: "Is there anything else? Which day suits you?", steps: 1 }),
      turn({ turn: 4, reply: "", skipped: true, steps: 1 }),
      turn({ turn: 5, reply: "Thanks for calling. Goodbye.", endedCall: true, steps: 1 }),
    ],
  };
  const second = { turns: [turn({ turn: 1, reply: "thanks for calling, goodbye!", endedCall: true, steps: 1 })] };

  it("counts words, question endings, repeated openings and closings, steps and refused calls", () => {
    const style = styleReport([first]);
    expect(style).toMatchObject({
      replies: 5,
      // 4, 6, 8, 8 and 8 words.
      wordsP50: 8,
      wordsP90: 8,
      // Three of five replies end on a question.
      questionShare: 0.6,
      // "Of course." opens two replies; "Which day suits you?" closes two.
      repeatedOpeningShare: 0.2,
      repeatedClosingShare: 0.2,
      // One run cannot say whether every run ends the same way.
      sameGoodbyeShare: null,
      stepsPerTurn: 1.5,
      stepsPerTurnMax: 3,
      refusedToolCallsPerRun: 2,
      limits: [],
    });
  });

  it("compares the goodbyes of the runs that the agent ended, ignoring case and punctuation", () => {
    expect(styleReport([first, second]).sameGoodbyeShare).toBe(1);
    const other = { turns: [turn({ turn: 1, reply: "Take care, bye.", endedCall: true })] };
    expect(styleReport([first, second, other]).sameGoodbyeShare).toBe(0.67);
  });

  it("leaves the fallback line out and has nothing to count without a reply", () => {
    const fallback = "Sorry, something went wrong.";
    const withFallback = styleReport([{ turns: [turn({ turn: 1, reply: `One moment. ${fallback}`, fallback })] }]);
    expect(withFallback).toMatchObject({ replies: 1, wordsP50: 2 });
    const empty = styleReport([{ turns: [turn({ turn: 1, reply: "", skipped: true, steps: 0 })] }]);
    expect(empty).toMatchObject({ replies: 0, wordsP50: null, questionShare: null, stepsPerTurn: null });
    expect(styleLine(empty)).toBe("no agent reply to count");
  });

  it("holds the numbers against the limits that are set, and only those", () => {
    const style = styleReport([first], { wordsP90: 6, questionShare: 0.6, sameGoodbyeShare: 0.5 });
    expect(style.limits).toEqual([
      { metric: "wordsP90", limit: 6, value: 8, pass: false },
      { metric: "questionShare", limit: 0.6, value: 0.6, pass: true },
      // Nothing to count is nothing to fail.
      { metric: "sameGoodbyeShare", limit: 0.5, value: null, pass: true },
    ]);
  });

  it("is one line a person can read", () => {
    expect(styleLine(styleReport([first, second]))).toBe(
      "words per reply p50 6, p90 8 · ends on a question 50% · repeated opening 17%, closing 17% · same goodbye 100% · steps per turn 1.43 (max 3) · refused tool calls per run 1",
    );
  });
});
