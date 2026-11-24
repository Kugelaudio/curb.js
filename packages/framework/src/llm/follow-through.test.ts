import { describe, expect, it } from "vitest";
import { followThroughTools, inventedNumber } from "./follow-through.js";

describe("inventedNumber: a check call fills no long number the conversation never had", () => {
  it("finds a phone number no one said, and passes one the caller said in any spacing", () => {
    expect(inventedNumber({ phone: "+1 123 456 789", topic: "claim" }, ["I'm Alex. How do callbacks work?"])).toBe(
      "+1 123 456 789",
    );
    expect(inventedNumber({ phone: "+1 555-0100 22" }, ["call me on 5550100 22"])).toBeUndefined();
    expect(inventedNumber({ phone: "555 0100" }, ["my number is 555 01 00"])).toBeUndefined();
  });

  it("reads a phone number whole, in common formats, and never joins numbers words keep apart", () => {
    for (const phone of ["+1 (202) 555-0142", "(030) 1234 56", "+49 30 123-456", "030/1234567"]) {
      expect(inventedNumber({ phone }, ["How do callbacks work?"])).toBe(phone);
    }
    expect(inventedNumber({ order: "123456" }, ["I bought 12 items and have 3456 points"])).toBe("123456");
    expect(inventedNumber({ phone: "+49 30 123-456" }, ["you can reach me at 030 123456"])).toBeUndefined();
    expect(inventedNumber({ phone: "030 123456" }, ["my number is +49 (30) 123456"])).toBeUndefined();
  });

  it("leaves dates, times and short numbers alone", () => {
    expect(inventedNumber({ day: "2026-11-25", at: "2026-11-25T10:00:00Z", de: "25.11.2026" }, ["tomorrow at ten"])).toBeUndefined();
  });

  it("leaves short numbers alone and looks into nested input, numbers included", () => {
    expect(inventedNumber({ party: 4, time: "10:30", date: "2026-11-25" }, ["a table for four tomorrow"])).toBeUndefined();
    expect(inventedNumber({ order: { ids: [12345678] } }, ["where is my order?"])).toBe("12345678");
    expect(inventedNumber({ order: "A-12345678" }, ['{"ok":true,"order":"A-12345678"}'])).toBeUndefined();
  });
});

describe("followThroughTools", () => {
  const tools = [
    { name: "request_callback", scope: "global" },
    { name: "lookup_order", scope: "global" },
    { name: "end_call", scope: "runtime" },
    { name: "skip_turn", scope: "runtime" },
  ];
  const offered = (ran: string[]) => followThroughTools(tools, new Set(ran)).map((tool) => tool.name);

  it("offers the agent's own tools that have not run, and no framework tool after a turn that only answered", () => {
    expect(offered([])).toEqual(["request_callback", "lookup_order"]);
  });

  it("offers end_call too once the turn ran one of the agent's own actions, never a tool that ran", () => {
    expect(offered(["lookup_order"])).toEqual(["request_callback", "end_call"]);
    expect(offered(["lookup_order", "request_callback"])).toEqual(["end_call"]);
  });
});
