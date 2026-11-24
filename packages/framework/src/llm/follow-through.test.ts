import { describe, expect, it } from "vitest";
import { followThroughTools, inventedNumber } from "./follow-through.js";

describe("inventedNumber: a check call fills no long number the conversation never had", () => {
  it("finds a phone number no one said, and passes one the caller said in any spacing", () => {
    expect(inventedNumber({ phone: "+1 123 456 789", topic: "claim" }, ["I'm Alex. How do callbacks work?"])).toBe(
      "1 123 456 789",
    );
    expect(inventedNumber({ phone: "+1 555-0100 22" }, ["call me on 5550100 22"])).toBeUndefined();
    expect(inventedNumber({ phone: "555 0100" }, ["my number is 555 01 00"])).toBeUndefined();
  });

  it("leaves short numbers alone and looks into nested input, numbers included", () => {
    expect(inventedNumber({ party: 4, time: "10:30", date: "2026-11-25" }, ["a table for four tomorrow"])).toBeUndefined();
    expect(inventedNumber({ order: { ids: [12345678] } }, ["where is my order?"])).toBe("12345678");
    expect(inventedNumber({ order: "A-12345678" }, ['{"ok":true,"order":"A-12345678"}'])).toBeUndefined();
  });
});

describe("followThroughTools", () => {
  it("offers only the agent's own tools that have not run: never end_call or another framework tool", () => {
    const tools = [
      { name: "request_callback", scope: "global" },
      { name: "lookup_order", scope: "global" },
      { name: "end_call", scope: "runtime" },
      { name: "skip_turn", scope: "runtime" },
    ];
    expect(followThroughTools(tools, new Set(["lookup_order"])).map((tool) => tool.name)).toEqual(["request_callback"]);
  });
});
