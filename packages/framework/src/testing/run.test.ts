import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { fallbackReplies } from "../llm/localized.js";
import type { AgentRunRequest, AgentRunResponse } from "../llm/types.js";
import { createAgentSession } from "../server/bootstrap.js";
import { LISA, bookingRuntime, booked, callsBook, readBackOf, says, scripted, scriptedStream, type Booking } from "../test-fixtures/booking.js";
import { END_CALL_TOOL_NAME, type ToolResult } from "../types.js";
import { experimentDeclarations } from "../experiments.js";
import { assignExperiments } from "../experiments.node.js";
import { isJudgeRequest, judge } from "../test-fixtures/conversations.js";
import { addTask, calls, hangUp, says as taskSays, sendSummary, steps, tasksBundle } from "../test-fixtures/tasks.js";
import { RunSlots, plannedRuns, runScenario, runVariants, scenarioSessionId, scenarioVariants, type ScenarioResult } from "./run.js";
import { scenario, type ScenarioCheck, type ScenarioDefinition } from "./scenario.js";

/** The fixture project's agent (AGENT_PROJECT_DIR in vitest.config.ts) on `llm`. */
async function fixtureBundle(llm: AgentLlmClient) {
  const { runtime, session } = await createAgentSession(llm, undefined, undefined, { spokenStyleSuffix: "## Voice" });
  return { runtime, session };
}

async function run(definition: ScenarioDefinition, agent: AgentLlmClient, simulator: AgentLlmClient) {
  return runScenario({
    scenario: scenario(definition),
    name: "test",
    file: "src/agent/test.scenario.ts",
    bundle: await fixtureBundle(agent),
    simulator,
  });
}

const reply = (text: string): AgentLlmClient => async () => ({ text, toolCalls: [] });
const unused: AgentLlmClient = async () => {
  throw new Error("this LLM is not called in this test");
};

function failures(result: ScenarioResult): Array<[string, string | undefined]> {
  return result.checks.filter((check) => !check.pass).map((check) => [check.name, check.detail]);
}

/**
 * A scripted scenario on the booking agent (`test-fixtures/booking.tsx`): one skill with
 * `book_meeting`, which asks the caller first. `steps` are the agent's LLM steps, `verdicts` the
 * confirmation check's answers. Returns the result, the real `onSubmit`, and how often `fake`
 * (when given) had run after each turn.
 */
async function runBooking(params: {
  definition: ScenarioDefinition;
  steps: AgentRunResponse[];
  verdicts?: string[];
  fake?: { mock: { calls: unknown[] } };
}) {
  const onSubmit = vi.fn(async (input: Booking) => booked(input));
  const { runtime } = bookingRuntime(onSubmit);
  const { llm } = scripted(params.steps, params.verdicts);
  const fakeRunsAfterTurn: number[] = [];
  const result = await runScenario({
    scenario: scenario(params.definition),
    name: "booking",
    file: "src/agent/booking.scenario.ts",
    bundle: { runtime, session: new AgentSession(runtime, llm) },
    simulator: unused,
    onTurn: () => fakeRunsAfterTurn.push(params.fake?.mock.calls.length ?? 0),
  });
  return { result, onSubmit, fakeRunsAfterTurn };
}

const BOOK_LINE = "Tuesday 15:00, lisa@example.com.";

