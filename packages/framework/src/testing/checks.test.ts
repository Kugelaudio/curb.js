import { describe, expect, it } from "vitest";
import { fallbackReplies } from "../llm/localized.js";
import { builtInChecks, expectContext, fallbackLineIn, repeatedSentences, type Conversation } from "./checks.js";
import type { ScenarioCheck, ScenarioToolCall, ScenarioTurn } from "./scenario.js";

function turn(overrides: Partial<ScenarioTurn> & { turn: number }): ScenarioTurn {
  return {
    caller: `line ${overrides.turn}`,
    reply: "Sure.",
    fallback: null,
    confirmation: null,
    toolCalls: [],
    errors: [],
    contextDiff: [],
    skillPath: "/",
    skipped: false,
    endedCall: false,
    ...overrides,
  };
}

function conversation(turns: ScenarioTurn[], overrides: Partial<Conversation> = {}): Conversation {
  return { turns, endedBy: "script", unsaid: [], maxTurns: turns.length, ...overrides };
}

const refused = (name: string, message: string): ScenarioToolCall => ({
  name,
  input: {},
  ok: false,
  result: { ok: false, message },
});

function failed(checks: ScenarioCheck[]): Array<[string, string | undefined]> {
  return checks.filter((check) => !check.pass).map((check) => [check.name, check.detail]);
}

describe("built-in checks", () => {
  it("pass a clean conversation and say how it ended", () => {
    const checks = builtInChecks(conversation([turn({ turn: 1 }), turn({ turn: 2, endedCall: true })], { endedBy: "agent" }));
    expect(failed(checks)).toEqual([]);
    expect(checks.map((check) => check.name)).toEqual([
      "no turn errors",
      "no empty agent reply",
      "no fallback line instead of a reply",
      "no sentence repeated within a turn",
      "the conversation ends cleanly",
    ]);
    expect(checks[4].detail).toBe("the agent ended the call (end_call) at turn 2");
  });

  it("report a step limit and its refusal loop, and the fixed line the caller heard instead", () => {
    const stepLimit = fallbackReplies("de").stepLimit;
    const looping = turn({
      turn: 2,
      reply: stepLimit,
      fallback: stepLimit,
      toolCalls: [
        refused("book_meeting", "Invalid input for date."),
        refused("book_meeting", "Invalid input for date."),
        refused("book_meeting", "Invalid input for email."),
      ],
      errors: [{ kind: "step_limit", message: "The turn used all 8 LLM steps (maxSteps)." }],
    });
    const checks = builtInChecks(
      conversation([turn({ turn: 1 }), looping], { endedBy: "error", stopReason: "step_limit: The turn used all 8 LLM steps (maxSteps)." }),
    );

    expect(failed(checks)).toEqual([
      [
        "no turn errors",
        "turn 2: step_limit: The turn used all 8 LLM steps (maxSteps).\nturn 2: book_meeting was refused 3 times, last with: Invalid input for email.",
      ],
      ["no fallback line instead of a reply", `turn 2: the caller heard the fixed line "${stepLimit}"`],
      ["the conversation ends cleanly", "the conversation stopped at turn 2: step_limit: The turn used all 8 LLM steps (maxSteps)."],
    ]);
  });

  it("never count a call held for the caller's yes as a refusal", () => {
    const held: ScenarioToolCall = {
      name: "book_meeting",
      input: { date: "2026-10-27" },
      ok: false,
      result: { ok: false, message: "Held, not run: ask the caller first." },
      heldFor: "I'll book Tuesday the 27th, is that right?",
    };
    const checks = builtInChecks(conversation([turn({ turn: 1, toolCalls: [held, held, held] })]));
    expect(failed(checks)).toEqual([]);
  });

  it("never flag a turn the agent skipped on purpose", () => {
    const checks = builtInChecks(
      conversation([turn({ turn: 1, reply: "", skipped: true }), turn({ turn: 2, reply: "Take care.", endedCall: true })], {
        endedBy: "agent",
      }),
    );
    expect(failed(checks)).toEqual([]);
  });

  it("flag a turn the model answered with nothing, under the empty-reply check only", () => {
    const { turnFailed } = fallbackReplies("en");
    const empty = "The model answered with no text and no tool call, twice in a row.";
    const checks = builtInChecks(
      conversation([turn({ turn: 1, reply: turnFailed, fallback: turnFailed, errors: [{ kind: "empty_reply", message: empty }] })], {
        endedBy: "error",
        stopReason: `empty_reply: ${empty}`,
      }),
    );
    expect(failed(checks)).toEqual([
      ["no empty agent reply", `turn 1: the agent said nothing (${empty})`],
      ["no fallback line instead of a reply", `turn 1: the caller heard the fixed line "${turnFailed}"`],
      ["the conversation ends cleanly", `the conversation stopped at turn 1: empty_reply: ${empty}`],
    ]);
  });

  it("flag a sentence said twice in one turn, and a hang-up before the script was done", () => {
    const checks = builtInChecks(
      conversation([turn({ turn: 1, reply: "Sure. Sure! Your policy covers storm damage.", endedCall: true })], {
        endedBy: "agent",
        unsaid: ["And hail?"],
      }),
    );
    expect(failed(checks)).toEqual([
      ["no sentence repeated within a turn", 'turn 1 says "Sure." more than once'],
      ["the conversation ends cleanly", 'the agent hung up at turn 1 with 1 scripted caller line(s) never said: "And hail?"'],
    ]);
  });
});

