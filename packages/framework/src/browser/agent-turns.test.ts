import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../llm/types.js";
import { AgentTurns, turnOf, type AgentSocket, type TurnHost } from "./agent-turns.js";

/** A socket to a scripted agent server: `script` answers each frame the turn sends. */
function fakeSocket(onSend: (frame: { type: string; text?: string }, push: (frame: object) => void) => void) {
  const listeners: Record<string, Array<(event: never) => void>> = {};
  const push = (frame: object) => setTimeout(() => listeners.message?.forEach((listener) => listener({ data: JSON.stringify(frame) } as never)));
  const socket = {
    send: (data: string) => onSend(JSON.parse(data), push),
    close: () => {},
    addEventListener: (type: string, listener: (event: never) => void) => void (listeners[type] ??= []).push(listener),
  } as unknown as AgentSocket;
  return { socket, push };
}

const transcript: AgentChatMessage[] = [
  { role: "user", content: "earlier" },
  { role: "assistant", content: "old reply" },
  { role: "user", content: "book a table" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "book", input: { seats: 2 } }] },
  { role: "tool", content: "booked", toolCallId: "c1", toolName: "book", result: { ok: true, data: { table: 4 } }, contextDiff: [] },
  { role: "assistant", content: "Booked table 4." },
];

describe("agent turns", () => {
  it("takes the reply and tool calls after the turn's own user message", () => {
    expect(turnOf(transcript, "book a table")).toEqual({
      reply: "Booked table 4.",
      toolCalls: [{ name: "book", input: { seats: 2 }, output: { ok: true, data: { table: 4 } } }],
    });
  });

  it("sends the text once the connection is set up and answers when the turn stops", async () => {
    const paths: string[] = [];
    let current: ReturnType<typeof fakeSocket> | null = null;
    const host: TurnHost = {
      openAgentSocket(path) {
        paths.push(path);
        current = fakeSocket((frame, push) => {
          expect(frame).toEqual({ type: "user_text", text: "book a table" });
          push({ type: "running", value: true });
          push({ type: "messages", messages: transcript });
          push({ type: "running", value: false });
        });
        current.push({ type: "agents", agents: ["agent"], active: {} });
        current.push({ type: "conversations", active: "a", conversations: [] });
        return current.socket;
      },
      diagnostics: async () => ({ serving: true, diagnostics: [] }),
      lastConversationId: () => 3,
      recordedConversation: async (_text, after) => after + 1,
    };
    const turns = new AgentTurns(host);
    expect(await turns.say("book a table", false)).toEqual({
      reply: "Booked table 4.",
      toolCalls: [{ name: "book", input: { seats: 2 }, output: { ok: true, data: { table: 4 } } }],
      conversationId: 4,
      errors: [],
    });
    await turns.say("book a table", false);
    await turns.say("book a table", true);
    expect(paths).toEqual(["/", "/?resume=4", "/"]);
  });

  it("answers why the agent is not running instead of waiting", async () => {
    const host: TurnHost = {
      openAgentSocket() {
        const { socket, push } = fakeSocket(() => {});
        push({ type: "agent_unavailable", message: "src/agent/agent.tsx:3: syntax error", diagnostics: [] });
        return socket;
      },
      diagnostics: async () => ({ serving: true, diagnostics: [] }),
      lastConversationId: () => 0,
      recordedConversation: async () => null,
    };
    await expect(new AgentTurns(host).say("hi", true)).rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("passes check only when the agent serves with no authoring error", async () => {
    const diagnostic = {
      code: "AGENT_LITERAL_DATE",
      severity: "warning" as const,
      message: "A literal date.",
      location: { source: "src/agent/agent.tsx", line: 5 },
      fix: "Use the date helper.",
    };
    const make = (answer: Awaited<ReturnType<TurnHost["diagnostics"]>>) =>
      new AgentTurns({ openAgentSocket: () => ({}) as AgentSocket, diagnostics: async () => answer, lastConversationId: () => 0, recordedConversation: async () => null });
    const passed = await make({ serving: true, diagnostics: [diagnostic as never] }).check();
    expect(passed).toMatchObject({ passed: true, diagnostics: [{ code: "AGENT_LITERAL_DATE", location: "src/agent/agent.tsx:5", fix: "Use the date helper." }] });
    const down = await make({ serving: false, message: "it does not compile", diagnostics: [] }).check();
    expect(down.passed).toBe(false);
    expect(down.output).toContain("does not load: it does not compile");
  });
});
