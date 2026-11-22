import { describe, expect, it, vi } from "vitest";

import { MAX_RECORDED_MESSAGE_BYTES, type CallReporter } from "../../hosted/call-reporter.js";
import { ToolEventPayload } from "../../hosted/protocol.js";
import type { ToolResult } from "../../types.js";
import {
  MAX_TOOL_RESULT_DATA_BYTES,
  MAX_TOOL_RESULT_MESSAGE_BYTES,
  reportTurnEvent,
  TOOL_RESULT_CUT_MARK,
} from "./turn-report.js";

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;

/** The payload of the tool event a call of `book_appointment` with `result` is reported as. */
function reportedTool(result: ToolResult | undefined, toolCall: { invalid?: string; heldFor?: string } = {}) {
  const event = vi.fn();
  reportTurnEvent({ event } as unknown as CallReporter, {
    type: "tool",
    toolCall: { id: "tool-1", name: "book_appointment", input: { day: "friday" }, skillPath: "/booking", ...toolCall },
    ok: result?.ok !== false,
    ...(result ? { result } : {}),
    durationMs: 12,
  });
  expect(event).toHaveBeenCalledExactlyOnceWith("tool", expect.anything(), 12);
  const payload = event.mock.calls[0]![1] as Record<string, unknown>;
  // What a runner writes is what the protocol says a tool event holds.
  expect(ToolEventPayload.safeParse(payload).success).toBe(true);
  return payload;
}

describe("a turn's record", () => {
  it("says where a caller got to in a procedure", () => {
    const reporter = { event: vi.fn() } as unknown as CallReporter;
    reportTurnEvent(reporter, { type: "procedure", action: "step_completed", title: "Claim", step: 2, steps: 3, stepTitle: "Evidence" });
    reportTurnEvent(reporter, { type: "procedure", action: "completed", title: "Claim", step: 3, steps: 3 });

    expect(reporter.event).toHaveBeenNthCalledWith(1, "procedure", { action: "step_completed", title: "Claim", step: 2, steps: 3, stepTitle: "Evidence" });
    expect(reporter.event).toHaveBeenNthCalledWith(2, "procedure", { action: "completed", title: "Claim", step: 3, steps: 3 });
  });

  it("says what a tool answered: its message, and its data while that is small", () => {
    expect(reportedTool({ ok: true, message: "Booked: Friday at 10:00.", data: { reference: "A-1042" } })).toEqual({
      name: "book_appointment",
      arguments: { day: "friday" },
      ok: true,
      skillPath: "/booking",
      result: { message: "Booked: Friday at 10:00.", data: { reference: "A-1042" } },
    });
  });

  it("says why a tool refused or failed, and why a call did not run", () => {
    expect(reportedTool({ ok: false, message: "That slot is taken." })).toMatchObject({ ok: false, result: { message: "That slot is taken." } });
    const unknown = 'Unknown tool "book_appointment". Call only the tools you currently have.';
    expect(reportedTool({ ok: false, message: unknown }, { invalid: unknown })).toMatchObject({ ok: false, result: { message: unknown } });
  });

  it("keeps the event as it was for a result that says nothing, and for a turn that reports none", () => {
    const before = { name: "book_appointment", arguments: { day: "friday" }, ok: true, skillPath: "/booking" };
    expect(reportedTool({ ok: true })).toEqual(before);
    expect(reportedTool({ ok: true, message: "" })).toEqual(before);
    expect(reportedTool(undefined)).toEqual(before);
  });

  it("cuts a long message at its limit with a marker, never inside a character", () => {
    const long = reportedTool({ ok: true, message: "ä".repeat(MAX_TOOL_RESULT_MESSAGE_BYTES) }).result as { message: string; truncated?: boolean };
    expect(long.truncated).toBe(true);
    expect(long.message.endsWith(TOOL_RESULT_CUT_MARK)).toBe(true);
    expect(long.message).not.toContain("\uFFFD");
    expect(bytes(long.message)).toBeLessThanOrEqual(MAX_TOOL_RESULT_MESSAGE_BYTES);
    expect(bytes(long.message)).toBeGreaterThan(MAX_TOOL_RESULT_MESSAGE_BYTES - 4);
    // A message of exactly the limit is kept whole.
    const whole = "a".repeat(MAX_TOOL_RESULT_MESSAGE_BYTES);
    expect(reportedTool({ ok: true, message: whole }).result).toEqual({ message: whole });
  });

  it("leaves large data out and says so, so one large result cannot bloat an event", () => {
    const small = { slots: ["x".repeat(MAX_TOOL_RESULT_DATA_BYTES - 14)] };
    expect(bytes(small)).toBe(MAX_TOOL_RESULT_DATA_BYTES);
    expect(reportedTool({ ok: true, data: small }).result).toEqual({ data: small });

    const rows = Array.from({ length: 5_000 }, (_, index) => ({ id: index, note: "x".repeat(200) }));
    const payload = reportedTool({ ok: true, message: "m".repeat(1_000_000), data: rows });
    expect(payload.result).toEqual({ message: expect.stringMatching(/… \[truncated\]$/), truncated: true });
    // Message and data together stay inside what the record keeps of one message's payload.
    expect(MAX_TOOL_RESULT_MESSAGE_BYTES + MAX_TOOL_RESULT_DATA_BYTES).toBeLessThan(MAX_RECORDED_MESSAGE_BYTES);
    expect(bytes(payload)).toBeLessThan(MAX_RECORDED_MESSAGE_BYTES);
  });

  it("leaves out data that is not JSON, and keeps a copy of data that is", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(reportedTool({ ok: true, message: "Done.", data: loop }).result).toEqual({ message: "Done.", truncated: true });
    const data = { seats: 2 };
    const kept = (reportedTool({ ok: true, data }).result as { data: unknown }).data;
    expect(kept).toEqual(data);
    expect(kept).not.toBe(data);
  });
});
