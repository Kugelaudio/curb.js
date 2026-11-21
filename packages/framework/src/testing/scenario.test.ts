import { describe, expect, it } from "vitest";
import { personas } from "./personas.js";
import { scenario, type ScenarioDefinition } from "./scenario.js";

describe("scenario()", () => {
  it("accepts scripted lines and a simulated caller, and returns them unchanged", () => {
    const scripted = scenario({ name: "greets", turns: ["Hi", "Bye"], maxTurns: 2 });
    expect(scripted).toEqual({ name: "greets", turns: ["Hi", "Bye"], maxTurns: 2 });
    expect(Object.isFrozen(scripted)).toBe(true);

    const expectFn = () => [];
    expect(
      scenario({
        caller: { goal: "Book a follow-up call", knows: "Name Max Mustermann", language: "de" },
        expect: expectFn,
      }),
    ).toEqual({ caller: { goal: "Book a follow-up call", knows: "Name Max Mustermann", language: "de" }, expect: expectFn });
  });

  it("names every problem and its fix at once", () => {
    const definition = {
      caller: { goal: " ", language: "not a language", mood: "angry" },
      turns: ["Hi"],
      maxTurns: 0,
      expect: "called(book_meeting)",
      steps: 3,
    } as unknown as ScenarioDefinition;

    expect(() => scenario(definition)).toThrow(
      [
        'scenario(): Unknown field "steps" in a scenario; it takes name, caller, turns, maxTurns, client, experiments, fakes, runs, minPassRate, expectations, failOn, style, expect.',
        "Give caller (a simulated caller) or turns (scripted caller lines), not both.",
        'Unknown field "mood" in caller; it takes goal, knows, language, persona, behaviours.',
        'caller.goal must say what the caller wants from the call, e.g. "Book a follow-up call for next week".',
        'caller.language must be a language code such as "de" or "en-US"; got "not a language".',
        "maxTurns must be a whole number of caller turns, at least 1; got 0.",
        'expect must be a function that returns checks, e.g. ({ called }) => [called("book_meeting")].',
      ].join(" "),
    );
  });

  it("refuses a definition without a caller, empty lines, and a script longer than maxTurns", () => {
    expect(() => scenario({})).toThrow('Give caller: { goal: "..." } for a simulated caller, or turns: ["...", ...]');
    expect(() => scenario({ turns: [] })).toThrow("turns must be a non-empty list of caller lines");
    expect(() => scenario({ turns: ["Hi", " ", "Bye", 4 as unknown as string] })).toThrow(
      "entry 2, 4 is empty or not a string",
    );
    expect(() => scenario({ turns: ["Hi", "Bye", "Again"], maxTurns: 2 })).toThrow(
      "maxTurns (2) is less than the 3 scripted turns; raise it or leave it out.",
    );
    expect(() => scenario(null as unknown as ScenarioDefinition)).toThrow("It takes one object");
  });

  it("takes fakes: a tool result or a function per tool, and names each wrong one", () => {
    const createClaim = async () => ({ ok: true, message: "Claim created." });
    const fakes = { send_email: { ok: false, message: "The mail server is down.", data: { retry: true } }, create_claim: createClaim };
    expect(scenario({ turns: ["Hi"], fakes }).fakes).toEqual(fakes);

    expect(() =>
      scenario({
        turns: ["Hi"],
        fakes: {
          book_meeting: { ok: "yes" },
          send_email: { ok: true, mesage: "Sent." },
          notify: "done",
          end_call: { ok: true },
        },
      } as unknown as ScenarioDefinition),
    ).toThrow(
      [
        'scenario(): fakes.book_meeting: ok must be true or false; got "yes".',
        'fakes.send_email: unknown field "mesage"; a tool result takes ok, message, data.',
        'fakes.notify: give the result its calls get, such as { ok: true, message: "Done." }, or a function of the input that returns one; got "done".',
        "fakes.end_call: end_call is the framework's own tool, not one of the agent's, and cannot be faked.",
      ].join(" "),
    );
    expect(() => scenario({ turns: ["Hi"], fakes: [] } as unknown as ScenarioDefinition)).toThrow(
      'fakes must be an object of tool name to the result its calls get, e.g. { create_claim: { ok: true, message: "Claim created." } }.',
    );
  });

  it("takes the page info a call starts with, held to the limits a page's info has everywhere", () => {
    expect(scenario({ turns: ["Hi"], client: { event: "webinar-11-04" } }).client).toEqual({ event: "webinar-11-04" });
    expect(() =>
      scenario({ turns: ["Hi"], client: { "my-event": "x", event: 7 } } as unknown as ScenarioDefinition),
    ).toThrow(
      'scenario(): "my-event" cannot name page info (client.<key>): use a letter, then up to 39 letters, digits or underscores. client.event must be a string, got number.',
    );
    expect(() => scenario({ turns: ["Hi"], client: "event=x" } as unknown as ScenarioDefinition)).toThrow(
      'client must be an object of page info, e.g. { event: "webinar-11-04" } for client.event.',
    );
  });

  it("takes repeated runs, a persona, expectations and style limits, and names each wrong one", () => {
    const definition: ScenarioDefinition = {
      caller: { goal: "Book a haircut", ...personas.rushed },
      runs: 5,
      minPassRate: 0.8,
      expectations: ["The agent reads the booking number back."],
      failOn: ["claimed_without_tool"],
      style: { wordsP90: 40 },
    };
    expect(scenario(definition)).toEqual(definition);

    expect(() =>
      scenario({
        caller: { goal: "Book a haircut", persona: " ", behaviours: ["impatient", "rude"] },
        maxTurns: 500,
        runs: 0,
        minPassRate: 80,
        expectations: ["The agent is polite.", " "],
        failOn: ["was_rude"],
        style: { wordsP99: 40, wordsP90: "short" },
      } as unknown as ScenarioDefinition),
    ).toThrow(
      [
        'scenario(): caller.persona must say who the caller is and how they talk, e.g. "An elderly caller who talks slowly".',
        'caller.behaviours takes a list of everything_at_once, changes_mind, off_topic, impatient, asks_to_repeat; got "rude".',
        "maxTurns (500) is more than a simulated caller may take; give at most 100.",
        "runs must be a whole number of runs from 1 to 100; got 0.",
        "minPassRate must be the share of runs that must pass, above 0 and at most 1 (0.8 for four in five); got 80.",
        "expectations must hold one sentence per entry; entry 2 is empty or not a string.",
        'failOn names "was_rude", which is no judge finding; the findings are asked_again, claimed_without_tool, ignored_caller, incoherent, wrong_tool_use, ended_early.',
        'style: "wordsP99" is no style number; the numbers are wordsP50, wordsP90, questionShare, repeatedOpeningShare, repeatedClosingShare, sameGoodbyeShare, stepsPerTurn, stepsPerTurnMax, refusedToolCallsPerRun.',
        'style: wordsP90 must be a number, 0 or more; got "short".',
      ].join(" "),
    );
  });

  it("takes the experiment variants a call gets, by name, and names each malformed one", () => {
    expect(scenario({ turns: ["Hi"], experiments: { greeting: "casual" } }).experiments).toEqual({ greeting: "casual" });
    expect(() =>
      scenario({ turns: ["Hi"], experiments: { Greeting: "casual", pacing: 2 } } as unknown as ScenarioDefinition),
    ).toThrow(
      'scenario(): experiments.Greeting: "Greeting" cannot name an experiment: use a lowercase letter, then up to 39 lowercase letters, digits or underscores. experiments.pacing: give the variant\'s name as text; got 2.',
    );
    expect(() => scenario({ turns: ["Hi"], experiments: ["casual"] } as unknown as ScenarioDefinition)).toThrow(
      'experiments must be an object of experiment name to variant name, e.g. { greeting: "casual" }.',
    );
  });
});
