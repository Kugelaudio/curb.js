import { describe, expect, it } from "vitest";
import { AgentAuthoringError } from "./authoring.js";
import { assertGoals, goalDeclarations, goalsProblems } from "./goals.js";

/** `defineAgent({ goals })`: what it accepts, and the shape the bundle manifest carries. */

describe("goals validation", () => {
  it("accepts the contract's example and no goals at all", () => {
    expect(
      goalsProblems({
        booked: { description: "The caller booked a webinar slot", tool: "book_slot" },
        felt_easy: { description: "Booking felt easy", judge: "The caller says booking with the assistant was easy or pleasant." },
      }),
    ).toEqual([]);
    expect(goalsProblems(undefined)).toEqual([]);
  });

  it("takes exactly one of tool and judge", () => {
    expect(goalsProblems({ booked: { tool: "book_slot", judge: "Booked." } }).join(" ")).toContain("needs exactly one of tool");
    expect(goalsProblems({ booked: { description: "Booked." } }).join(" ")).toContain("needs exactly one of tool");
  });

  it("holds names, tool names, criteria, descriptions and the count to their limits", () => {
    expect(goalsProblems({ "Booked!": { tool: "book_slot" } }).join(" ")).toContain('"Booked!" cannot name a goal');
    expect(goalsProblems({ booked: { tool: "book slot" } }).join(" ")).toContain("goals.booked.tool must name a tool");
    expect(goalsProblems({ booked: { tool: "x".repeat(65) } })).toHaveLength(1);
    expect(goalsProblems({ easy: { judge: "   " } }).join(" ")).toContain("goals.easy.judge must be the criterion");
    expect(goalsProblems({ easy: { judge: "ü".repeat(1000) } })).toEqual([]);
    expect(goalsProblems({ easy: { judge: "x".repeat(1001) } }).join(" ")).toContain("1001 characters long");
    expect(goalsProblems({ easy: { judge: "Easy.", description: "x".repeat(201) } }).join(" ")).toContain(
      "goals.easy.description is 201 characters long",
    );
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`goal_${index}`, { tool: "book_slot" }]));
    expect(goalsProblems(many).join(" ")).toContain("at most 20 goals; this one declares 21");
  });

  it("throws one AgentAuthoringError naming every problem", () => {
    let thrown: unknown;
    try {
      assertGoals({ booked: { tool: "book_slot", criteria: "x" }, Easy: { judge: "" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentAuthoringError);
    const { message, fix } = (thrown as AgentAuthoringError).diagnostic;
    expect(message).toContain('goals.booked has unknown field "criteria"');
    expect(message).toContain('"Easy" cannot name a goal');
    expect(message).toContain("goals.Easy.judge must be the criterion");
    expect(fix).toContain('tool: "book_slot"');
  });
});

describe("goalDeclarations", () => {
  it("sorts by name, names the kind and leaves out an absent description", () => {
    expect(
      goalDeclarations({
        felt_easy: { description: "Booking felt easy", judge: "The caller says booking was easy." },
        booked: { tool: "book_slot" },
      }),
    ).toEqual([
      { name: "booked", kind: "tool", tool: "book_slot" },
      { name: "felt_easy", description: "Booking felt easy", kind: "judge", criterion: "The caller says booking was easy." },
    ]);
    expect(goalDeclarations(undefined)).toEqual([]);
  });

  it("writes its fields in the manifest's order", () => {
    const [goal] = goalDeclarations({ booked: { tool: "book_slot", description: "Booked." } });
    expect(Object.keys(goal!)).toEqual(["name", "description", "kind", "tool"]);
  });
});
