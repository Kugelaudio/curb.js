import { describe, expect, it } from "vitest";
import type { AgentLlmClient } from "../../agent-session.js";
import { judge, ran, record, turn } from "../../test-fixtures/conversations.js";
import { modelOn } from "../../testing/model.js";
import type { ConversationRecord } from "../../testing/record.js";
import { assessConversation, type AssessmentSettings } from "./assess.js";

const NONE: AssessmentSettings = { expectations: [], failOn: [] };
const unused: AgentLlmClient = async () => {
  throw new Error("the judge is not asked in this test");
};

const assess = (conversation: ConversationRecord, judgeLlm: AgentLlmClient = judge(), settings: AssessmentSettings = NONE) =>
  assessConversation({ record: conversation, settings, judge: modelOn(judgeLlm, "openai:gpt-5.4-mini") });

const booked = [
  turn({ turn: 1, caller: "Hi, I'd like a haircut.", reply: "Sure. What is your name?" }),
  turn({ turn: 2, caller: "Alex Example.", reply: "You are booked, Alex.", toolCalls: [ran("book_appointment", { name: "Alex Example" })] }),
];
const failed = (assessment: Awaited<ReturnType<typeof assess>>) => assessment.checks.filter((check) => !check.pass).map((check) => check.name);

describe("pass, fail or error", () => {
  it("passes a conversation whose checks pass, with the judge's evidence on the goal", async () => {
    const assessment = await assess(record(booked), judge({ goal: { answer: "yes", turn: 2, quote: "You are booked, Alex", reason: "The booking ran." } }));
    expect(assessment.outcome).toBe("pass");
    expect(assessment.error).toBeUndefined();
    expect(assessment.checks.map((check) => check.name)).toEqual([
      "no turn errors",
      "no empty agent reply",
      "no fallback line instead of a reply",
      "no sentence repeated within a turn",
      "the conversation ends cleanly",
      "the agent does not hang up on a caller who still wants something",
      "the caller reaches its goal",
    ]);
    expect(assessment.checks.at(-1)).toEqual({
      name: "the caller reaches its goal",
      pass: true,
      detail: "The booking ran.",
      evidence: { answer: "yes", turn: 2, quote: "You are booked, Alex" },
    });
    expect(assessment.judge).toMatchObject({ promptVersion: "4", model: "openai:gpt-5.4-mini" });
  });

  it("fails when the judge says the goal was not reached, or cannot tell", async () => {
    const no = await assess(record(booked), judge({ goal: "no" }));
    expect([no.outcome, failed(no)]).toEqual(["fail", ["the caller reaches its goal"]]);
    const unknown = await assess(record(booked), judge({ goal: "unknown" }));
    expect(unknown.outcome).toBe("fail");
    expect(unknown.checks.at(-1)?.detail).toBe("unknown: goal: unknown");
  });

  it("is an error, not a failure, when the agent's provider failed after the retries", async () => {
    const broken = [turn({ turn: 1, reply: "Sorry, something went wrong.", fallback: "Sorry, something went wrong.", errors: [{ kind: "failed", message: "HTTP 529: overloaded" }] })];
    const assessment = await assess(record(broken, { ending: { by: "error", reason: "failed: HTTP 529: overloaded", providerError: true, caller: null } }), unused);
    expect(assessment.outcome).toBe("error");
    expect(assessment.error).toEqual({ kind: "provider", message: "the agent's LLM provider failed, after the retries: failed: HTTP 529: overloaded" });
    // The checks still say what the caller got; the run just does not count against the agent.
    expect(failed(assessment)).toEqual(["no turn errors", "no fallback line instead of a reply", "the conversation ends cleanly", "the caller reaches its goal"]);
  });

  it("fails a turn error that is the agent's own: a step limit is not the provider's fault", async () => {
    const looping = [turn({ turn: 1, reply: "", errors: [{ kind: "step_limit", message: "The turn used all 8 LLM steps (maxSteps)." }] })];
    const assessment = await assess(record(looping, { ending: { by: "error", reason: "step_limit: The turn used all 8 LLM steps (maxSteps).", caller: null } }), unused);
    expect(assessment.outcome).toBe("fail");
    expect(assessment.checks.at(-1)).toEqual({
      name: "the caller reaches its goal",
      pass: false,
      detail: "not judged: the conversation broke off before it ended",
      notJudged: true,
    });
  });

  it("is an error when the simulated caller could not go on", async () => {
    const assessment = await assess(record([], { ending: { by: "simulator", reason: "HTTP 401: invalid x-api-key", caller: null } }), unused);
    expect(assessment).toMatchObject({ outcome: "error", error: { kind: "simulator", message: "the simulated caller could not go on: HTTP 401: invalid x-api-key" } });
  });

  it("is an error when the caller says a fact it was never given", async () => {
    const invented = [
      turn({ turn: 1, caller: "Hi, I'd like a haircut.", reply: "Sure. What is your email?" }),
      turn({ turn: 2, caller: "It's alex@example.com.", reply: "Thanks." }),
    ];
    const assessment = await assess(record(invented), unused);
    expect(assessment.outcome).toBe("error");
    expect(assessment.error).toEqual({
      kind: "invented_fact",
      message: 'turn 2: the simulated caller said "alex@example.com", which is not in caller.knows. Add it to caller.knows if the caller should know it; otherwise the caller made it up.',
    });
  });

  it("holds a caller without knows to its goal, and never asks scripted lines where they got a fact", async () => {
    const lines = [turn({ turn: 1, caller: "Where is my order NW-1002? Mail me at sam@example.com.", reply: "It has shipped." })];
    // The order is in the goal; the address is nowhere.
    const simulated = await assess(record(lines, { caller: { goal: "Find out where order NW-1002 is" } }), unused);
    expect(simulated.error).toEqual({
      kind: "invented_fact",
      message:
        'turn 1: the simulated caller said "sam@example.com", and the scenario gives its caller no knows. Add it to caller.knows if the caller should know it; otherwise the caller made it up.',
    });
    const inGoal = [turn({ turn: 1, caller: "Where is my order NW-1002?", reply: "It has shipped." })];
    expect((await assess(record(inGoal, { caller: { goal: "Find out where order NW-1002 is" } }))).outcome).toBe("pass");
    // Scripted lines are the author's words: nothing in them is the simulator's invention.
    const scripted = await assess(record(lines, { caller: null, ending: { by: "script", caller: null } }), unused);
    expect(scripted).toMatchObject({ outcome: "pass", judge: null });
  });

  it("hands the tools the conversation recorded to the judge", async () => {
    const asked = judge();
    await assess(record(booked, { tools: [{ name: "book_appointment", description: "Book a slot." }] }), asked);
    expect(asked.requests[0]?.stateSnapshot).toEqual(expect.arrayContaining(["<<<TOOLS", "- book_appointment: Book a slot.", "TOOLS>>>"]));
    // A record saved without them is judged all the same.
    const older = judge();
    expect((await assess(record(booked), older)).outcome).toBe("pass");
    expect(older.requests[0]?.stateSnapshot).toContain("(The agent's tools were not recorded for this call.)");
  });

  it("lets the caller say what it knows, however it is spaced, and what the agent said first", async () => {
    const fine = [
      turn({ turn: 1, caller: "It's Alex Example, 0151-234 5678.", reply: "Thanks. Your booking number is B-4711 and the reference is KV-123." }),
      turn({ turn: 2, caller: "KV 123 and B-4711, got it. See you at 10 on the 5th.", reply: "See you then." }),
    ];
    expect((await assess(record(fine))).outcome).toBe("pass");
    for (const [line, fact] of [["My policy is KV-998.", "KV-998"], ["Call me on 0170 9999999.", "0170 9999999"]] as const) {
      const madeUp = [turn({ turn: 1, caller: line, reply: "Thanks." })];
      expect((await assess(record(madeUp), unused)).error?.message).toContain(`the simulated caller said "${fact}"`);
    }
  });

  it("is an error when the caller is stuck on one line while the agent moves on, and the agent's own loop is not", async () => {
    const stuck = [
      turn({ turn: 1, caller: "A haircut, please.", reply: "Which day?" }),
      turn({ turn: 2, caller: "A haircut, please!", reply: "Sure. Which day would you like?" }),
      turn({ turn: 3, caller: "a haircut please", reply: "I can do any weekday. Which one?" }),
    ];
    expect(await assess(record(stuck), unused)).toMatchObject({
      outcome: "error",
      error: { kind: "simulator_loop", message: 'the simulated caller said "A haircut, please." 3 times in a row from turn 1, while the agent\'s replies moved on.' },
    });

    const agentLoop = stuck.map((entry) => ({ ...entry, reply: "Which day?" }));
    const assessment = await assess(record(agentLoop), judge({ goal: "no", incoherent: { answer: "yes", turn: 2, quote: "Which day?", reason: "It asks the same thing again." } }));
    expect(assessment.outcome).toBe("fail");
  });

  it("is an error when the judge cannot be read, and the goal is not judged", async () => {
    const garbled: AgentLlmClient = async () => ({ text: "I think it went fine overall.", toolCalls: [] });
    const assessment = await assess(record(booked), garbled);
    expect(assessment).toMatchObject({ outcome: "error", error: { kind: "judge" }, judge: null });
    expect(assessment.checks.at(-1)).toEqual({
      name: "the caller reaches its goal",
      pass: false,
      detail: 'not judged: the judge\'s answer could not be read: "I think it went fine overall."',
      notJudged: true,
    });
  });

  it("asks the judge once more after a timeout, and gives up on any other failure at once", async () => {
    const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    let asked = 0;
    const slowOnce: AgentLlmClient = async (request) => {
      asked += 1;
      if (asked === 1) throw timeout();
      return judge()(request);
    };
    expect((await assess(record(booked), slowOnce)).outcome).toBe("pass");
    expect(asked).toBe(2);

    asked = 0;
    const slow: AgentLlmClient = async () => {
      asked += 1;
      throw timeout();
    };
    const gaveUp = await assess(record(booked), slow, { expectations: ["The agent books a haircut."], failOn: [] });
    expect(asked).toBe(2);
    expect(gaveUp).toMatchObject({ outcome: "error", error: { kind: "judge", message: "The operation was aborted due to timeout" } });
    // Neither the goal nor the expectation was put to the run: they are not judged, not failed.
    expect(gaveUp.checks.slice(-2).map((check) => [check.name, check.pass, check.notJudged, check.detail])).toEqual([
      ["the caller reaches its goal", false, true, "not judged: The operation was aborted due to timeout"],
      ["expectation: The agent books a haircut.", false, true, "not judged: The operation was aborted due to timeout"],
    ]);

    asked = 0;
    const refused: AgentLlmClient = async () => {
      asked += 1;
      throw new Error("HTTP 401: invalid key");
    };
    expect((await assess(record(booked), refused)).error).toEqual({ kind: "judge", message: "HTTP 401: invalid key" });
    expect(asked).toBe(1);
  });

  it("passes at the turn limit when the goal was reached, as it always has", async () => {
    const assessment = await assess(record(booked, { ending: { by: "max_turns", maxTurns: 2, caller: null } }));
    expect(assessment.outcome).toBe("pass");
    expect(assessment.checks.find((check) => check.name === "the conversation ends cleanly")?.detail).toBe("maxTurns (2) was reached before anyone hung up");
  });

  it("is an error at the turn limit when the goal was not reached and nothing shows the agent caused it", async () => {
    const cutOff = record(booked, { ending: { by: "max_turns", maxTurns: 2, caller: null } });
    const assessment = await assess(cutOff, judge({ goal: "no" }));
    expect(assessment).toMatchObject({ outcome: "error", error: { kind: "max_turns" } });
    expect(assessment.error?.message).toContain("Raise maxTurns, or give the caller a goal it reaches sooner.");

    // A finding of the judge's says the agent had a part in it: that is a failure.
    const atFault = await assess(cutOff, judge({ goal: "no", ignored_caller: { answer: "yes", turn: 1, quote: "What is your name?", reason: "The caller asked for a haircut, not to give a name." } }));
    expect(atFault.outcome).toBe("fail");
    // And so does any other check that failed.
    const withExpect: AssessmentSettings = { ...NONE, expect: ({ called }) => [called("cancel_appointment")] };
    expect((await assess(cutOff, judge({ goal: "no" }), withExpect)).outcome).toBe("fail");
  });
});

