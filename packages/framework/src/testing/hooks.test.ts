import { describe, expect, it, vi } from "vitest";
import { defineAgent } from "../config.js";
import type { CallEvent } from "../hooks.js";
import { CallEvent as CallEventSchema } from "../hosted/protocol.js";
import { buildCallEvent, hookEvent, runHook } from "./hooks.js";

const App = () => null;

describe("buildCallEvent", () => {
  it("builds a valid event from nothing, the same every time", () => {
    const event = buildCallEvent("call.ended");
    expect(CallEventSchema.safeParse(event).success).toBe(true);
    expect(buildCallEvent("call.ended")).toEqual(event);
    expect(event).toMatchObject({ object: "event", type: "call.ended", data: { object: { object: "call", goals: null } } });
  });

  it("gives call.evaluated an array of goals, and each type its own id", () => {
    const event = buildCallEvent("call.evaluated");
    expect(event.data.object.goals).toEqual([]);
    expect(event.id).not.toBe(buildCallEvent("call.ended").id);
  });

  it("keeps the fields it is given, and carries livemode to the event", () => {
    const event = buildCallEvent("call.evaluated", {
      status: "failed",
      livemode: true,
      goals: [{ name: "booked", status: "reached", detail: null }],
    });
    expect(event.livemode).toBe(true);
    expect(event.data.object).toMatchObject({ status: "failed", livemode: true, goals: [{ name: "booked" }] });
  });

  it("follows a call that stores nothing with what the platform sends for one", () => {
    expect(buildCallEvent("call.ended", { content: "not_stored" }).data.object).toMatchObject({
      content: "not_stored",
      transcript: null,
      call_data: [],
    });
  });

  it("follows a truncated transcript with a null one", () => {
    expect(buildCallEvent("call.ended", { transcript_truncated: true }).data.object.transcript).toBeNull();
  });

  it("refuses what no real call would produce, rather than fixing it up", () => {
    const goal = { name: "booked", status: "reached", detail: null } as const;
    expect(() => buildCallEvent("call.ended", { goals: [goal] })).toThrow("goals is null on call.ended");
    expect(() => buildCallEvent("call.evaluated", { goals: null })).toThrow("goals is an array on call.evaluated");
    expect(() =>
      buildCallEvent("call.ended", { content: "not_stored", transcript: { complete: true, turns: [] } }),
    ).toThrow('content "not_stored" means transcript: null');
    expect(() =>
      buildCallEvent("call.ended", { transcript_truncated: true, transcript: { complete: true, turns: [] } }),
    ).toThrow("transcript_truncated means transcript: null");
    expect(() => buildCallEvent("call.ended", { status: "hung_up" as never })).toThrow("data.object.status");
  });
});

describe("hookEvent", () => {
  it("builds around a call object, for the event the hook receives", () => {
    expect(hookEvent("afterCall", { status: "failed" }).type).toBe("call.ended");
    expect(hookEvent("afterEvaluation").type).toBe("call.evaluated");
  });

  it("takes a whole event as it is", () => {
    const event = buildCallEvent("call.ended", { id: "another-call" });
    expect(hookEvent("afterCall", event)).toBe(event);
  });

  it("refuses the other hook's event", () => {
    expect(() => hookEvent("afterCall", buildCallEvent("call.evaluated"))).toThrow(
      "afterCall receives call.ended, and this event is call.evaluated",
    );
  });

  it("refuses a whole event that is not one", () => {
    expect(() => hookEvent("afterCall", { object: "event", type: "call.ended" } as CallEvent)).toThrow("not a call event");
  });
});

describe("runHook", () => {
  it("calls the agent's hook as a host would, and resolves with the event", async () => {
    const afterCall = vi.fn(async () => {});
    const agent = defineAgent({ app: App, afterCall });
    const event = await runHook(agent, "afterCall", { status: "failed" });
    expect(afterCall).toHaveBeenCalledWith(event.data.object, event);
    expect(event.data.object.status).toBe("failed");
  });

  it("rejects with what the hook threw", async () => {
    const boom = new Error("crm down");
    const agent = defineAgent({
      app: App,
      afterEvaluation: () => {
        throw boom;
      },
    });
    await expect(runHook(agent, "afterEvaluation")).rejects.toBe(boom);
  });

  it("refuses a hook the agent does not declare", async () => {
    await expect(runHook(defineAgent({ app: App }), "afterCall")).rejects.toThrow("declares no afterCall");
  });
});
