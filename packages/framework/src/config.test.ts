import { describe, expect, it } from "vitest";
import { defineAgent, openingLineOf, type AgentDefinition } from "./config.js";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";

/**
 * `defineAgent` refuses a configuration no call could run with. A scaffold placeholder in the
 * model id is refused where the model id lives, in the `curb/providers` factories (see
 * providers.test.ts).
 */

const App = () => null;

describe("defineAgent", () => {
  it("takes an IANA time zone and refuses one that does not exist, naming it", () => {
    expect(() => defineAgent({ app: App, timeZone: "Europe/Berlin" })).not.toThrow();
    let thrown: unknown;
    try {
      defineAgent({ app: App, timeZone: "Berlin" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const diagnostic = (thrown as AgentAuthoringError).diagnostic;
    expect(diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidProp);
    expect(diagnostic.message).toContain('"Berlin"');
    expect(diagnostic.fix).toContain("Europe/Berlin");
  });
});

/** The authoring error `defineAgent` throws for a `firstTurn`, or null when it accepts it. */
function firstTurnError(firstTurn: unknown) {
  try {
    defineAgent({ app: App, firstTurn } as AgentDefinition);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAuthoringError);
    return (error as AgentAuthoringError).diagnostic;
  }
}

describe("defineAgent({ firstTurn })", () => {
  it("takes the caller, a greeting the model writes, or exact words to open with", () => {
    for (const firstTurn of [undefined, "user", "agent", { say: "Ich bin Clara." }, { say: () => "Hallo." }]) {
      expect(firstTurnError(firstTurn)).toBeNull();
    }
  });

  it("refuses an opening with no words, or a shape no conversation opens with, saying how to fix it", () => {
    for (const say of ["", "   ", 42, undefined]) {
      const diagnostic = firstTurnError({ say });
      expect(diagnostic?.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidProp);
      expect(diagnostic?.message).toContain("has no words");
      expect(diagnostic?.fix).toContain('firstTurn: { say: "');
    }
    expect(firstTurnError({ say: "Hallo.", interruptible: true })?.message).toContain(
      "is not a firstTurn option: it takes only say",
    );
    const unknown = firstTurnError("assistant");
    expect(unknown?.message).toBe('defineAgent({ firstTurn: "assistant" }) is not a way to open a conversation.');
    expect(unknown?.fix).toContain('{ say: "<the exact opening line>" }');
  });
});

describe("defineAgent({ goals, experiments })", () => {
  it("takes goals and experiments a platform can evaluate and assign, and returns them as written", () => {
    const goals = {
      booked: { description: "The caller booked a webinar slot", tool: "book_slot" },
      felt_easy: { judge: "The caller says booking with the assistant was easy or pleasant." },
    };
    const experiments = { greeting: { variants: { formal: 1, casual: 1 }, fromClient: "greeting" } };
    const agent = defineAgent({ app: App, goals, experiments });
    expect(agent.goals).toBe(goals);
    expect(agent.experiments).toBe(experiments);
  });

  it("refuses ones it cannot, before any call runs", () => {
    const goals = { booked: { tool: "book_slot", judge: "Booked." } } as unknown as AgentDefinition["goals"];
    expect(() => defineAgent({ app: App, goals })).toThrow(/defineAgent\(\{ goals \}\) cannot be used: goals\.booked needs exactly one/);
    expect(() => defineAgent({ app: App, experiments: { greeting: { variants: { formal: 1 } } } })).toThrow(
      /defineAgent\(\{ experiments \}\) cannot be used: experiments\.greeting has 1 variant/,
    );
  });
});

describe("openingLineOf", () => {
  it("has a line only for firstTurn { say }", () => {
    expect(openingLineOf(undefined)).toBeUndefined();
    expect(openingLineOf("user")).toBeUndefined();
    expect(openingLineOf("agent")).toBeUndefined();
    expect(openingLineOf({ say: "Ich bin Clara." })?.({})).toBe("Ich bin Clara.");
  });

  it("writes the line from the session info when the conversation opens, which it cannot change", () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    const opening = openingLineOf({
      say: (info) => {
        seen.push(info);
        const event = info["client.event"];
        return typeof event === "string" ? `Willkommen zum ${event}.` : "Willkommen.";
      },
    })!;

    expect(opening({ "client.event": "Webinar am 11.04.", "caller.identity": "user" })).toBe("Willkommen zum Webinar am 11.04..");
    expect(opening({})).toBe("Willkommen.");
    expect(seen[0]).toEqual({ "client.event": "Webinar am 11.04.", "caller.identity": "user" });
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("refuses a function that returns no words, as an authoring error with the fix", () => {
    const opening = openingLineOf({ say: (info) => info["client.event"] as string })!;
    let thrown: unknown;
    try {
      opening({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const { diagnostic } = thrown as AgentAuthoringError;
    expect(diagnostic.message).toBe("defineAgent({ firstTurn: { say } }) returned undefined instead of the opening line.");
    expect(diagnostic.fix).toContain("a page that sent no client.* info");
  });
});