describe("who ended the call", () => {
  const hangUp = "the agent does not hang up on a caller who still wants something";
  const ended = [
    turn({ turn: 1, caller: "Hi, I'd like a haircut.", reply: "Sure." }),
    turn({ turn: 2, caller: "That's all for the name, have a great day so far, bye for now!", reply: "Goodbye.", endedCall: true }),
  ];
  const check = async (conversation: ConversationRecord) => (await assess(conversation)).checks.find((entry) => entry.name === hangUp);

  it("fails when the agent hung up and the caller says it still wanted something, whatever words were said", async () => {
    const wanted = record(ended, { ending: { by: "agent", caller: { done: false, goalMet: null, reason: "the price of the haircut" } } });
    expect(await check(wanted)).toEqual({ name: hangUp, pass: false, detail: "the agent ended the call at turn 2 while the caller still wanted: the price of the haircut" });
  });

  it("passes when the caller was done, even though it never said goodbye", async () => {
    const done = [turn({ turn: 1, caller: "Okay.", reply: "You are booked. Goodbye.", endedCall: true })];
    expect(await check(record(done, { ending: { by: "agent", caller: { done: true, goalMet: true, reason: "booked" } } }))).toEqual({
      name: hangUp,
      pass: true,
      detail: "the agent ended the call at turn 1, and the caller was done",
    });
  });

  it("passes when the caller did not say, and when the agent did not end the call", async () => {
    expect(await check(record(ended, { ending: { by: "agent", caller: null } }))).toMatchObject({
      pass: true,
      detail: "the agent ended the call at turn 2; the caller did not say whether it was done",
    });
    expect(await check(record(booked))).toMatchObject({ pass: true, detail: "the agent did not end the call" });
  });

  it("is not asked of a scripted conversation, whose unsaid lines already say it", async () => {
    const scripted = record(ended, { caller: null, ending: { by: "agent", unsaid: ["And what does it cost?"], caller: null } });
    const assessment = await assess(scripted, unused);
    expect(assessment.checks.map((entry) => entry.name)).not.toContain(hangUp);
    expect(failed(assessment)).toEqual(["the conversation ends cleanly"]);
  });

  it("notes when the caller and the judge disagree about the goal", async () => {
    const assessment = await assess(record(booked, { ending: { caller: { done: true, goalMet: true, reason: "booked" } } }), judge({ goal: "no" }));
    expect(assessment.notes).toContain("the caller said its goal was met, and the judge says it was not reached");
  });
});

