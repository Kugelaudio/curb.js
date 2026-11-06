import { describe, expect, it, vi } from "vitest";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import { createS2sCallRecord } from "./call-record.js";

function reporter() {
  const turn = vi.fn();
  const record: CallReporter = { turn, event: vi.fn(), finish: async () => {}, undelivered: 0 };
  return { record, turns: () => turn.mock.calls.map(([entry]) => entry) };
}

describe("the record of a call on a speech-to-speech model", () => {
  it("reports a caller's turn once the model speaks, as the line its parts make", () => {
    const { record, turns } = reporter();
    const call = createS2sCallRecord(record);
    call.callerSaid("My order number is L M");
    call.callerSaid("My order number is L M 9 4 K");
    call.callerSaid("1.");
    expect(turns()).toEqual([]);
    call.agentSaid("Thanks.");
    expect(turns()).toEqual([
      { speaker: "caller", text: "My order number is L M 9 4 K 1.", final: true },
      { speaker: "agent", text: "Thanks.", final: true },
    ]);
  });

  it("reports the model's lines one by one, and a caller's turn still open when the call ends", () => {
    const { record, turns } = reporter();
    const call = createS2sCallRecord(record);
    call.agentSaid("Hello.");
    call.agentSaid("Anything else?");
    call.callerSaid("No, bye.");
    call.close();
    call.close();
    expect(turns().map((entry) => entry.text)).toEqual(["Hello.", "Anything else?", "No, bye."]);
  });

  it("keeps nothing when the call has no record", () => {
    const call = createS2sCallRecord(undefined);
    call.callerSaid("Hello.");
    expect(() => call.agentSaid("Hi.")).not.toThrow();
  });
});
