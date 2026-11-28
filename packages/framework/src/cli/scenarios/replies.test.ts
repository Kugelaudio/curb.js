import { describe, expect, it } from "vitest";
import type { ReplyRequest } from "../../testing/index.js";
import { changedPart, conversationReplies, scenarioReplies } from "./replies.js";
import type { SavedConversation } from "./types.js";

const request = (role: ReplyRequest["role"], changes: Partial<ReplyRequest["parts"]> = {}, messages: string[] = [], live = true): ReplyRequest => ({
  role,
  live,
  parts: { model: "m", settings: "s", system: "p", tools: "t", context: "c", ...changes },
  messages,
});

describe("what changed in a request the store could not answer", () => {
  it("names the parts that differ, the first message that differs, and who asked", () => {
    const before = request("agent", {}, ["user:a", "assistant:b"]);
    expect(changedPart(request("agent", { system: "q" }, ["user:a", "assistant:b"]), before, true)).toBe("system prompt changed");
    expect(changedPart(request("agent", { context: "d", tools: "u" }, ["user:a", "assistant:b"]), before, true)).toBe("tools and context changed");
    expect(changedPart(request("agent", {}, ["user:x", "assistant:b"]), before, true)).toBe("the caller's words changed");
    expect(changedPart(request("agent", {}, ["user:a", "tool:x"]), before, true)).toBe("a tool result changed");
    expect(changedPart(request("caller", {}, ["user:x"]), request("caller", {}, ["user:a"]), true)).toBe("caller: the agent's words changed");
    expect(changedPart(request("judge", {}, ["user:x"]), request("judge", {}, ["user:a"]), true)).toBe("transcript changed");
    expect(changedPart(request("agent", { model: "n", settings: "z", system: "q" }), request("agent"), true)).toBe("model, model settings and system prompt changed");
  });

  it("says when there is nothing to compare with, or nothing differs", () => {
    expect(changedPart(request("agent"), undefined, false)).toBe("no earlier run to compare with");
    expect(changedPart(request("agent"), undefined, true)).toBe("a request the earlier run did not make");
    expect(changedPart(request("agent"), request("agent"), true)).toBe("not in the reply store");
  });

  it("places the first live request in its turn and compares it with the same request of the earlier run", () => {
    const stored = request("agent", {}, ["user:a"], false);
    const replies = { stored: 1, live: 1, requests: [stored, request("agent", {}, ["user:a", "assistant:b", "user:x"])] };
    const before = [stored, request("agent", {}, ["user:a", "assistant:b", "user:c"])];
    const ends = [{ turn: 1, requests: 1 }, { turn: 2, requests: 2 }];
    expect(conversationReplies(replies, ends, before).from).toEqual({ turn: 2, role: "agent", changed: "the caller's words changed" });
    // After the last turn: the judge.
    const judged = { stored: 2, live: 1, requests: [stored, { ...stored }, request("judge", { system: "j" })] };
    expect(conversationReplies(judged, ends, [stored, stored, request("judge")]).from).toEqual({ turn: null, role: "judge", changed: "system prompt changed" });
  });
});

describe("a scenario's replies line", () => {
  const conversation = (run: number, replies: SavedConversation["replies"]) => ({ scenario: { run }, replies }) as SavedConversation;

  it("is stored, the first run that went live, or how many runs did", () => {
    expect(scenarioReplies([conversation(1, { stored: 3, live: 0 })])).toEqual({ stored: 3, live: 0, summary: "stored" });
    const from = { turn: 2, role: "agent" as const, changed: "context changed" };
    expect(scenarioReplies([conversation(2, { stored: 1, live: 2, from }), conversation(1, { stored: 3, live: 0 }), conversation(3, { stored: 0, live: 3, from: { ...from, turn: 1 } })])).toEqual({
      stored: 4,
      live: 5,
      summary: "live from turn 2 (context changed) in 2 of 3 runs",
    });
    expect(scenarioReplies([conversation(1, undefined)])).toBeUndefined();
    // The agent's opening is turn 0; after the last turn, the judge or the end of the call.
    const at = (turn: number | null, role: "agent" | "judge" = "agent") => scenarioReplies([conversation(1, { stored: 0, live: 1, from: { turn, role, changed: "tools changed" } })])!.summary;
    expect(at(0)).toBe("live from the opening (tools changed)");
    expect(at(null, "judge")).toBe("live from the judge (tools changed)");
    expect(at(null)).toBe("live from the end of the call (tools changed)");
  });
});