describe("runScenario", () => {
  it("stops at a failed turn: later lines are never said, and the caller heard the apology", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const agent: AgentLlmClient = async () => {
      calls += 1;
      if (calls === 2) throw new Error("529 overloaded");
      return { text: "Happy to help.", toolCalls: [] };
    };

    const result = await run({ turns: ["Hi", "What does my policy cover?", "Thanks"] }, agent, unused);

    const { turnFailed } = fallbackReplies("en");
    expect(result.endedBy).toBe("error");
    expect(result.turns.map((turn) => [turn.caller, turn.reply, turn.fallback])).toEqual([
      ["Hi", "Happy to help.", null],
      ["What does my policy cover?", turnFailed, turnFailed],
    ]);
    expect(failures(result)).toEqual([
      ["no turn errors", "turn 2: failed: 529 overloaded"],
      ["no fallback line instead of a reply", `turn 2: the caller heard the fixed line "${turnFailed}"`],
      ["the conversation ends cleanly", "the conversation stopped at turn 2: failed: 529 overloaded"],
    ]);
    vi.restoreAllMocks();
  });

  it("fails without judging when the simulated caller cannot say a line", async () => {
    const simulator: AgentLlmClient = async () => {
      throw new Error("401 invalid x-api-key");
    };

    const result = await run({ caller: { goal: "Ask about storm damage" } }, unused, simulator);

    expect(result).toMatchObject({ mode: "simulated", endedBy: "simulator", passed: false, turns: [] });
    expect(failures(result)).toEqual([
      ["the conversation ends cleanly", "the simulated caller could not go on: 401 invalid x-api-key"],
      ["the caller reaches its goal", "not judged: the conversation broke off before it ended"],
    ]);
  });

  it("fails the goal when the judge's answer cannot be read, and stops at maxTurns", async () => {
    const simulator: AgentLlmClient = async (request) =>
      request.systemPrompt.startsWith("You review")
        ? { text: "I think it went fine overall.", toolCalls: [] }
        : { text: "Does it cover hail?", toolCalls: [] };

    const result = await run({ caller: { goal: "Ask about hail" }, maxTurns: 2 }, reply("Yes, hail is covered."), simulator);

    expect(result.endedBy).toBe("max_turns");
    expect(result.turns).toHaveLength(2);
    expect(failures(result)).toEqual([
      ["the caller reaches its goal", 'not judged: the judge\'s answer could not be read: "I think it went fine overall."'],
    ]);
    expect(result.checks.find((check) => check.name === "the conversation ends cleanly")?.detail).toBe(
      "maxTurns (2) was reached before anyone hung up",
    );
  });

  it("turns a throwing or malformed expect into failed checks that say so", async () => {
    const agent = reply("Happy to help.");
    const throwing = await run({ turns: ["Hi"], expect: () => { throw new Error("db unreachable"); } }, agent, unused);
    expect(failures(throwing)).toEqual([["expect", "expect threw: db unreachable"]]);

    const notAList = await run({ turns: ["Hi"], expect: (() => true) as unknown as ScenarioDefinition["expect"] }, agent, unused);
    expect(failures(notAList)).toEqual([
      ["expect", 'expect must return a list of checks, e.g. [called("book_meeting")]; it returned true.'],
    ]);

    const notACheck = false as unknown as ScenarioCheck;
    const mixed = await run({ turns: ["Hi"], expect: ({ said }) => [said("happy"), notACheck] }, agent, unused);
    expect(failures(mixed)).toEqual([
      [
        "expect, entry 2",
        'false is not a check. Return checks such as called("book_meeting"), said("Tuesday") or check("what must hold", condition).',
      ],
    ]);
  });
});

describe("experiment variants", () => {
  const experiments = experimentDeclarations({
    greeting: { variants: { formal: 1, casual: 1 }, fromClient: "greeting" },
    pacing: { variants: { slow: 1, fast: 1 } },
  });

  it("puts each variant on the call before the agent opens: the scenario's pin, the page's pick, else a draw", async () => {
    let seenAtOpening: Readonly<Record<string, unknown>> | undefined;
    const bundle = await fixtureBundle(async (request) => {
      seenAtOpening ??= { ...bundleRuntime!.info.snapshot() };
      return { text: request.messages.length > 0 ? "Hallo." : "Guten Tag.", toolCalls: [] };
    });
    const bundleRuntime = bundle.runtime;
    await runScenario({
      scenario: scenario({ turns: ["Hi"], client: { greeting: "formal" }, experiments: { pacing: "fast" } }),
      name: "variants",
      file: "src/agent/variants.scenario.ts",
      bundle: { ...bundle, experiments },
      simulator: unused,
    });
    expect(seenAtOpening).toMatchObject({ "experiment.greeting": "formal", "experiment.pacing": "fast" });
  });

  it("gives every experiment it does not pin the variant its file and name draw, the same on every run", () => {
    const id = { file: "src/agent/greeting.scenario.ts", name: "greeting" };
    const variants = scenarioVariants(id, experiments, scenario({ turns: ["Hi"] }));
    // The platform's rule over the session id scenario:<file>:<name>.
    expect(scenarioSessionId(id.file, id.name)).toBe("scenario:src/agent/greeting.scenario.ts:greeting");
    expect(variants).toEqual(assignExperiments(experiments, "scenario:src/agent/greeting.scenario.ts:greeting"));
    for (let run = 0; run < 5; run += 1) {
      expect(scenarioVariants(id, experiments, scenario({ turns: ["Hi"] }))).toEqual(variants);
    }
    // Another scenario has a seed of its own.
    const other = { file: "src/agent/greeting.scenario.ts", name: "casual" };
    expect(scenarioVariants(other, experiments, scenario({ turns: ["Hi"] }))).toEqual(
      assignExperiments(experiments, scenarioSessionId(other.file, other.name)),
    );
  });

  it("puts the same variants on the call every time the scenario runs", async () => {
    const seen: unknown[] = [];
    for (let run = 0; run < 3; run += 1) {
      const bundle = await fixtureBundle(reply("Hallo."));
      await runScenario({
        scenario: scenario({ turns: ["Hi"] }),
        name: "repeat",
        file: "src/agent/repeat.scenario.ts",
        bundle: { ...bundle, experiments },
        simulator: unused,
      });
      const info = bundle.runtime.info.snapshot();
      seen.push([info["experiment.greeting"], info["experiment.pacing"]]);
    }
    expect(new Set(seen.map((variants) => JSON.stringify(variants))).size).toBe(1);
  });

  it("refuses a pin of an experiment or a variant the agent does not declare, naming what it does", () => {
    const id = { file: "src/agent/pins.scenario.ts", name: "pins" };
    expect(() =>
      scenarioVariants(id, experiments, scenario({ turns: ["Hi"], experiments: { tone: "warm", greeting: "loud" } })),
    ).toThrow(
      'scenario "pins": experiments.tone: the agent declares no such experiment (it declares "greeting", "pacing"). ' +
        'experiments.greeting: "loud" is not one of its variants ("casual", "formal").',
    );
    expect(() =>
      scenarioVariants({ ...id, name: "none" }, [], scenario({ turns: ["Hi"], experiments: { tone: "warm" } })),
    ).toThrow("it declares none");
  });
});