describe("the author's expectations and the judge's findings", () => {
  const settings: AssessmentSettings = {
    expectations: ["The agent reads the booking number back.", "The agent asks for the caller's name once."],
    failOn: [],
  };

  it("judges each expectation: a no fails the run, an unknown is shown and fails nothing", async () => {
    const assessment = await assess(
      record(booked),
      judge({ expectation_1: { answer: "no", reason: "No booking number was said." }, expectation_2: "unknown" }),
      settings,
    );
    expect(assessment.outcome).toBe("fail");
    expect(assessment.checks.slice(-2)).toEqual([
      {
        name: "expectation: The agent reads the booking number back.",
        pass: false,
        detail: "No booking number was said.",
        evidence: { answer: "no", turn: null, quote: null },
      },
      {
        name: "expectation: The agent asks for the caller's name once.",
        pass: true,
        detail: "unknown: expectation_2: unknown",
        evidence: { answer: "unknown", turn: null, quote: null },
      },
    ]);
    expect(assessment.notes).toEqual([]);
  });

  it("judges a scripted conversation that has expectations, and no other", async () => {
    const scripted = record(booked, { caller: null, ending: { by: "script", caller: null } });
    const asked = judge({ expectation_1: "yes", expectation_2: "yes" });
    const assessment = await assess(scripted, asked, settings);
    expect(assessment.outcome).toBe("pass");
    expect(asked.requests).toHaveLength(1);
    // No simulated caller, so no goal is asked for.
    expect(asked.requests[0]?.systemPrompt).not.toContain("- goal:");
    expect((await assess(scripted, unused)).judge).toBeNull();
  });

  it("reports the built-in findings without failing the run, unless the scenario says failOn", async () => {
    const found = { claimed_without_tool: { answer: "yes" as const, turn: 2, quote: "You are booked, Alex", reason: "It says booked before the tool answered." } };
    const reported = await assess(record(booked), judge(found));
    expect(reported.outcome).toBe("pass");
    expect(reported.judge?.answers.find((answer) => answer.id === "claimed_without_tool")).toMatchObject({ answer: "yes", turn: 2 });

    const strict = await assess(record(booked), judge(found), { expectations: [], failOn: ["claimed_without_tool", "asked_again"] });
    expect(strict.outcome).toBe("fail");
    expect(strict.checks.slice(-2).map((entry) => [entry.name, entry.pass])).toEqual([
      ["no judge finding: claimed_without_tool", false],
      ["no judge finding: asked_again", true],
    ]);
  });

  it("notes a fake no call used and a scenario without checks of its own", async () => {
    const assessment = await assess(record(booked, { unusedFakes: ["send_sms"] }));
    expect(assessment.notes).toEqual([
      "the fake for send_sms was never used: no call of send_sms ran",
      "this scenario has no checks of its own (expect), so only the built-in checks ran",
    ]);
  });
});