describe("repeatedSentences", () => {
  it("compares sentences ignoring case, punctuation and spacing", () => {
    expect(repeatedSentences("Alles klar. Ihr Termin steht. alles klar!")).toEqual(["Alles klar."]);
    expect(repeatedSentences("Ja. Nein. Vielleicht.")).toEqual([]);
    expect(repeatedSentences("")).toEqual([]);
  });
});

describe("fallbackLineIn", () => {
  it("finds the fixed line at the end of what the caller heard, in any language", () => {
    const { turnFailed } = fallbackReplies("fr");
    expect(fallbackLineIn(`Un instant. ${turnFailed}`)).toBe(turnFailed);
    expect(fallbackLineIn("Your claim is filed.")).toBeNull();
  });
});

describe("expect helpers", () => {
  const booked: ScenarioToolCall = {
    name: "book_meeting",
    input: { email: "Max@Example.com ", date: "2026-10-27" },
    ok: true,
    result: { ok: true },
  };
  const turns = [
    turn({ turn: 1, reply: "Gern. Wie ist Ihre E-Mail?", toolCalls: [refused("send_email", "No address yet.")] }),
    turn({ turn: 2, reply: "Ich habe Sie für Dienstag eingetragen.", toolCalls: [booked], endedCall: true }),
  ];
  const { called, notCalled, said, endedCall, check, transcript } = expectContext(turns);

  it("called: a run without a refusal, optionally with matching input", () => {
    expect(called("book_meeting")).toEqual({ name: "called book_meeting", pass: true, detail: `turn 2: ${JSON.stringify(booked.input)}` });
    expect(called("book_meeting", { email: "max@example.com" }).pass).toBe(true);
    expect(called("book_meeting", { date: "2026-10-28" })).toMatchObject({
      pass: false,
      detail: `book_meeting ran only with ${JSON.stringify(booked.input)} (turn 2)`,
    });
    expect(called("send_email")).toMatchObject({ pass: false, detail: "send_email never ran: turn 1 refused: No address yet." });
    expect(called("cancel_meeting")).toMatchObject({
      pass: false,
      detail: "cancel_meeting was never called; tools that ran: book_meeting",
    });
  });

  it("called: a RegExp value is tested against the field's text, beside plain values", () => {
    const claim: ScenarioToolCall = {
      name: "create_claim",
      input: { date: "2026-10-27", seats: 2, damage: "Hagel am Dach" },
      ok: true,
      result: { ok: true },
    };
    const { called: calledClaim } = expectContext([turn({ turn: 1, toolCalls: [claim] })]);

    expect(calledClaim("create_claim", { date: /^2026-10-\d{2}$/, damage: "hagel am dach" })).toEqual({
      name: 'called create_claim with {"date":/^2026-10-\\d{2}$/,"damage":"hagel am dach"}',
      pass: true,
      detail: `turn 1: ${JSON.stringify(claim.input)}`,
    });
    // A field that is no string is matched as its JSON; a global pattern matches every time.
    expect(calledClaim("create_claim", { seats: /^2$/ }).pass).toBe(true);
    const global = /hagel/gi;
    expect([calledClaim("create_claim", { damage: global }).pass, calledClaim("create_claim", { damage: global }).pass]).toEqual([
      true,
      true,
    ]);
    expect(calledClaim("create_claim", { date: /^2026-11/ })).toMatchObject({
      pass: false,
      detail: `create_claim ran only with ${JSON.stringify(claim.input)} (turn 1)`,
    });
    // A field the call does not have never matches, not even a pattern that matches anything.
    expect(calledClaim("create_claim", { policy: /.*/ }).pass).toBe(false);
  });

  it("notCalled, said, endedCall and check", () => {
    expect(notCalled("send_email").pass).toBe(true);
    expect(notCalled("book_meeting")).toMatchObject({ pass: false, detail: `book_meeting ran turn 2 with ${JSON.stringify(booked.input)}` });
    expect(said("dienstag")).toEqual({ name: 'said "dienstag"', pass: true, detail: "turn 2" });
    expect(said(/montag/i)).toEqual({ name: "said /montag/i", pass: false, detail: "no agent reply says it" });
    expect(endedCall()).toEqual({ name: "the agent ended the call", pass: true, detail: "turn 2" });
    expect(check("two turns", transcript.length === 2)).toEqual({ name: "two turns", pass: true });
    expect(check("three turns", false, "it took two")).toEqual({ name: "three turns", pass: false, detail: "it took two" });
  });
});