describe("fakes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a faked confirm tool still waits for the caller's yes, then runs the fake on the validated input, never onSubmit", async () => {
    const fake = vi.fn(async (): Promise<ToolResult> => ({ ok: true, message: "Booked (fake)." }));
    // The model's input carries a field the tool does not take; its form drops it.
    const sent = { ...LISA, note: "window seat" };
    const { result, onSubmit, fakeRunsAfterTurn } = await runBooking({
      definition: {
        turns: [BOOK_LINE, "Ja, genau."],
        fakes: { book_meeting: fake },
        expect: ({ called }) => [called("book_meeting", { email: /@example\.com$/ })],
      },
      steps: [callsBook(sent as Booking), says("Done, see you on Tuesday.")],
      verdicts: ["yes"],
      fake,
    });

    expect(onSubmit).not.toHaveBeenCalled();
    // Not on the model's call: only once the caller said yes.
    expect(fakeRunsAfterTurn).toEqual([0, 1]);
    expect(fake).toHaveBeenCalledWith(LISA);
    expect(result.turns.map((turn) => [turn.caller, turn.confirmation, turn.toolCalls])).toEqual([
      [
        BOOK_LINE,
        null,
        [
          {
            name: "book_meeting",
            input: sent,
            ok: false,
            result: expect.objectContaining({ ok: false }),
            heldFor: readBackOf(LISA),
          },
        ],
      ],
      [
        "Ja, genau.",
        { tool: "book_meeting", readBack: readBackOf(LISA), answer: "Ja, genau.", verdict: "yes", ran: true },
        [{ name: "book_meeting", input: sent, ok: true, result: { ok: true, message: "Booked (fake)." }, faked: true }],
      ],
    ]);
    expect(result.passed).toBe(true);
    expect(result.checks.at(-1)).toMatchObject({ name: 'called book_meeting with {"email":/@example\\.com$/}', pass: true });
    expect(result.notes).toEqual([]);
  });

  it("records a no and an unclear answer: the held tool and its fake do not run", async () => {
    for (const [verdict, answer] of [
      ["no", "Ja, passt so. Wie lautet meine Buchungsnummer?"],
      ["unclear", "Hm?"],
    ] as const) {
      const fake = vi.fn(async (): Promise<ToolResult> => ({ ok: true }));
      const { result, onSubmit } = await runBooking({
        definition: { turns: [BOOK_LINE, answer], fakes: { book_meeting: fake } },
        steps: [callsBook(LISA), says("Which day suits you?")],
        verdicts: [verdict],
      });

      expect([onSubmit.mock.calls.length, fake.mock.calls.length]).toEqual([0, 0]);
      expect(result.turns[1]?.confirmation).toEqual({ tool: "book_meeting", readBack: readBackOf(LISA), answer, verdict, ran: false });
      expect(result.turns[1]?.toolCalls).toEqual([]);
      expect(result.notes[0]).toBe("the fake for book_meeting was never used: no call of book_meeting ran");
    }
  });

  it("a function fake that returns no tool result fails the call, as a tool's own bug does", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, onSubmit } = await runBooking({
      definition: { turns: [BOOK_LINE, "Yes."], fakes: { book_meeting: (() => "booked") as unknown as () => ToolResult } },
      steps: [callsBook(LISA), says("Sorry, that did not work.")],
      verdicts: ["yes"],
    });

    expect(onSubmit).not.toHaveBeenCalled();
    const [call] = result.turns[1]?.toolCalls ?? [];
    expect(call).toMatchObject({ name: "book_meeting", ok: false, result: { ok: false } });
    expect(call?.faked).toBeUndefined();
    expect(call?.result?.message).toMatch(/^book_meeting failed because of an internal error/);
    expect(errors).toHaveBeenCalledWith(
      '[curb] tool "book_meeting" threw:',
      new Error(
        'The fake for book_meeting returned no tool result: a tool result is an object with ok (true or false) and optionally message and data; got "booked".',
      ),
    );
  });

  it("notes a fake no call used and a scenario without checks of its own, and passes", async () => {
    const result = await run({ turns: ["Hi"], fakes: { cancel_meeting: { ok: true } } }, reply("Happy to help."), unused);

    expect(result.passed).toBe(true);
    expect(result.notes).toEqual([
      "the fake for cancel_meeting was never used: no call of cancel_meeting ran",
      "this scenario has no checks of its own (expect), so only the built-in checks ran",
    ]);

    const checked = await run({ turns: ["Hi"], expect: ({ said }) => [said("happy")] }, reply("Happy to help."), unused);
    expect(checked.notes).toEqual([]);
  });
});

