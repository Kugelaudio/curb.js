import { describe, expect, it } from "vitest";
import { TurnSpeech } from "./turn-speech.js";

/** Feed `deltas` to a fresh step; returns what was said after each one. */
function stream(speech: TurnSpeech, deltas: string[]): string[] {
  speech.startStep();
  return deltas.map((delta) => speech.text(delta));
}

describe("TurnSpeech", () => {
  it("holds the newest sentence and releases it once the next one starts", () => {
    const speech = new TurnSpeech();
    expect(stream(speech, ["Your claim ", "is open. ", "An adjuster ", "calls tomorrow."])).toEqual([
      "",
      "",
      "Your claim is open. ",
      "",
    ]);
    expect(speech.endStep(true)).toBe("An adjuster calls tomorrow.");
    expect(speech.stepText).toBe("Your claim is open. An adjuster calls tomorrow.");
    expect(speech.reply).toBe("Your claim is open. An adjuster calls tomorrow.");
  });

  it("drops the held sentence of a step that ends in a tool call", () => {
    const speech = new TurnSpeech();
    expect(stream(speech, ["Let me check ", "that for you."])).toEqual(["", ""]);
    expect(speech.endStep(false)).toBe("");
    expect(speech.stepText).toBe("");
    expect(speech.reply).toBe("");
  });

  it("falls silent when a tool call starts: nothing after it is said, the held text is dropped", () => {
    const speech = new TurnSpeech();
    stream(speech, ["Sure. ", "One sec. "]);
    speech.toolInputStart();
    expect(speech.text("Checking now. Done.")).toBe("");
    expect(speech.endStep(false)).toBe("");
    // "Sure." was out before the tool call showed; the transcript records exactly that.
    expect(speech.stepText).toBe("Sure.");
  });

  it("says nothing of a step that calls a tool, end_call included: its goodbye is a line of its own", () => {
    const speech = new TurnSpeech();
    stream(speech, ["The caller is done, so I save the feedback and say goodbye."]);
    speech.toolInputStart();
    speech.toolInputStart();
    expect(speech.endStep(false)).toBe("");
    expect(speech.stepText).toBe("");
    // The session says the goodbye (or a read-back) once the call ran, word for word.
    expect(speech.line("Thanks for your feedback! Goodbye.")).toBe("Thanks for your feedback. Goodbye.");
    expect(speech.stepText).toBe("Thanks for your feedback. Goodbye.");
    expect(speech.reply).toBe("Thanks for your feedback. Goodbye.");
  });

  it("joins the words of two steps with one space", () => {
    const speech = new TurnSpeech();
    speech.startStep();
    expect(speech.wholeStep("Let me pull up the member portal for you.", true)).toBe(
      "Let me pull up the member portal for you.",
    );
    speech.startStep();
    expect(speech.wholeStep("What's your work email?", true)).toBe(" What's your work email?");
    expect(speech.reply).toBe("Let me pull up the member portal for you. What's your work email?");
    expect(speech.stepText).toBe("What's your work email?");
  });

  it("adds no second space after words that already end in one, and none before the first word", () => {
    const speech = new TurnSpeech();
    stream(speech, ["\n\nSure. ", "Let me check."]);
    speech.endStep(false);
    speech.startStep();
    expect(speech.wholeStep("  It is open.", true)).toBe("It is open.");
    expect(speech.reply).toBe("Sure. It is open.");
  });

  it("a fixed line is its own step, joined like any other", () => {
    const speech = new TurnSpeech();
    stream(speech, ["Your claim is open. ", "The adjuster"]);
    expect(speech.line("Sorry, something went wrong on my side.")).toBe("Sorry, something went wrong on my side.");
    expect(speech.reply).toBe("Your claim is open. Sorry, something went wrong on my side.");
  });

  it("a line break ends a sentence too", () => {
    const speech = new TurnSpeech();
    expect(stream(speech, ["Two options:\n", "- the first"])).toEqual(["", "Two options:\n"]);
  });

  it("treats exclamation marks the way every reply is spoken", () => {
    const speech = new TurnSpeech();
    speech.startStep();
    expect(speech.wholeStep("Hi there! Welcome!", true)).toBe("Hi there. Welcome.");
  });

  it("never says a step's opening stage direction, streamed or whole", () => {
    const speech = new TurnSpeech();
    // Held while the bracket is open, so no part of it reaches TTS.
    expect(stream(speech, ["[assistant turned", " their head away] ", "Das tut mir leid. ", "Haben Sie Fieber?"])).toEqual([
      "",
      "",
      "",
      "Das tut mir leid. ",
    ]);
    expect(speech.endStep(true)).toBe("Haben Sie Fieber?");
    expect(speech.stepText).toBe("Das tut mir leid. Haben Sie Fieber?");

    const whole = new TurnSpeech();
    whole.startStep();
    expect(whole.wholeStep("(pauses) [smiles] Sure, one moment.", true)).toBe("Sure, one moment.");
  });

  it("says nothing of a step that is only a stage direction", () => {
    const speech = new TurnSpeech();
    expect(stream(speech, ["[assistant turned their head away]"])).toEqual([""]);
    expect(speech.endStep(true)).toBe("");
    expect(speech.stepText).toBe("");
    expect(speech.reply).toBe("");
  });

  it("says brackets that are not an opening stage direction", () => {
    const said = (text: string) => {
      const speech = new TurnSpeech();
      speech.startStep();
      return speech.wholeStep(text, true);
    };
    // No letter in the group: a number, not narration.
    expect(said("(030) 1234 567 is our number.")).toBe("(030) 1234 567 is our number.");
    expect(said("Your claim (number 4711) is open.")).toBe("Your claim (number 4711) is open.");
    // The framework's own lines are said word for word.
    expect(new TurnSpeech().line("(Recorded) Goodbye.")).toBe("(Recorded) Goodbye.");
  });
});
