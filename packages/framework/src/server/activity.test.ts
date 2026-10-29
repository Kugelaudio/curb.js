import { describe, expect, it, vi } from "vitest";
import { ServerActivity } from "./activity.js";

describe("ServerActivity", () => {
  it("counts live calls and running replies, and reports each change", () => {
    const onChange = vi.fn();
    const activity = new ServerActivity(onChange);
    const pageA = {};
    const pageB = {};

    activity.callStarted("curb-1");
    activity.turnRunning(pageA, true);
    activity.turnRunning(pageA, true); // the same reply again: no change
    activity.turnRunning(pageB, true);
    activity.turnRunning(pageA, false);
    activity.callEnded("curb-1");
    activity.turnRunning(pageB, false);

    expect(onChange.mock.calls.map(([counts]) => counts)).toEqual([
      { calls: 1, turns: 0, signIns: 0 },
      { calls: 1, turns: 1, signIns: 0 },
      { calls: 1, turns: 2, signIns: 0 },
      { calls: 1, turns: 1, signIns: 0 },
      { calls: 0, turns: 1, signIns: 0 },
      { calls: 0, turns: 0, signIns: 0 },
    ]);
  });

  it("never counts a call that ended before its start was counted", () => {
    const activity = new ServerActivity();
    activity.callEnded("curb-2");
    activity.callStarted("curb-2");
    expect(activity.counts()).toEqual({ calls: 0, turns: 0, signIns: 0 });
  });

  it("counts MCP sign-ins in progress, and reports only a change", () => {
    const onChange = vi.fn();
    const activity = new ServerActivity(onChange);
    activity.signInsInProgress(1);
    activity.signInsInProgress(1);
    activity.signInsInProgress(0);
    expect(onChange.mock.calls.map(([counts]) => counts)).toEqual([
      { calls: 0, turns: 0, signIns: 1 },
      { calls: 0, turns: 0, signIns: 0 },
    ]);
  });

  it("forgets a page that left while its reply ran", () => {
    const activity = new ServerActivity();
    const page = {};
    activity.turnRunning(page, true);
    activity.turnRunning(page, false);
    activity.turnRunning(page, false);
    expect(activity.counts()).toEqual({ calls: 0, turns: 0, signIns: 0 });
  });
});