/** A simulator that says `lines` in order as the caller and answers the judge from `answers`. */
function simulating(lines: string[], answers: Parameters<typeof judge>[0] = {}) {
  const left = [...lines];
  const judged = judge(answers);
  const requests: AgentRunRequest[] = [];
  const llm: AgentLlmClient = async (request) => {
    if (isJudgeRequest(request)) return judged(request);
    requests.push(request);
    return { text: left.shift() ?? "[hang up]", toolCalls: [] };
  };
  return { llm, requests, judged };
}

describe("who ends the call", () => {
  const ask = { caller: { goal: "Put milk on the list" } };

  it("takes the caller's marker as the end, with what it says about the goal", async () => {
    const simulator = simulating(["Put milk on my list.", "Thanks, bye! [hang up: met - milk is on the list]"]);
    const { runtime, session } = tasksBundle(steps([calls(addTask("milk")), taskSays("Milk is on your list."), taskSays("Bye!")]));

    const result = await runScenario({ scenario: scenario(ask), name: "milk", file: "src/agent/milk.scenario.ts", bundle: { runtime, session }, simulator: simulator.llm });

    expect(result).toMatchObject({ outcome: "pass", endedBy: "caller" });
    expect(result.runs[0]?.ending).toEqual({ by: "caller", unsaid: [], maxTurns: 12, caller: { done: true, goalMet: true, reason: "milk is on the list" } });
    // The marker is not spoken: the agent heard the goodbye alone.
    expect(result.turns.map((turn) => turn.caller)).toEqual(["Put milk on my list.", "Thanks, bye!"]);
  });

  it("asks the caller whether it was done when the agent hangs up first, and fails when it was not", async () => {
    // The caller's line is a full goodbye in words, and it is still not done.
    const simulator = simulating(["That's all for the milk, have a great day so far. And then", "[still wanted: to add bread as well]"], { goal: "no" });
    const { runtime, session } = tasksBundle(steps([hangUp("You're welcome. Goodbye.")]));

    const result = await runScenario({ scenario: scenario(ask), name: "milk", file: "src/agent/milk.scenario.ts", bundle: { runtime, session }, simulator: simulator.llm });

    expect(result.endedBy).toBe("agent");
    expect(result.runs[0]?.ending.caller).toEqual({ done: false, goalMet: null, reason: "to add bread as well" });
    expect(failures(result)).toEqual([
      ["the agent does not hang up on a caller who still wants something", "the agent ended the call at turn 1 while the caller still wanted: to add bread as well"],
      ["the caller reaches its goal", "goal: no"],
    ]);
    // One line, then the question after the hang-up, which names the three markers.
    expect(simulator.requests).toHaveLength(2);
    expect(simulator.requests[1]?.stateSnapshot.join("\n")).toContain("The agent has just ended the call. Answer with exactly one marker");
  });

  it("does not ask again when the agent hangs up on a line that said the caller was done", async () => {
    const simulator = simulating(["Put milk on my list, that's all. Bye! [hang up: met - milk is on the list]"]);
    const { runtime, session } = tasksBundle(steps([calls(addTask("milk")), hangUp("Done. Goodbye.")]));

    const result = await runScenario({ scenario: scenario(ask), name: "milk", file: "src/agent/milk.scenario.ts", bundle: { runtime, session }, simulator: simulator.llm });

    expect(result).toMatchObject({ outcome: "pass", endedBy: "agent" });
    expect(simulator.requests).toHaveLength(1);
  });
});

describe("a reply that ends in end_call's goodbye", () => {
  const goodbye = "Glad I could help, Alex. Take care and see you soon.";
  /** One scripted turn on a session whose LLM streams `text`, then calls end_call with the goodbye. */
  const ends = async (text: string) => {
    const { runtime } = tasksBundle(unused);
    const streamLlm = scriptedStream([{ text, toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye } }] }]);
    return runScenario({
      scenario: scenario({ turns: ["No, that's everything. Thanks, bye."] }),
      name: "goodbye",
      file: "src/agent/goodbye.scenario.ts",
      bundle: { runtime, session: new AgentSession(runtime, unused, { streamLlm }) },
      simulator: unused,
    });
  };

  it("is the goodbye alone when the step wrote one sentence before the call: that sentence is held back, as on a call", async () => {
    const result = await ends("Glad I could help, Alex.");
    expect(result.turns[0]).toMatchObject({ reply: goodbye, endedCall: true });
    expect(failures(result)).toEqual([]);
  });

  it("is what the caller hears when the step said something else first: its first sentence, then the goodbye", async () => {
    // Of two sentences in front of a tool call the first is spoken, on a call as here; the second is held back and dropped.
    const result = await ends("All booked, Alex. One moment while I close this.");
    expect(result.turns[0]?.reply).toBe(`All booked, Alex. ${goodbye}`);
    expect(failures(result)).toEqual([]);
  });

  it("records a goodbye the model wrote as text too once, as the caller hears it", async () => {
    // The session says the first sentence of the step's text, then only the rest of end_call's
    // goodbye, so the reply is the goodbye alone and no check fails.
    const result = await ends(goodbye);
    expect(result.turns[0]?.reply).toBe(goodbye);
    expect(failures(result)).toEqual([]);
  });
});

