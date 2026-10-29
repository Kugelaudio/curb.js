import { describe, expect, it } from "vitest";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import {
  assertExperiments,
  experimentAssignmentsOf,
  experimentDeclarations,
  experimentInfo,
  experimentsProblems,
} from "./experiments.js";
import { clientInfoProblem } from "./server/protocol.js";

/** `defineAgent({ experiments })`: what it accepts, and the shape the bundle manifest carries. */

const variants = { formal: 1, casual: 1 };

describe("experiments validation", () => {
  it("accepts the contract's example and no experiments at all", () => {
    expect(
      experimentsProblems({ greeting: { description: "Formal vs casual opening", variants, fromClient: "greeting" } }),
    ).toEqual([]);
    expect(experimentsProblems(undefined)).toEqual([]);
    expect(experimentsProblems({})).toEqual([]);
  });

  it("refuses names outside the rule, for experiments and variants", () => {
    expect(experimentsProblems({ Greeting: { variants } }).join(" ")).toContain('"Greeting" cannot name an experiment');
    expect(experimentsProblems({ greeting: { variants: { formal: 1, "casual-2": 1 } } }).join(" ")).toContain(
      '"casual-2" cannot name a variant',
    );
    expect(experimentsProblems({ [`g${"x".repeat(39)}`]: { variants } })).toEqual([]);
    expect(experimentsProblems({ [`g${"x".repeat(40)}`]: { variants } })).toHaveLength(1);
  });

  it("holds the counts: at most 5 experiments, 2 to 6 variants", () => {
    const six = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((name) => [name, { variants }]));
    expect(experimentsProblems(six).join(" ")).toContain("at most 5 experiments; this one declares 6");
    expect(experimentsProblems({ greeting: { variants: { only: 1 } } }).join(" ")).toContain("has 1 variant;");
    const seven = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((name) => [name, 1]));
    expect(experimentsProblems({ greeting: { variants: seven } }).join(" ")).toContain("has 7 variants;");
  });

  it("takes whole-number weights from 1 to 100 only", () => {
    for (const weight of [1, 50, 100]) {
      expect(experimentsProblems({ greeting: { variants: { formal: weight, casual: 1 } } })).toEqual([]);
    }
    for (const weight of [0, 101, 1.5, "1", -1]) {
      expect(experimentsProblems({ greeting: { variants: { formal: weight, casual: 1 } } }).join(" ")).toContain(
        "experiments.greeting.variants.formal must be a whole-number weight from 1 to 100",
      );
    }
  });

  it("holds fromClient to the page info key rule", () => {
    for (const key of ["greeting", "Greeting_2", "g", "x".repeat(40), "2greeting", "greeting-x", "", "x".repeat(41)]) {
      const accepted = experimentsProblems({ greeting: { variants, fromClient: key } }).length === 0;
      expect(accepted, key).toBe(clientInfoProblem(key, "value") === null);
    }
    expect(experimentsProblems({ greeting: { variants, fromClient: 3 } }).join(" ")).toContain("fromClient must be a client-context key");
  });

  it("refuses a description over 200 characters, counting characters as a person does", () => {
    expect(experimentsProblems({ greeting: { variants, description: "ü".repeat(200) } })).toEqual([]);
    expect(experimentsProblems({ greeting: { variants, description: "x".repeat(201) } }).join(" ")).toContain(
      "201 characters long",
    );
  });

  it("names unknown fields and every problem in one AgentAuthoringError", () => {
    let thrown: unknown;
    try {
      assertExperiments({ greeting: { variant: variants }, Pacing: { variants: { slow: 0, fast: 1 } } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const { diagnostic } = thrown as AgentAuthoringError;
    expect(diagnostic.code).toBe(AUTHORING_DIAGNOSTIC_CODES.invalidProp);
    expect(diagnostic.location).toEqual({ source: "src/agent/agent.tsx", component: "defineAgent" });
    expect(diagnostic.message).toContain('experiments.greeting has unknown field "variant"');
    expect(diagnostic.message).toContain("experiments.greeting.variants must be an object");
    expect(diagnostic.message).toContain('"Pacing" cannot name an experiment');
    expect(diagnostic.message).toContain("experiments.Pacing.variants.slow must be a whole-number weight");
    expect(diagnostic.fix).toContain("variants: { formal: 1, casual: 1 }");
  });
});

describe("experimentDeclarations", () => {
  it("sorts experiments and variants by name, in byte order, and leaves out what is absent", () => {
    expect(
      experimentDeclarations({
        pacing: { variants: { slow: 2, fast: 1 } },
        greeting: { description: "Formal vs casual opening", variants: { formal: 1, casual: 1, a_b: 1, a1: 1 }, fromClient: "greeting" },
      }),
    ).toEqual([
      {
        name: "greeting",
        description: "Formal vs casual opening",
        // Digits sort before "_", which sorts before letters: Go's sort.Strings order.
        variants: [
          { name: "a1", weight: 1 },
          { name: "a_b", weight: 1 },
          { name: "casual", weight: 1 },
          { name: "formal", weight: 1 },
        ],
        fromClient: "greeting",
      },
      { name: "pacing", variants: [{ name: "fast", weight: 1 }, { name: "slow", weight: 2 }] },
    ]);
    expect(experimentDeclarations(undefined)).toEqual([]);
  });

  it("writes its fields in the manifest's order", () => {
    const [experiment] = experimentDeclarations({ greeting: { fromClient: "greeting", variants, description: "d" } });
    expect(Object.keys(experiment!)).toEqual(["name", "description", "variants", "fromClient"]);
  });
});

describe("experiment info", () => {
  it("puts each assignment on experiment.<name> and reads it back", () => {
    const info = experimentInfo({ greeting: "casual", pacing: "slow" });
    expect(info).toEqual({ "experiment.greeting": "casual", "experiment.pacing": "slow" });
    expect(experimentAssignmentsOf({ ...info, "client.greeting": "formal", "experiment.odd": 3 })).toEqual({
      greeting: "casual",
      pacing: "slow",
    });
    expect(experimentInfo(undefined)).toEqual({});
  });
});
