import { describe, expect, it } from "vitest";
import { callerPrompt, parseCallerAfterHangUp, parseCallerLine } from "./caller.js";
import { personas } from "./personas.js";

describe("the simulated caller's line", () => {
  it("takes the line as spoken: no role prefix, no quotes, nothing written for the agent", () => {
    expect(parseCallerLine('You: "Hi, I need to move my appointment."')).toEqual({
      line: "Hi, I need to move my appointment.",
      hangsUp: false,
      end: null,
    });
    expect(parseCallerLine("Next Tuesday works.\nAgent: Great, I booked it.")).toEqual({
      line: "Next Tuesday works.",
      hangsUp: false,
      end: null,
    });
  });

  it("hangs up on the marker, with or without a last line, and reads what it says about the goal", () => {
    expect(parseCallerLine("[hang up]")).toEqual({ line: "", hangsUp: true, end: { goalMet: null, reason: "" } });
    expect(parseCallerLine("Thanks, bye! [Hangs up]")).toEqual({
      line: "Thanks, bye!",
      hangsUp: true,
      end: { goalMet: null, reason: "" },
    });
    expect(parseCallerLine("Perfect, thank you. Bye! [hang up: met - the booking was confirmed for ten]")).toEqual({
      line: "Perfect, thank you. Bye!",
      hangsUp: true,
      end: { goalMet: true, reason: "the booking was confirmed for ten" },
    });
    expect(parseCallerLine("[hang up: not met - the agent cannot change orders]").end).toEqual({
      goalMet: false,
      reason: "the agent cannot change orders",
    });
  });

  it("is not ended by the words of a goodbye: only the marker ends the call", () => {
    // A caller that is not done yet can say all of this.
    for (const line of ["That's all for the address, have a great day so far!", "Bye for now, but one more thing.", "Goodbye? No, wait."]) {
      expect(parseCallerLine(line)).toMatchObject({ line, hangsUp: false, end: null });
    }
  });

  it("reads the caller's answer to a call the agent ended: done, or still wanting something", () => {
    expect(parseCallerAfterHangUp("[hang up: met - I got my booking number]")).toEqual({
      done: true,
      end: { goalMet: true, reason: "I got my booking number" },
    });
    expect(parseCallerAfterHangUp("[still wanted: the price of the haircut]")).toEqual({
      done: false,
      wanted: "the price of the haircut",
    });
    expect(parseCallerAfterHangUp("I think it went fine.")).toBeNull();
  });
});

describe("the simulated caller's prompt", () => {
  it("is told its goal, what it knows and the language to speak", () => {
    const prompt = callerPrompt({ goal: "Book a follow-up call", knows: "Name Max Mustermann" }, "de");
    expect(prompt).toContain("Your goal for this call: Book a follow-up call");
    expect(prompt).toContain("Everything you know and can tell the agent: Name Max Mustermann");
    expect(prompt).toContain("You speak German.");
  });

  it("holds every caller to the same contract", () => {
    const prompt = callerPrompt({ goal: "Book a follow-up call" }, "en");
    expect(prompt).toContain("You have no details beyond your goal.");
    // Only the scenario's facts, given as they are needed, and never a made-up one.
    expect(prompt).toContain("Give a detail when it is asked for or needed for your goal, never everything at once.");
    expect(prompt).toContain("Never make up a name, a number, a date, an address or any other fact.");
    expect(prompt).toContain("say you do not have it");
    expect(prompt).toContain("Do not do the agent's job");
    // It ends the call itself, and says whether its goal was met.
    expect(prompt).toContain("Stay on the call until the agent has confirmed that your goal is done, or it is clear that it cannot be done");
    expect(prompt).toContain("[hang up: met - <why>]");
    expect(prompt).toContain("[hang up: not met - <why>]");
  });

  it("adds the persona and one rule per behaviour", () => {
    const plain = callerPrompt({ goal: "Book a haircut" }, "en");
    expect(plain).not.toContain("Who you are:");

    const rushed = callerPrompt({ goal: "Book a haircut", ...personas.rushed }, "en");
    expect(rushed).toContain(`Who you are: ${personas.rushed.persona}`);
    expect(rushed).toContain("- You are in a hurry and say so.");

    const talkative = callerPrompt({ goal: "Book a haircut", behaviours: ["everything_at_once", "changes_mind", "asks_to_repeat"] }, "en");
    expect(talkative).toContain("- In your first line, say everything you know that the agent could need, in one breath.");
    expect(talkative).not.toContain("never everything at once");
    expect(talkative).toContain("change your mind about something your goal leaves open");
    expect(talkative).toContain("ask it to say it again");
  });
});
