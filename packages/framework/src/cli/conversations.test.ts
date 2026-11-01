import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../server/conversation-store.js";
import { conversationsCommand, parseConversationsArgs } from "./conversations.js";

let root: string;
const at = Date.parse("2026-10-27T23:30:00Z");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "curb-conversations-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function record(): Promise<void> {
  mkdirSync(join(root, ".data"));
  const store = new ConversationStore(join(root, ".data", "conversations.jsonl"));
  const first = await store.startConversation("agent", {});
  await store.recordMessage(first, 0, { role: "user", content: "Is the dentist open on Saturday?", at });
  await store.recordMessage(first, 1, {
    role: "assistant",
    content: "",
    at: at + 1_000,
    toolCalls: [{ id: "call-1", name: "lookup_hours", input: { day: "saturday" } }],
  });
  await store.recordMessage(first, 2, {
    role: "tool",
    content: "",
    at: at + 1_100,
    toolCallId: "call-1",
    toolName: "lookup_hours",
    result: { ok: false, message: "no hours for saturday" },
    contextDiff: [],
  });
  await store.recordMessage(first, 3, { role: "assistant", content: "Sorry, I could not find that.", at: at + 2_000 });
  const second = await store.startConversation("agent", {});
  await store.recordMessage(second, 0, { role: "user", content: "Hello", at: at + 60_000 });
  store.close();
}

describe("curb conversations", () => {
  it("prints each conversation with its tool calls and results, newest last", async () => {
    await record();
    const lines: string[] = [];
    expect(conversationsCommand([], root, (line) => lines.push(line), {})).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("caller Is the dentist open on Saturday?");
    expect(text).toContain('call lookup_hours {"day":"saturday"}');
    expect(text).toContain("tool lookup_hours ->");
    expect(text).toContain("no hours for saturday");
    expect(text.indexOf("conversation 1,")).toBeLessThan(text.indexOf("conversation 2,"));
  });

  it("selects one conversation, or the last n, and answers JSON unclipped", async () => {
    await record();
    const lines: string[] = [];
    conversationsCommand(["--id", "1", "--json"], root, (line) => lines.push(line), {});
    const parsed = JSON.parse(lines[0]!) as { conversations: Array<{ id: number; messages: unknown[] }> };
    expect(parsed.conversations.map((c) => [c.id, c.messages.length])).toEqual([[1, 4]]);

    const last: string[] = [];
    conversationsCommand(["--last", "1"], root, (line) => last.push(line), {});
    expect(last.join("\n")).toContain("conversation 2,");
    expect(last.join("\n")).not.toContain("conversation 1,");
  });

  it("says so when nothing was recorded, without creating the file", () => {
    const lines: string[] = [];
    expect(conversationsCommand([], root, (line) => lines.push(line), {})).toBe(0);
    expect(lines[0]).toMatch(/No conversations recorded yet/);
    expect(lines[0]).toMatch(/curb say and curb test are not recorded/);
    expect(existsSync(join(root, ".data", "conversations.jsonl"))).toBe(false);
  });

  it("refuses an unknown flag or a bad number", () => {
    expect(parseConversationsArgs(["--since", "1d"])).toBeInstanceOf(Error);
    expect(parseConversationsArgs(["--last", "0"])).toBeInstanceOf(Error);
    expect(parseConversationsArgs(["--last", "5", "--json"])).toEqual({ last: 5, id: null, json: true });
  });
});
