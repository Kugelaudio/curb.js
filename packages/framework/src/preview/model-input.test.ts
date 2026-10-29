import { describe, expect, it } from "vitest";
import type { LlmCallRecord } from "../llm/types.js";
import { callForReply, dateLineOf } from "./model-input.js";

const DATE = "Today is Saturday, 24 October 2026, 13:41 (Europe/Berlin). The next days: Sun 25 Oct";

function call(index: number, at: string, context = `<current_context skill="Home">\n${DATE}\nOpen tasks: none.\n</current_context>`): LlmCallRecord {
  return {
    index,
    at,
    input: {
      system: "You are helpful.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "user", content: context },
      ],
      tools: {},
    },
  };
}

describe("the model input behind a reply", () => {
  const trace = [call(0, "2026-10-24T11:41:00.000Z"), call(1, "2026-10-24T11:41:05.000Z"), call(2, "2026-10-24T11:42:00.000Z")];

  it("is the last call that started before the reply landed", () => {
    expect(callForReply(trace, Date.parse("2026-10-24T11:41:07.000Z"))?.index).toBe(1);
    expect(callForReply(trace, Date.parse("2026-10-24T11:41:00.000Z"))?.index).toBe(0);
    expect(callForReply(trace, Date.parse("2026-10-24T11:40:00.000Z"))).toBeNull();
  });

  it("falls back to the newest call for a reply without a time", () => {
    expect(callForReply(trace, undefined)?.index).toBe(2);
    expect(callForReply([], undefined)).toBeNull();
  });

  it("reads the date line the framework put first in the call's context", () => {
    expect(dateLineOf(trace[2])).toBe(DATE);
    expect(dateLineOf(call(3, "2026-10-24T11:43:00.000Z", "Hello"))).toBeNull();
    expect(dateLineOf(null)).toBeNull();
  });
});
