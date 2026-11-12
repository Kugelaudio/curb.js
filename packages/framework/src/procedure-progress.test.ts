import { describe, expect, it } from "vitest";

import { procedureChanges, proceduresOf } from "./procedure-progress.js";
import type { PageBlock } from "./types.js";

function procedure(title: string, statuses: Array<"completed" | "current" | "locked">): PageBlock {
  return {
    type: "block",
    name: "procedure",
    payload: { title, steps: statuses.map((status, index) => ({ order: index + 1, title: `Step ${index + 1}`, text: "", status })) },
  };
}

const at = (...blocks: PageBlock[]) => proceduresOf(blocks);

describe("procedure progress", () => {
  it("reads each procedure in the context, and nothing else", () => {
    const procedures = at({ type: "text", text: "Hello" }, procedure("Claim", ["completed", "current", "locked"]));
    expect([...procedures.values()]).toEqual([
      { title: "Claim", steps: 3, done: 1, stepTitles: ["Step 1", "Step 2", "Step 3"] },
    ]);
  });

  it("says a procedure started when it enters the context, at the step it is on", () => {
    expect(procedureChanges(at(), at(procedure("Claim", ["completed", "current", "locked"])))).toEqual([
      { action: "started", title: "Claim", step: 2, steps: 3 },
    ]);
  });

  it("names every step completed since the last look, then the completion", () => {
    const before = at(procedure("Claim", ["current", "locked", "locked"]));
    expect(procedureChanges(before, at(procedure("Claim", ["completed", "current", "locked"])))).toEqual([
      { action: "step_completed", title: "Claim", step: 1, steps: 3, stepTitle: "Step 1" },
    ]);
    expect(procedureChanges(before, at(procedure("Claim", ["completed", "completed", "completed"])))).toEqual([
      { action: "step_completed", title: "Claim", step: 1, steps: 3, stepTitle: "Step 1" },
      { action: "step_completed", title: "Claim", step: 2, steps: 3, stepTitle: "Step 2" },
      { action: "step_completed", title: "Claim", step: 3, steps: 3, stepTitle: "Step 3" },
      { action: "completed", title: "Claim", step: 3, steps: 3 },
    ]);
  });

  it("says a procedure was left when it leaves the context unfinished, and nothing once finished", () => {
    expect(procedureChanges(at(procedure("Claim", ["completed", "current", "locked"])), at())).toEqual([
      { action: "left", title: "Claim", step: 2, steps: 3 },
    ]);
    expect(procedureChanges(at(procedure("Claim", ["completed", "completed"])), at())).toEqual([]);
  });

  it("reports nothing for a procedure first seen finished, or one that did not move", () => {
    const done = at(procedure("Claim", ["completed", "completed"]));
    expect(procedureChanges(at(), done)).toEqual([]);
    const same = at(procedure("Claim", ["current", "locked"]));
    expect(procedureChanges(same, at(procedure("Claim", ["current", "locked"])))).toEqual([]);
  });
});
