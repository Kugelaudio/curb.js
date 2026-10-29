import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { fallbackReplies } from "../llm/localized.js";
import type { AgentRunResponse } from "../llm/types.js";
import { createAgentSession } from "../server/bootstrap.js";
import { LISA, bookingRuntime, booked, callsBook, readBackOf, says, scripted, type Booking } from "../test-fixtures/booking.js";
import type { ToolResult } from "../types.js";
import { experimentDeclarations } from "../experiments.js";
import { assignExperiments } from "../experiments.node.js";
import { runScenario, scenarioSessionId, scenarioVariants, type ScenarioResult } from "./run.js";
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