describe("the agent's state at the end of the call", () => {
  const twoTasks = () => steps([calls(addTask("milk")), calls(addTask("bread")), taskSays("Milk and bread are on your list.")]);

  it("is what expect reads: a store's data, a match against it, the context, and the order of the calls", async () => {
    const { runtime, session } = tasksBundle(twoTasks());
    const result = await runScenario({
      scenario: scenario({
        turns: ["Put milk and bread on my list."],
        expect: ({ state, stateMatches, calledInOrder, context, check }) => [
          stateMatches("tasks", { tasks: [{ title: "milk", done: false }, { title: /^br/ }] }),
          check("two tasks and nothing else", state<{ tasks: unknown[] }>("tasks").tasks.length === 2),
          check("the list is in the context", context.includes("content: Open tasks: milk, bread.")),
          calledInOrder(["add_task", { title: "MILK" }], ["add_task", { title: "bread" }]),
          calledInOrder("add_task", "add_task"),
        ],
      }),
      name: "tasks",
      file: "src/agent/tasks.scenario.ts",
      bundle: { runtime, session },
      simulator: unused,
    });

    expect(failures(result)).toEqual([]);
    expect(result.checks.slice(-5).map((check) => check.name)).toEqual([
      'state of tasks has {"tasks":[{"title":"milk","done":false},{"title":/^br/}]}',
      "two tasks and nothing else",
      "the list is in the context",
      'called in order: add_task with {"title":"MILK"}, add_task with {"title":"bread"}',
      "called in order: add_task, add_task",
    ]);
    expect(result.runs[0]?.endState).toEqual({
      stores: { tasks: { tasks: [{ title: "milk", done: false }, { title: "bread", done: false }] } },
      context: expect.arrayContaining(["content: Open tasks: milk, bread."]),
      skillPath: "",
    });
  });

  it("says where the state differs, and which stores there are when one is misnamed", async () => {
    const { runtime, session } = tasksBundle(twoTasks());
    const result = await runScenario({
      scenario: scenario({
        turns: ["Put milk and bread on my list."],
        expect: ({ stateMatches, calledInOrder }) => [
          stateMatches("tasks", { tasks: [{ title: "milk" }] }),
          stateMatches("tasks", { tasks: [{ title: "milk" }, { title: "butter" }] }),
          calledInOrder(["add_task", { title: "bread" }], ["add_task", { title: "milk" }]),
          stateMatches("todo", { tasks: [] }),
        ],
      }),
      name: "tasks",
      file: "src/agent/tasks.scenario.ts",
      bundle: { runtime, session },
      simulator: unused,
    });

    // The last one threw, so expect as a whole failed with what it said.
    expect(failures(result)).toEqual([["expect", 'expect threw: state("todo"): the agent had no store "todo" when the call ended. Its stores are "tasks".']]);

    const { runtime: again, session: session2 } = tasksBundle(twoTasks());
    const detailed = await runScenario({
      scenario: scenario({
        turns: ["Put milk and bread on my list."],
        expect: ({ stateMatches, calledInOrder }) => [
          stateMatches("tasks", { tasks: [{ title: "milk" }] }),
          stateMatches("tasks", { tasks: [{ title: "milk" }, { title: "butter" }] }),
          calledInOrder(["add_task", { title: "bread" }], ["add_task", { title: "milk" }]),
        ],
      }),
      name: "tasks",
      file: "src/agent/tasks.scenario.ts",
      bundle: { runtime: again, session: session2 },
      simulator: unused,
    });
    expect(failures(detailed).map(([, detail]) => detail)).toEqual([
      'tasks.tasks has 2 entries, not 1: [{"title":"milk","done":false},{"title":"bread","done":false}]',
      'tasks.tasks[1].title is "bread", not "butter"',
      'no call of add_task with {"title":"milk"} ran after add_task (turn 1); the calls that ran, in order: add_task (turn 1), add_task (turn 1)',
    ]);
  });
});

