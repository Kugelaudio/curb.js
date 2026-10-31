import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentSiteRuntime, type TransferEndedOption } from "./index.js";
import {
  checkTransferEndedOption,
  decideTransferEnded,
  moveTrackedTransfer,
  trackTransfer,
  untrackTransfer,
} from "./transfer-ended.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const answered = { to: "+493012345678", transferId: "t-1" };

/** A runtime whose tracked transfer carries `onEnded`. */
function answeredWith(onEnded?: TransferEndedOption) {
  const runtime = new AgentSiteRuntime(<Agent />);
  trackTransfer(runtime.info, { ...answered, ...(onEnded === undefined ? {} : { onEnded }) });
  return runtime.info;
}

const errors = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("decideTransferEnded", () => {
  it("continues without an answered transfer, or one without onEnded", async () => {
    await expect(decideTransferEnded(new AgentSiteRuntime(<Agent />).info)).resolves.toEqual({ action: "continue" });
    await expect(decideTransferEnded(answeredWith())).resolves.toEqual({ action: "continue" });
  });

  it("applies a decision, its text trimmed", async () => {
    await expect(
      decideTransferEnded(answeredWith({ action: "end_call", goodbye: "  Thanks for calling, goodbye!  " })),
    ).resolves.toEqual({ action: "end_call", goodbye: "Thanks for calling, goodbye!" });
    await expect(decideTransferEnded(answeredWith({ action: "end_call" }))).resolves.toEqual({ action: "end_call" });
    await expect(
      decideTransferEnded(answeredWith({ action: "continue", instruction: "Ask whether the colleague could help." })),
    ).resolves.toEqual({ action: "continue", instruction: "Ask whether the colleague could help." });
  });

  it("asks a function with the transfer that ended, sync or async, and continues when it returns nothing", async () => {
    const seen: unknown[] = [];
    await expect(
      decideTransferEnded(
        answeredWith(async (ended) => {
          seen.push(ended);
          return { action: "end_call" };
        }),
      ),
    ).resolves.toEqual({ action: "end_call" });
    expect(seen).toEqual([answered]);
    await expect(decideTransferEnded(answeredWith(() => undefined))).resolves.toEqual({ action: "continue" });
  });

  it("applies a transfer's onEnded once", async () => {
    const info = answeredWith({ action: "end_call" });
    await expect(decideTransferEnded(info)).resolves.toEqual({ action: "end_call" });
    await expect(decideTransferEnded(info)).resolves.toEqual({ action: "continue" });
  });

  it("untracks only the transfer it names", async () => {
    const info = answeredWith({ action: "end_call" });
    untrackTransfer(info, "t-earlier");
    await expect(decideTransferEnded(info)).resolves.toEqual({ action: "end_call" });
    const untracked = answeredWith({ action: "end_call" });
    untrackTransfer(untracked, answered.transferId);
    await expect(decideTransferEnded(untracked)).resolves.toEqual({ action: "continue" });
  });

  it("moves a tracked transfer to the runtime a rewind rebuilt", async () => {
    const before = answeredWith({ action: "end_call" });
    const after = new AgentSiteRuntime(<Agent />).info;
    moveTrackedTransfer(before, after);
    await expect(decideTransferEnded(before)).resolves.toEqual({ action: "continue" });
    await expect(decideTransferEnded(after)).resolves.toEqual({ action: "end_call" });
  });

  it("continues and logs one line when the function throws, rejects or returns no decision", async () => {
    const spy = errors();
    const failing: TransferEndedOption[] = [
      () => {
        throw new Error("CRM down");
      },
      async () => {
        throw new Error("CRM down");
      },
      () => ({ action: "hang_up" }) as never,
      () => ({ action: "end_call", goodbye: " " }),
    ];
    for (const onEnded of failing) {
      await expect(decideTransferEnded(answeredWith(onEnded))).resolves.toEqual({ action: "continue" });
    }
    expect(spy).toHaveBeenCalledTimes(4);
    expect(String(spy.mock.calls[0]?.[0])).toContain("CRM down");
    expect(String(spy.mock.calls[2]?.[0])).toContain("not a decision");
  });

  it("continues when the function does not answer in time", async () => {
    const spy = errors();
    const info = answeredWith(() => new Promise(() => {}));
    await expect(decideTransferEnded(info, { timeoutMs: 10 })).resolves.toEqual({ action: "continue" });
    expect(String(spy.mock.calls[0]?.[0])).toContain("did not answer within 10 ms");
  });
});

describe("checkTransferEndedOption", () => {
  it("accepts nothing, a function and a decision", () => {
    expect(() => checkTransferEndedOption(undefined)).not.toThrow();
    expect(() => checkTransferEndedOption(() => undefined)).not.toThrow();
    expect(() => checkTransferEndedOption({ action: "end_call", goodbye: "Goodbye!" })).not.toThrow();
    expect(() => checkTransferEndedOption({ action: "continue" })).not.toThrow();
  });

  it("refuses anything else with a TypeError that names the shape", () => {
    const wrong = [
      { action: "hang_up" },
      { action: "end_call", goodbye: "  " },
      { action: "continue", instruction: 3 },
      // A key the action does not take would lose its text without a word.
      { action: "continue", goodbye: "Goodbye!" },
      { action: "end_call", goodby: "Goodbye!" },
      "end_call",
    ];
    for (const value of wrong) {
      expect(() => checkTransferEndedOption(value)).toThrow(/onEnded.*action: "end_call"/);
    }
  });
});
