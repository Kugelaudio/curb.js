import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../llm/types.js";
import { conversationTurns, lastCallOf, newestReplyIndex, nextCallerMessage, turnReply } from "./conversation-turns.js";

const slots = { slots: ["2026-10-27T10:00:00+01:00", "2026-10-27T14:30:00+01:00"] };

/** The mockup's conversation: the agent reads a skill and calls a tool before it answers. */
const transcript: AgentChatMessage[] = [
  { role: "assistant", content: "Hi, what would you like to talk about?" },
  { role: "user", content: "Do you have time next week?" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_skill", input: { skill: "/booking" } }] },
  { role: "tool", content: "", toolCallId: "c1", toolName: "read_skill", result: { ok: true }, contextDiff: [] },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c2", name: "find_free_slots", input: { date: "2026-10-27" } }],
  },
  {
    role: "tool",
    content: "",
    toolCallId: "c2",
    toolName: "find_free_slots",
    result: { ok: true, data: slots },
    contextDiff: [],
  },
  { role: "assistant", content: "I have Tuesday at 10:00 or 14:30." },
];

describe("the conversation's turns", () => {
  it("shows one agent turn per answer, with what it did in order and the outcome of each call", () => {
    const turns = conversationTurns(transcript);

    expect(turns.map((turn) => turn.kind)).toEqual(["agent", "caller", "agent"]);
    const answer = turns[2];
    if (answer.kind !== "agent") throw new Error("expected an agent turn");
    expect(
      answer.items.map((item) => (item.kind === "tool" ? `${item.tool.call.name}:${item.tool.status}` : "text")),
    ).toEqual(["read_skill:ok", "find_free_slots:ok", "text"]);
    const call = answer.items[1];
    expect(call.kind === "tool" && call.tool.result?.result.data).toEqual(slots);
  });

  it("marks a call held for the caller's yes, a failed one and one still running", () => {
    const turns = conversationTurns([
      { role: "user", content: "Book it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "h", name: "book_meeting", input: {}, heldFor: "Shall I book Tuesday at 10?", invalid: "held" },
          { id: "f", name: "find_free_slots", input: {} },
          { id: "p", name: "notify", input: {} },
        ],
      },
      { role: "tool", content: "", toolCallId: "h", toolName: "book_meeting", result: { ok: false }, contextDiff: [] },
      {
        role: "tool",
        content: "",
        toolCallId: "f",
        toolName: "find_free_slots",
        result: { ok: false, message: "Calendar unavailable." },
        contextDiff: [],
      },
    ]);

    const agent = turns[1];
    if (agent.kind !== "agent") throw new Error("expected an agent turn");
    expect(agent.items.map((item) => item.kind === "tool" && item.tool.status)).toEqual(["held", "failed", "pending"]);
  });

  it("hides input the caller did not write, but never merges two answers into one turn", () => {
    const turns = conversationTurns([
      { role: "assistant", content: "Are you still there?" },
      { role: "user", kind: "synthetic", content: "(silence)" },
      { role: "assistant", content: "I'll wait." },
    ]);

    expect(turns.map((turn) => turn.kind)).toEqual(["agent", "agent"]);
  });

  it("finds the newest reply, the caller's next message and the agent's last call of a tool", () => {
    expect(newestReplyIndex(transcript)).toBe(6);
    expect(nextCallerMessage(transcript, 0)).toEqual({ index: 1, text: "Do you have time next week?" });
    expect(nextCallerMessage(transcript, 6)).toBeNull();
    expect(lastCallOf(transcript, "find_free_slots")?.input).toEqual({ date: "2026-10-27" });
    expect(lastCallOf(transcript, "book_meeting")).toBeNull();
  });
});

describe("what a turn's actions act on", () => {
  const audio = (ordinals: number[]) => ({ room: "room-1", role: "assistant" as const, ordinals });

  it("reads everything the agent wrote in the turn as one reply, with all of its call audio", () => {
    const [turn] = conversationTurns([
      { role: "assistant", content: "Let me check.", audio: audio([1]) },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_skill", input: { skill: "/booking" } }] },
      { role: "tool", content: "", toolCallId: "c1", toolName: "read_skill", result: { ok: true }, contextDiff: [] },
      { role: "assistant", content: "Tuesday at 10:00 works.", audio: audio([2, 3]) },
    ]);
    const reply = turnReply(turn.kind === "agent" ? turn.items : []);
    expect(reply?.text).toBe("Let me check.\n\nTuesday at 10:00 works.");
    expect(reply?.audio).toEqual(audio([1, 2, 3]));
    expect(reply?.last.index).toBe(3);
  });

  it("speaks the words anew when part of the turn was typed, and has nothing for a turn without words", () => {
    const [turn] = conversationTurns([
      { role: "assistant", content: "Let me check.", audio: audio([1]) },
      { role: "assistant", content: "Tuesday at 10:00 works." },
    ]);
    expect(turnReply(turn.kind === "agent" ? turn.items : [])?.audio).toBeUndefined();
    expect(turnReply([])).toBeNull();
  });
});
