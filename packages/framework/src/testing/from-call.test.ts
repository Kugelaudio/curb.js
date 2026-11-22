import { describe, expect, it } from "vitest";
import { judgeAnswer, ran, record, turn } from "../test-fixtures/conversations.js";
import { judgeAgreement } from "./agreement.js";
import { CALLER_FROM_CALL_PROMPT, callerFromCall, replayCall } from "./from-call.js";
import { FINDINGS } from "./judge.js";

const real = {
  ...record(
    [
      turn({ turn: 1, caller: "Hi, it's Jo Real. Where is my order 10422?", reply: "Let me look.", toolCalls: [ran("find_order", { order: "10422" }, "Shipped on 3 March.")] }),
      turn({ turn: 2, caller: "Please send it to 12 Elm Street instead, call me on 0170 5550100.", reply: "I cannot change that." }),
    ],
    { caller: null },
  ),
  id: "call-7",
};

describe("callerFromCall", () => {
  it("asks for a caller who wants what this one wanted, keeping order numbers and inventing personal data", async () => {
    const sent: Array<{ system: string; input: string }> = [];
    const model = async (system: string, input: string) => {
      sent.push({ system, input });
      return 'Sure: {"goal":"Find out where order 10422 is and have it sent to a new address","knows":"Order 10422. Name Sam Example, phone 0151 0000000, address 1 Test Road.","persona":" in a hurry "}';
    };

    expect(await callerFromCall(real, { model })).toEqual({
      goal: "Find out where order 10422 is and have it sent to a new address",
      knows: "Order 10422. Name Sam Example, phone 0151 0000000, address 1 Test Road.",
      persona: "in a hurry",
    });
    expect(sent[0]!.system).toBe(CALLER_FROM_CALL_PROMPT);
    expect(CALLER_FROM_CALL_PROMPT).toContain("Keep every detail the agent's data needs to find what the caller meant, exactly as it was said: order, booking and ticket numbers, product names, dates and times.");
    expect(CALLER_FROM_CALL_PROMPT).toContain("Replace personal data with invented data of the same kind: people's names, phone numbers, email addresses and street addresses. Never copy one of those from the call.");
    // The tool calls are shown too: a number the caller spelled out is in the tool's input.
    expect(sent[0]!.input.split("\n")).toEqual([
      "<<<TRANSCRIPT",
      "[turn 1] Caller: Hi, it's Jo Real. Where is my order 10422?",
      '[turn 1] (The agent called the tool find_order: ok. Input: {"order":"10422"}. Result: Shipped on 3 March.)',
      "[turn 1] Agent: Let me look.",
      "[turn 2] Caller: Please send it to 12 Elm Street instead, call me on 0170 5550100.",
      "[turn 2] Agent: I cannot change that.",
      "TRANSCRIPT>>>",
    ]);
  });

  it("leaves out an empty persona, asks once more for an answer it cannot read, then rejects", async () => {
    let asked = 0;
    const late = async () => (asked++ === 0 ? '{"goal":""}' : '{"goal":"Ask about order 10422","knows":"Order 10422","persona":""}');
    expect(await callerFromCall(real, { model: late })).toEqual({ goal: "Ask about order 10422", knows: "Order 10422" });
    await expect(callerFromCall(real, { model: async () => "no" })).rejects.toThrow('callerFromCall(): the model\'s answer could not be read: "no"');
    await expect(callerFromCall({ ...real, turns: [turn({ turn: 0, caller: null, reply: "Hello." })] }, { model: late })).rejects.toThrow("callerFromCall(): the caller of call-7 said nothing");
  });
});

describe("replayCall", () => {
  it("says the caller's own lines again, one per turn", async () => {
    const caller = replayCall({ ...real, turns: [turn({ turn: 0, caller: null, reply: "Hello." }), ...real.turns] });
    expect(caller.lines).toEqual(["Hi, it's Jo Real. Where is my order 10422?", "Please send it to 12 Elm Street instead, call me on 0170 5550100."]);
    expect(await caller([], { language: "en", hungUp: false })).toBe("Hi, it's Jo Real. Where is my order 10422?");
    expect(() => replayCall({ ...real, turns: [] })).toThrow("replayCall(): the caller of call-7 said nothing to replay.");
  });
});

describe("judgeAgreement", () => {
  const call = (id: string, reply: string) => ({ ...record([turn({ turn: 1, caller: "Is my order here?", reply })], { caller: null }), id });
  const records = [call("a", "What was your order again? Bye! Bye!"), call("b", "Bye! Bye!"), call("c", "It arrives today."), call("d", "Bye! Bye!"), call("e", "Not labelled.")];
  /** A judge that finds incoherent on every "Bye! Bye!" and canned_closing nowhere. */
  const model = Object.assign(
    async (system: string, input: string) => {
      if (input.includes("[turn 1] Caller: Is my order here?") && input.includes("It arrives today") && system.includes("canned_closing")) throw new Error("HTTP 503: overloaded");
      return judgeAnswer({ systemPrompt: system, skillTitle: "", stateSnapshot: [], tools: [], messages: [] }, input.includes("Bye! Bye!") ? { incoherent: { answer: "yes", turn: 1, quote: "Bye! Bye!", reason: "Twice." } } : {});
    },
    { model: "test:judge" },
  );

  it("counts per finding the labelled calls the judge caught and those it flagged that do not have it", async () => {
    const result = await judgeAgreement({
      records,
      labels: { a: { incoherent: true, asked_again: true }, b: { incoherent: true }, c: { incoherent: false }, d: { incoherent: false, asked_again: false } },
      model,
    });

    expect(result).toEqual({
      findings: [
        // a and b have it, and both were caught; d does not, and was flagged.
        { id: "incoherent", withIt: { caught: 2, calls: 2 }, withoutIt: { flagged: 1, calls: 2 }, disagreements: ["d"] },
        // a has it and was missed: the judge needs an earlier turn for asked_again.
        { id: "asked_again", withIt: { caught: 0, calls: 1 }, withoutIt: { flagged: 0, calls: 1 }, disagreements: ["a"] },
      ],
      notJudged: [],
      model: "test:judge",
    });
  });

  it("asks a team's own findings, leaves out a call the judge could not be asked about, and refuses a label it cannot use", async () => {
    const findings = { ...FINDINGS, canned_closing: "The agent ends a reply with a stock line." };
    const result = await judgeAgreement({ records, labels: { b: { canned_closing: true }, c: { canned_closing: false } }, findings, model });
    expect(result.findings).toEqual([{ id: "canned_closing", withIt: { caught: 0, calls: 1 }, withoutIt: { flagged: 0, calls: 0 }, disagreements: ["b"] }]);
    expect(result.notJudged).toEqual([{ record: "c", reason: "HTTP 503: overloaded" }]);

    await expect(judgeAgreement({ records, labels: { z: { incoherent: true } }, model })).rejects.toThrow('judgeAgreement(): no record is named "z". The records are: a, b, c, d, e.');
    await expect(judgeAgreement({ records, labels: { a: { canned_closing: true } }, model })).rejects.toThrow("judgeAgreement(): canned_closing is labelled but not asked.");
    await expect(judgeAgreement({ records, labels: { a: { incoherent: "yes" as unknown as boolean } }, model })).rejects.toThrow("not so for a: incoherent");
  });
});
