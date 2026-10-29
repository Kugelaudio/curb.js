import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../../llm/types.js";
import { replayTimeForMessage, type RecordingWindow } from "./conversation-recording.js";

const windows: RecordingWindow[] = [
  { room: "room-a", startedAt: 1_000, endedAt: 11_000, offsetMs: 0, durationMs: 10_000 },
  { room: "room-b", startedAt: 21_000, endedAt: 26_000, offsetMs: 10_000, durationMs: 5_000 },
];

describe("replayTimeForMessage", () => {
  it("maps messages inside a call to the combined seek timeline", () => {
    const message: AgentChatMessage = { role: "user", content: "hello", at: 6_000 };
    expect(replayTimeForMessage(message, windows)).toBe(5_000);
  });

  it("uses the message's audio room when wall-clock timestamps drift", () => {
    const message: AgentChatMessage = {
      role: "assistant",
      content: "hello",
      at: 23_500,
      audio: { room: "room-b", role: "assistant", ordinals: [0] },
    };
    expect(replayTimeForMessage(message, windows)).toBe(12_500);
  });

  it("collapses gaps between separate calls", () => {
    const between: AgentChatMessage = { role: "user", content: "typed", at: 16_000 };
    const after: AgentChatMessage = { role: "assistant", content: "done", at: 30_000 };
    expect(replayTimeForMessage(between, windows)).toBe(10_000);
    expect(replayTimeForMessage(after, windows)).toBe(15_000);
  });
});
