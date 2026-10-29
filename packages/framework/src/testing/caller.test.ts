import { describe, expect, it } from "vitest";
import { callerPrompt, parseCallerLine, parseVerdict } from "./caller.js";

describe("the simulated caller's line", () => {
  it("takes the line as spoken: no role prefix, no quotes, nothing written for the agent", () => {
    expect(parseCallerLine('You: "Hi, I need to move my appointment."')).toEqual({
      line: "Hi, I need to move my appointment.",
      hangsUp: false,
    });
    expect(parseCallerLine("Next Tuesday works.\nAgent: Great, I booked it.")).toEqual({
      line: "Next Tuesday works.",
      hangsUp: false,
    });
  });

  it("hangs up on the marker, with or without a last line", () => {
    expect(parseCallerLine("[hang up]")).toEqual({ line: "", hangsUp: true });
    expect(parseCallerLine("Thanks, bye! [Hangs up]")).toEqual({ line: "Thanks, bye!", hangsUp: true });
  });

  it("is told its goal, what it knows and the language to speak", () => {
    const prompt = callerPrompt({ goal: "Book a follow-up call", knows: "Name Max Mustermann" }, "de");
    expect(prompt).toContain("Your goal for this call: Book a follow-up call");
    expect(prompt).toContain("What you know and can tell the agent when it asks: Name Max Mustermann");
    expect(prompt).toContain("You speak German.");
    expect(prompt).toContain("answer with exactly [hang up]");
  });
});

describe("the judge's verdict", () => {
  it("reads PASS or FAIL with its reason", () => {
    expect(parseVerdict("PASS: The agent booked Tuesday at 10:00 and confirmed it.")).toEqual({
      reached: true,
      reason: "The agent booked Tuesday at 10:00 and confirmed it.",
    });
    expect(parseVerdict("Looking at the call.\n**FAIL** - the booking tool was refused every time.")).toEqual({
      reached: false,
      reason: "the booking tool was refused every time.",
    });
    expect(parseVerdict("FAIL\nNo meeting was booked.")).toEqual({ reached: false, reason: "No meeting was booked." });
  });

  it("does not read a verdict into prose", () => {
    expect(parseVerdict("The caller did not pass on their email, so this fails.")).toBeNull();
  });
});
