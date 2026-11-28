import { describe, expect, it } from "vitest";
import { FOLLOW_THROUGH_CHECK, followThroughActions, followThroughTools, inventedNumber } from "./follow-through.js";

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

  it("two phone numbers that both carry a country code match only in full", () => {
    expect(inventedNumber({ phone: "+49 40 1234567" }, ["my number is +49 30 1234567"])).toBe("+49 40 1234567");
    expect(inventedNumber({ phone: "+44 30 1234567" }, ["my number is +49 30 1234567"])).toBe("+44 30 1234567");
    expect(inventedNumber({ phone: "040 1234567" }, ["my number is +49 30 1234567"])).toBe("040 1234567");
    expect(inventedNumber({ phone: "+49 (30) 123-4567" }, ["my number is +49 30 1234567"])).toBeUndefined();
  });

  it("a country code is only the group written after the plus: no other digit is dropped", () => {
    expect(inventedNumber({ phone: "091234567" }, ["my number is +49 89 1234567"])).toBe("091234567");
    expect(inventedNumber({ phone: "089 1234567" }, ["my number is +49 89 1234567"])).toBeUndefined();
    expect(inventedNumber({ phone: "+49 89 1234567" }, ["call me on 089 1234567"])).toBeUndefined();
    expect(inventedNumber({ phone: "+49 89 1234567" }, ["call me on 09 1234567"])).toBe("+49 89 1234567");
    expect(inventedNumber({ phone: "0891234567" }, ["my number is +49891234567"])).toBe("0891234567");
  });

  it("the phone marker names the value itself: a parent object or a phone-plan id does not make a field a phone number", () => {
    const heard = ["my number is +49 30 1234567"];
    expect(inventedNumber({ phoneContact: { account: "0301234567" } }, heard)).toBe("0301234567");
    expect(inventedNumber({ phoneAccountId: "0301234567" }, heard)).toBe("0301234567");
    const plan = { type: "object", properties: { plan: { type: "string", description: "Account ID for the caller's phone plan" } } };
    expect(inventedNumber({ plan: "0301234567" }, heard, plan)).toBe("0301234567");
    expect(inventedNumber({ contact: { phone: "0301234567" } }, heard)).toBeUndefined();
    expect(inventedNumber({ phones: ["0301234567"] }, heard)).toBeUndefined();
  });

  it("reads the phone marker from a field's name or its schema's format, never its description", () => {
    const heard = ["my number is +49 30 1234567"];
    const schema = (property: Record<string, unknown>) => ({ type: "object", properties: { contact: { type: "string", ...property } } });
    expect(inventedNumber({ contact: "0301234567" }, heard, schema({ format: "tel" }))).toBeUndefined();
    expect(inventedNumber({ contact: "0301234567" }, heard, schema({ description: "The caller's phone number" }))).toBe("0301234567");
    expect(
      inventedNumber({ reference: "0301234567" }, heard, {
        type: "object",
        properties: { reference: { type: "string", description: "Account ID associated with the caller's phone number" } },
      }),
    ).toBe("0301234567");
    expect(inventedNumber({ contact: "0301234567" }, heard, schema({ description: "The customer account" }))).toBe("0301234567");
    expect(inventedNumber({ contact: "0301234567" }, heard)).toBe("0301234567");
    expect(inventedNumber({ caller: { mobileNumber: "0301234567" } }, heard)).toBeUndefined();
  });

  it.each(["anyOf", "oneOf"])("applies phone matching only to the telephone branch of %s", (union) => {
    const schema = {
      type: "object",
      properties: { value: { [union]: [{ type: "string", format: "tel" }, { type: "integer" }] } },
    };
    expect(inventedNumber({ value: "123456789" }, ["Order 123456789"], schema)).toBe("123456789");
    expect(inventedNumber({ value: "123456789" }, ["My phone number is 123456789"], schema)).toBeUndefined();
    expect(inventedNumber({ value: 123456789 }, ["Order 123456789"], schema)).toBeUndefined();
  });

  it("allows generic matching when a union also accepts an unformatted string", () => {
    const schema = {
      type: "object",
      properties: { value: { anyOf: [{ type: "string", format: "tel" }, { type: "string" }] } },
    };
    expect(inventedNumber({ value: "123456789" }, ["Order 123456789"], schema)).toBeUndefined();
  });

  it("counts the digits as written, leading zeros included", () => {
    expect(inventedNumber({ order: "012345" }, ["where is my order?"])).toBe("012345");
    expect(inventedNumber({ order: "000123" }, ["where is my order?"])).toBe("000123");
  });

  it("a phone field holds a phone number the conversation gave, never a short or made-up value", () => {
    expect(inventedNumber({ phone: "000", topic: "callbacks" }, ["How do callbacks work?"])).toBe("000");
    expect(inventedNumber({ phone: "17:20" }, ["It is 17:20. How fast is the setup?"])).toBe("17:20");
    expect(inventedNumber({ phone: "unknown" }, ["How do callbacks work?"])).toBe("unknown");
    expect(inventedNumber({ topic: "000" }, ["How do callbacks work?"])).toBeUndefined();
    expect(inventedNumber({ phone: "0171 2345678" }, ["my number is 0171 2345678"])).toBeUndefined();
  });

  it("a phone field holds a phone number and nothing else, never a value that only contains one", () => {
    const heard = ["my number is 030 1234567"];
    expect(inventedNumber({ phone: "unknown (030 1234567)" }, heard)).toBe("unknown (030 1234567)");
    expect(inventedNumber({ phone: "030 1234567 or later" }, heard)).toBe("030 1234567 or later");
    expect(inventedNumber({ phone: "   " }, heard)).toBe("   ");
    expect(inventedNumber({ phone: "" }, heard)).toBe("");
    expect(inventedNumber({ phones: ["030 1234567", "call me"] }, heard)).toBe("call me");
    expect(inventedNumber({ phone: " 030 1234567 " }, heard)).toBeUndefined();
    expect(inventedNumber({ phone: "(030) 123 45 67" }, heard)).toBeUndefined();
  });

  it("a heard number backs a phone field only where it was given as a phone number, never as an id", () => {
    expect(inventedNumber({ phone: "12345678" }, ["my order number is 12345678"])).toBe("12345678");
    expect(inventedNumber({ phone: "12345678" }, ["my phone number is 12345678"])).toBeUndefined();
    expect(inventedNumber({ order: "12345678" }, ["my order number is 12345678"])).toBeUndefined();
    expect(inventedNumber({ phone: "12345678" }, ["12345678 is my order number"])).toBe("12345678");
    expect(inventedNumber({ phone: "12345678" }, ["Alex Doe, 12345678, about my claim"])).toBe("12345678");
    expect(inventedNumber({ phone: "0301234567" }, ["Kundennummer 0301234567"])).toBe("0301234567");
    expect(inventedNumber({ phone: "0301234567" }, ["Telefonnummer 0301234567"])).toBeUndefined();
    expect(inventedNumber({ phone: "0301234567" }, ["my contract 0301234567"])).toBe("0301234567");
    // Without a word around it, a number written like a phone number (country code or trunk zero) is one.
    expect(inventedNumber({ phone: "030 1234567" }, ["Alex Doe, +49 30 1234567"])).toBeUndefined();
    expect(inventedNumber({ phone: "030 1234567" }, ["Alex Doe, 030 1234567"])).toBeUndefined();
    // A tool result: the key says what the value is.
    expect(inventedNumber({ phone: "030 1234567" }, [{ ok: true, order: "0301234567" }])).toBe("030 1234567");
    expect(inventedNumber({ phone: "030 1234567" }, ['{"ok":true,"order":"0301234567"}'])).toBe("030 1234567");
    expect(inventedNumber({ phone: "12345678" }, [{ ok: true, customer: { phone: "12345678" } }])).toBeUndefined();
  });

  it("in a tool result only a value under a phone key backs a phone field, whatever the value looks like", () => {
    expect(inventedNumber({ phone: "0301234567" }, [{ ok: true, customerNumber: "0301234567" }])).toBe("0301234567");
    expect(inventedNumber({ phone: "+49 30 1234567" }, [{ ok: true, ref: "+49 30 1234567" }])).toBe("+49 30 1234567");
    expect(inventedNumber({ phone: "0301234567" }, [{ ok: true, note: "call 0301234567" }])).toBe("0301234567");
    expect(inventedNumber({ phone: "0301234567" }, [{ ok: true, phone: "0301234567" }])).toBeUndefined();
    expect(inventedNumber({ customerNumber: "0301234567" }, [{ ok: true, customerNumber: "0301234567" }])).toBeUndefined();
  });

  it("an id label on either side of a number wins over callback words: it is never phone evidence", () => {
    expect(inventedNumber({ phone: "12345678" }, ["Please call me about 12345678, my order number"])).toBe("12345678");
    expect(inventedNumber({ phone: "0301234567" }, ["call me back, 0301234567 is my customer number"])).toBe("0301234567");
    expect(inventedNumber({ phone: "12345678" }, ["Please call me on 12345678, my phone number"])).toBeUndefined();
    // A label after the digits that names the next number is that number's label.
    expect(inventedNumber({ phone: "030 1234567" }, ["call me on 030 1234567 and my order is 12345678"])).toBeUndefined();
    expect(inventedNumber({ phone: "12345678" }, ["call me on 030 1234567 and my order is 12345678"])).toBe("12345678");
    // A later time or number does not take the label from the number it follows.
    expect(inventedNumber({ phone: "12345678" }, ["call me about 12345678, my order number, before 17:20"])).toBe("12345678");
    expect(inventedNumber({ phone: "12345678" }, ["call me about 12345678, my order number, ref 99887766"])).toBe("12345678");
    expect(inventedNumber({ phone: "12345678" }, ["call me about 12345678 at 9, my order number"])).toBe("12345678");
  });

  it("leaves dates, times and short numbers alone", () => {
    expect(inventedNumber({ day: "2026-11-25", at: "2026-11-25T10:00:00Z", de: "25.11.2026" }, ["tomorrow at ten"])).toBeUndefined();
  });

  it("leaves a date alone only when it is a real calendar day", () => {
    for (const date of ["2028-02-29", "29.02.2028", "31.12.26", "25/11/2026", "11/25/2026", "1/2/26"]) {
      expect(inventedNumber({ date }, ["tomorrow"]), date).toBeUndefined();
    }
    for (const id of ["1234-56-78", "2026-02-30", "2027-02-29", "32.01.2026", "25.13.2026", "13/13/2026", "00/12/2026"]) {
      expect(inventedNumber({ id }, ["where is my order?"]), id).toBe(id);
    }
  });

  it("leaves short numbers alone and looks into nested input, numbers included", () => {
    expect(inventedNumber({ party: 4, time: "10:30", date: "2026-11-25" }, ["a table for four tomorrow"])).toBeUndefined();
    expect(inventedNumber({ order: { ids: [12345678] } }, ["where is my order?"])).toBe("12345678");
    expect(inventedNumber({ order: "A-12345678" }, ['{"ok":true,"order":"A-12345678"}'])).toBeUndefined();
  });
});

