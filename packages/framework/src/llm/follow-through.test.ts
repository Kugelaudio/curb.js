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

  it("matches an order or account number only whole; a country code is left out only on a phone number", () => {
    expect(inventedNumber({ order: "99123456" }, ["my order is 123456"])).toBe("99123456");
    expect(inventedNumber({ account: "123456" }, ["my account is 99123456"])).toBe("123456");
    expect(inventedNumber({ order: "0123456" }, ["my order is 123456"])).toBe("0123456");
    expect(inventedNumber({ phone: "+49 171 2345678" }, ["my number is 0171 2345678"])).toBeUndefined();
    expect(inventedNumber({ phone: "+12 3456" }, ["room 3456"])).toBe("+12 3456");
  });

  it("only a field marked as a phone number may differ from a heard one by its country code or trunk zero", () => {
    const heard = ["my number is +49 30 1234567"];
    for (const digits of ["301234567", "0301234567", "030 1234567"]) {
      expect(inventedNumber({ account: digits }, heard)).toBe(digits);
      expect(inventedNumber({ phone: digits }, heard)).toBeUndefined();
    }
    expect(inventedNumber({ account: "+49 30 1234567" }, ["account 0301234567"])).toBe("+49 30 1234567");
    expect(inventedNumber({ phone: "+49 30 1234567" }, ["call me on 0301234567"])).toBeUndefined();
  });

  it("reads the phone marker from the tool's schema: a field's name, format or description", () => {
    const heard = ["my number is +49 30 1234567"];
    const schema = (property: Record<string, unknown>) => ({ type: "object", properties: { contact: { type: "string", ...property } } });
    expect(inventedNumber({ contact: "0301234567" }, heard, schema({ format: "tel" }))).toBeUndefined();
    expect(inventedNumber({ contact: "0301234567" }, heard, schema({ description: "The caller's phone number" }))).toBeUndefined();
    expect(inventedNumber({ contact: "0301234567" }, heard, schema({ description: "The customer account" }))).toBe("0301234567");
    expect(inventedNumber({ contact: "0301234567" }, heard)).toBe("0301234567");
    expect(inventedNumber({ caller: { mobileNumber: "0301234567" } }, heard)).toBeUndefined();
  });

  it("counts the digits as written, leading zeros included", () => {
    expect(inventedNumber({ order: "012345" }, ["where is my order?"])).toBe("012345");
    expect(inventedNumber({ order: "000123" }, ["where is my order?"])).toBe("000123");
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
  const offered = (ran: string[], done = ran) =>
    followThroughTools(tools, new Set(ran), new Set(done)).map((tool) => tool.name);

  it("offers the agent's own tools that have not run, and no framework tool after a turn that only answered", () => {
    expect(offered([])).toEqual(["request_callback", "lookup_order"]);
  });

  it("offers end_call too once the turn ran one of the agent's own actions, never a tool that ran", () => {
    expect(offered(["lookup_order"])).toEqual(["request_callback", "end_call"]);
    expect(offered(["lookup_order", "request_callback"])).toEqual(["end_call"]);
  });

  it("a call that was rejected or failed is not offered again, and is no action that unlocks end_call", () => {
    expect(offered(["request_callback"], [])).toEqual(["lookup_order"]);
    expect(offered(["request_callback", "lookup_order"], ["lookup_order"])).toEqual(["end_call"]);
  });
});