describe("repeated runs", () => {
  /** A scenario run `runs` times on fresh task agents; `outcomes` says which runs reach the goal. */
  async function repeat(params: {
    definition?: Partial<ScenarioDefinition>;
    goals: Array<"yes" | "no">;
    runs?: number;
    concurrency?: number;
    tokensPerRun?: number;
  }) {
    let built = 0;
    let inFlight = 0;
    let mostInFlight = 0;
    const goals = [...params.goals];
    const finished: number[] = [];
    const result = await runScenario({
      scenario: scenario({ caller: { goal: "Put milk on the list" }, ...params.definition }),
      name: "milk",
      file: "src/agent/milk.scenario.ts",
      createBundle: async () => {
        built += 1;
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        const bundle = tasksBundle(steps([calls(addTask("milk")), taskSays("Milk is on your list."), taskSays("Bye!")]));
        const tokens = params.tokensPerRun;
        return { ...bundle, ...(tokens ? { tokens: () => ({ inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) } : {}) };
      },
      llms: () => {
        const goal = goals.shift() ?? "yes";
        const { llm } = simulating(["Put milk on my list.", "Thanks, bye! [hang up: met - done]"], { goal });
        return { caller: llm, judge: llm };
      },
      ...(params.runs === undefined ? {} : { runs: params.runs }),
      ...(params.concurrency === undefined ? {} : { slots: new RunSlots(params.concurrency) }),
      onRun: (run) => {
        inFlight -= 1;
        finished.push(run.run);
      },
    });
    return { result, built, mostInFlight, finished };
  }

  it("needs two of three runs when the scenario says so", async () => {
    const twoOfThree = { runs: 3, minPassRate: 0.66 };
    const flaky = await repeat({ goals: ["no", "yes", "yes"], concurrency: 1, definition: twoOfThree });
    expect(flaky.result).toMatchObject({ outcome: "pass", flaky: true, stats: { runs: 3, ran: 3, passed: 2, failed: 1, passRate: 0.667, minPassRate: 0.66 } });

    const failed = await repeat({ goals: ["no", "no", "yes"], concurrency: 1, definition: twoOfThree });
    expect(failed.result).toMatchObject({ outcome: "fail", flaky: true, stats: { ran: 3, passed: 1, failed: 2, passRate: 0.333 } });

    // --runs overrides the scenario's number of runs, and its share still applies.
    const more = await repeat({ goals: ["yes", "no", "yes", "no", "yes", "yes"], runs: 6, concurrency: 1, definition: twoOfThree });
    expect(more.result).toMatchObject({ outcome: "pass", stats: { runs: 6, ran: 6, passed: 4, passRate: 0.667, minPassRate: 0.66 } });
  });

  it("runs a simulated scenario as often as asked, each run on a bundle of its own, and reports the rates", async () => {
    const { result, built, finished } = await repeat({ goals: ["yes", "no", "yes", "yes"], runs: 4, concurrency: 1, definition: { minPassRate: 0.5 } });

    expect(built).toBe(4);
    expect(finished).toEqual([1, 2, 3, 4]);
    expect(result).toMatchObject({ outcome: "pass", passed: true, flaky: true });
    expect(result.stats).toMatchObject({ runs: 4, ran: 4, passed: 3, failed: 1, errors: 0, passRate: 0.75, reliability: 0.316 });
    expect(result.checkStats.find((check) => check.name === "the caller reaches its goal")).toMatchObject({ passed: 3, total: 4, passRate: 0.75 });
    // Each run is there with its own conversation; the one shown first is the one that failed.
    expect(result.runs.map((run) => [run.run, run.outcome])).toEqual([[1, "pass"], [2, "fail"], [3, "pass"], [4, "pass"]]);
    expect(failures(result)).toEqual([["the caller reaches its goal", "goal: no"]]);
    expect(result.runs.every((run) => run.endState?.stores.tasks !== undefined)).toBe(true);
  });

  it("runs every run that was asked for, also once the outcome is decided", async () => {
    // Every run must pass, and the second did not: the other three run all the same.
    const all = await repeat({ goals: ["yes", "no", "yes", "yes", "yes"], runs: 5, concurrency: 1 });
    expect(all.built).toBe(5);
    expect(all.result).toMatchObject({ outcome: "fail", flaky: true, stats: { runs: 5, ran: 5, passed: 4, failed: 1, passRate: 0.8 } });
  });

  it("runs as many runs at a time as there are slots, four when nothing says otherwise", async () => {
    const parallel = await repeat({ goals: [], runs: 6, concurrency: 3 });
    expect(parallel.mostInFlight).toBe(3);
    expect(parallel.result.stats).toMatchObject({ ran: 6, passed: 6 });
    expect((await repeat({ goals: [], runs: 6 })).mostInFlight).toBe(4);
  });

  it("shares its slots with whoever else holds them: the limit is for all of them together", async () => {
    const slots = new RunSlots(2);
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
      order.push(name);
      return name;
    };

    const results = await Promise.all([slots.run(task("a", 30)), slots.run(task("b", 5)), slots.run(task("c", 5)), slots.run(task("d", 5))]);

    expect(results).toEqual(["a", "b", "c", "d"]);
    expect(most).toBe(2);
    // First come, first served: c took the slot b left, before d.
    expect(order).toEqual(["b", "c", "d", "a"]);
    // A task that fails frees its slot too.
    await expect(slots.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await slots.run(async () => "after")).toBe("after");
  });

  it("lets fewer in once its slots are lowered, without stopping what is in flight", async () => {
    const slots = new RunSlots(4);
    let inFlight = 0;
    const seen: number[] = [];
    const task = async () => {
      inFlight += 1;
      seen.push(inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    };

    const first = Array.from({ length: 4 }, () => slots.run(task));
    // The provider said to slow down, twice: four at a time become two, then one, and never none.
    expect([slots.lower(), slots.lower(), slots.lower()]).toEqual([2, 1, 1]);
    const later = Array.from({ length: 3 }, () => slots.run(task));
    await Promise.all([...first, ...later]);

    expect(slots.limit).toBe(1);
    // The four that were in flight went on together; the three after them ran one at a time.
    expect(seen).toEqual([1, 2, 3, 4, 1, 1, 1]);
  });

  it("records the tools the agent was offered, for the judge", async () => {
    const records: Array<{ tools?: unknown }> = [];
    const { runtime, session } = tasksBundle(steps([taskSays("Hello.")]));
    await runScenario({
      scenario: scenario({ turns: ["Hi"] }),
      name: "hello",
      file: "src/agent/hello.scenario.ts",
      bundle: { runtime, session },
      simulator: unused,
      onRun: (_run, conversation) => records.push(conversation),
    });
    // The agent's own tools with what they do; not end_call or skip_turn, which are the framework's.
    expect(records[0]?.tools).toEqual([
      { name: "add_task", description: "Add a task to the list." },
      { name: "send_summary", description: "Send the list to someone." },
    ]);
  });

  it("takes the scenario's own runs, which --runs overrides for a simulated caller only", () => {
    const simulated = scenario({ caller: { goal: "Book" }, runs: 3 });
    const scripted = scenario({ turns: ["Hi"] });
    expect([plannedRuns(simulated), plannedRuns(simulated, 10), plannedRuns(scripted), plannedRuns(scripted, 10)]).toEqual([3, 10, 1, 1]);
    expect(plannedRuns(scenario({ turns: ["Hi"], runs: 2 }), 10)).toBe(2);
  });

  it("counts the tokens each run used, and all of them together", async () => {
    const { result } = await repeat({ goals: [], runs: 3, concurrency: 1, tokensPerRun: 1000 });

    expect(result.stats).toMatchObject({ runs: 3, ran: 3, passed: 3 });
    expect(result.usage).toEqual({ agent: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, caller: null, judge: null, totalTokens: 3000 });
    expect(result.runs[0]?.usage?.totalTokens).toBe(1000);
  });
});

describe("tools on repeated runs", () => {
  const twice = async (definition: Partial<ScenarioDefinition>) => {
    const sends: Array<ReturnType<typeof tasksBundle>["send"]> = [];
    const result = await runScenario({
      scenario: scenario({ caller: { goal: "Send my list to Sam" }, runs: 2, ...definition }),
      name: "send",
      file: "src/agent/send.scenario.ts",
      createBundle: async () => {
        const bundle = tasksBundle(steps([calls(addTask("milk")), calls(sendSummary("Sam")), taskSays("Sent to Sam."), taskSays("Bye!")]));
        sends.push(bundle.send);
        return bundle;
      },
      llms: () => {
        const { llm } = simulating(["Put milk on my list and send it to Sam.", "Thanks, bye! [hang up: met - sent]"]);
        return { caller: llm, judge: llm };
      },
      slots: new RunSlots(1),
    });
    return { result, realSends: sends.reduce((sum, send) => sum + send.mock.calls.length, 0) };
  };

  it("runs a tool without a fake for real on every run", async () => {
    const { result, realSends } = await twice({});

    expect(realSends).toBe(2);
    expect(result).toMatchObject({ outcome: "pass", stats: { runs: 2, ran: 2, passed: 2 } });
  });

  it("runs a fake in place of its tool on every run, and the other tools for real", async () => {
    const faked = await twice({ fakes: { send_summary: { ok: true, message: "Sent (fake)." } } });

    expect(faked.realSends).toBe(0);
    expect(faked.result).toMatchObject({ outcome: "pass", stats: { ran: 2, passed: 2 } });
    expect(faked.result.runs[0]?.endState?.stores.tasks).toEqual({ tasks: [{ title: "milk", done: false }] });
  });

  it("runs tools for real on a scenario that runs once", async () => {
    const { runtime, session, send } = tasksBundle(steps([calls(sendSummary("Sam")), taskSays("Sent to Sam.")]));
    const result = await runScenario({
      scenario: scenario({ turns: ["Send my list to Sam."] }),
      name: "send",
      file: "src/agent/send.scenario.ts",
      bundle: { runtime, session },
      simulator: unused,
    });
    expect(result.outcome).toBe("pass");
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("experiments on repeated runs", () => {
  const experiments = experimentDeclarations({
    greeting: { variants: { formal: 1, casual: 1, warm: 1 }, fromClient: "greeting" },
    pacing: { variants: { slow: 1, fast: 1 } },
  });
  const id = { file: "src/agent/greeting.scenario.ts", name: "greeting" };

  it("gives the first run the variants a single run gets, and moves every open experiment on with each further run", () => {
    const open = scenario({ caller: { goal: "Say hello" } });
    const first = runVariants(id, experiments, open, 0);
    expect(first).toEqual(scenarioVariants(id, experiments, open));

    const greetings = [0, 1, 2, 3].map((run) => runVariants(id, experiments, open, run).greeting);
    expect(new Set(greetings.slice(0, 3))).toEqual(new Set(["formal", "casual", "warm"]));
    expect(greetings[3]).toBe(greetings[0]);
    expect(new Set([0, 1].map((run) => runVariants(id, experiments, open, run).pacing))).toEqual(new Set(["slow", "fast"]));
  });

  it("never moves a variant the scenario pins or its page info picks", () => {
    const pinned = scenario({ caller: { goal: "Say hello" }, experiments: { pacing: "fast" }, client: { greeting: "warm" } });
    for (const run of [0, 1, 2]) expect(runVariants(id, experiments, pinned, run)).toEqual({ greeting: "warm", pacing: "fast" });
  });

  it("covers every variant across the runs and reports each on its own", async () => {
    const result = await runScenario({
      scenario: scenario({ caller: { goal: "Put milk on the list" }, experiments: { pacing: "slow" } }),
      name: id.name,
      file: id.file,
      createBundle: async () => ({ ...tasksBundle(steps([taskSays("Milk is on your list."), taskSays("Bye!")])), experiments }),
      llms: () => {
        const { llm } = simulating(["Put milk on my list.", "Bye! [hang up: met - done]"]);
        return { caller: llm, judge: llm };
      },
      runs: 3,
    });

    expect(result.variants.map((variant) => [variant.experiment, variant.variant, variant.runs, variant.passed])).toEqual([
      ["greeting", "casual", 1, 1],
      ["greeting", "formal", 1, 1],
      ["greeting", "warm", 1, 1],
      ["pacing", "slow", 3, 3],
    ]);
    expect(result.notes).toEqual(["this scenario has no checks of its own (expect), so only the built-in checks ran"]);
  });

  it("notes the variants a scenario's runs did not reach", async () => {
    const bundle = { ...tasksBundle(steps([taskSays("Hello.")])), experiments };
    const result = await runScenario({ scenario: scenario({ turns: ["Hi"], expect: ({ said }) => [said("hello")] }), name: id.name, file: id.file, bundle, simulator: unused });

    const [greeting, pacing] = [result.runs[0]!.experiments.greeting!, result.runs[0]!.experiments.pacing!];
    const others = (all: string[], seen: string) => all.filter((variant) => variant !== seen).map((variant) => `"${variant}"`).join(", ");
    expect(result.notes).toEqual([
      `experiment greeting: 1 run(s) covered "${greeting}" and not ${others(["casual", "formal", "warm"], greeting)}; run it 3 times (runs) to cover every variant, or pin one (experiments: { greeting: ... })`,
      `experiment pacing: 1 run(s) covered "${pacing}" and not ${others(["fast", "slow"], pacing)}; run it 2 times (runs) to cover every variant, or pin one (experiments: { pacing: ... })`,
    ]);
  });
});

describe("provider errors", () => {
  it("make the run an error when the bundle's transport gave up, and a failure when it does not say", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: AgentLlmClient = async () => {
      throw new Error("HTTP 529: overloaded");
    };
    const play = async (providerErrors?: () => number) => {
      const { runtime, session } = tasksBundle(failing);
      return runScenario({
        scenario: scenario({ turns: ["Hi"] }),
        name: "hello",
        file: "src/agent/hello.scenario.ts",
        bundle: { runtime, session, ...(providerErrors ? { providerErrors } : {}) },
        simulator: unused,
      });
    };

    let gaveUp = 0;
    const counted = await play(() => (gaveUp += 1));
    expect(counted).toMatchObject({ outcome: "error", passed: false, endedBy: "error" });
    expect(counted.runs[0]?.error).toEqual({ kind: "provider", message: "the agent's LLM provider failed, after the retries: failed: HTTP 529: overloaded" });
    expect(counted.stats).toMatchObject({ errors: 1, failed: 0, passRate: null });

    expect(await play()).toMatchObject({ outcome: "fail", stats: { errors: 0, failed: 1 } });
    vi.restoreAllMocks();
  });
});