describe("followThroughActions and followThroughTools", () => {
  const tools = [
    { name: "request_callback", scope: "global" },
    { name: "lookup_order", scope: "global" },
    { name: "end_call", scope: "runtime" },
    { name: "skip_turn", scope: "runtime" },
  ];
  const runs = (ran: string[], done = ran) =>
    followThroughActions(tools, new Set(ran), new Set(done)).map((tool) => tool.name);
  const offered = (ran: string[], done = ran) =>
    followThroughTools(tools, new Set(ran), new Set(done)).map((tool) => tool.name);

  it("runs the agent's own tools that have not run, and no framework tool after a turn that only answered", () => {
    expect(runs([])).toEqual(["request_callback", "lookup_order"]);
  });

  it("runs end_call too once the turn ran one of the agent's own actions, never a tool that ran", () => {
    expect(runs(["lookup_order"])).toEqual(["request_callback", "end_call"]);
    expect(runs(["lookup_order", "request_callback"])).toEqual(["end_call"]);
    expect(runs(["lookup_order", "end_call"])).toEqual(["request_callback"]);
  });

  it("a call that was rejected or failed is not run again, and is no action that unlocks end_call", () => {
    expect(runs(["request_callback"], [])).toEqual(["lookup_order"]);
    expect(runs(["request_callback", "lookup_order"], ["lookup_order"])).toEqual(["end_call"]);
  });

  it("always offers end_call, the answer to a reply that only says goodbye, and never a tool that ran", () => {
    expect(offered([])).toEqual(["request_callback", "lookup_order", "end_call"]);
    expect(offered(["request_callback"], [])).toEqual(["lookup_order", "end_call"]);
    expect(offered(["lookup_order", "end_call"])).toEqual(["request_callback", "end_call"]);
    expect(offered([], []).filter((name) => !runs([]).includes(name))).toEqual(["end_call"]);
  });

  it("tells the check that a goodbye calls end_call alone and that an earlier turn's action is done", () => {
    expect(FOLLOW_THROUGH_CHECK).toContain("for it call end_call alone, never another tool");
    expect(FOLLOW_THROUGH_CHECK).toContain("An action an earlier turn took is done: never call it again.");
    expect(FOLLOW_THROUGH_CHECK).not.toContain("A goodbye is an action");
  });
});
