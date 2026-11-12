import { llm } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../../agent-session.js";
import type { AgentRunRequest, AgentRunResponse, AgentTurnStreamEvent } from "../../../llm/types.js";
import { createInsuranceDemoRuntime } from "../../../test-fixtures/insurance-runtime.js";
import type { CallReporter } from "../../../hosted/call-reporter.js";
import { CurbVoiceAgent } from "./curb-agent.js";

function userSaid(text: string): llm.ChatContext {
  const chat = new llm.ChatContext();
  chat.addMessage({ role: "user", content: text });
  return chat;
}

describe("hosted tool outcome reporting", () => {
  it.each([true, false])("preserves tool success=%s and its run time without reporting its result data", async (ok) => {
    const event = vi.fn();
    const reporter: CallReporter = { event, turn: vi.fn(), async finish() {}, undelivered: 0 };
    const agent = new CurbVoiceAgent({
      instructions: "Test agent",
      reporter,
      async *runTurn(): AsyncGenerator<AgentTurnStreamEvent> {
        yield { type: "tool", toolCall: { id: "tool-1", name: "add_task", input: { title: "Buy milk" }, skillPath: "/tasks" }, ok, durationMs: 41 };
        yield { type: "delta", delta: "Done.", text: "Done." };
      },
    });
    const chat = new llm.ChatContext();
    chat.addMessage({ role: "user", content: "Add buy milk to my tasks" });
    const stream = await agent.llmNode(chat, new llm.ToolContext(), {});
    expect(stream).not.toBeNull();
    const reader = stream!.getReader();
    while (!(await reader.read()).done) { /* Drain the real reporting path. */ }
    expect(event).toHaveBeenCalledExactlyOnceWith("tool", {
      name: "add_task", arguments: { title: "Buy milk" }, skillPath: "/tasks", ok,
    }, 41);
    expect(reporter.turn).toHaveBeenCalledExactlyOnceWith({ speaker: "agent", text: "Done.", final: true });
  });

  it("reports a call held for the caller's yes as held, with its read-back", async () => {
    const event = vi.fn();
    const reporter: CallReporter = { event, turn: vi.fn(), async finish() {}, undelivered: 0 };
    const readBack = "lisa@example.com, Tuesday 15:00: is that right?";
    const agent = new CurbVoiceAgent({
      instructions: "Test agent",
      reporter,
      async *runTurn(): AsyncGenerator<AgentTurnStreamEvent> {
        yield {
          type: "tool",
          toolCall: {
            id: "toolu_1",
            name: "book_meeting",
            input: { email: "lisa@example.com" },
            invalid: `Not run: held for the caller's yes to "${readBack}".`,
            heldFor: readBack,
          },
          ok: false,
        };
        yield { type: "delta", delta: readBack, text: readBack };
      },
    });
    const stream = await agent.llmNode(userSaid("Book Tuesday at three."), new llm.ToolContext(), {});
    const reader = stream!.getReader();
    while (!(await reader.read()).done) { /* Drain the real reporting path. */ }
    expect(event).toHaveBeenCalledExactlyOnceWith("tool", {
      name: "book_meeting", arguments: { email: "lisa@example.com" }, ok: false, heldFor: readBack,
    }, undefined); // Held, so it never ran and took no time.
  });
});

describe("turn cancellation and failures", () => {
  it("cancelling the reply stream aborts that reply's turn, not only the generator", async () => {
    let turnSignal: AbortSignal | undefined;
    const agent = new CurbVoiceAgent({
      instructions: "Test agent",
      async *runTurn(_text, signal): AsyncGenerator<AgentTurnStreamEvent> {
        turnSignal = signal;
        yield { type: "delta", delta: "Well, ", text: "Well, " };
        await new Promise(() => {}); // the LLM is still generating
      },
    });
    const reader = (await agent.llmNode(userSaid("Tell me a story"), new llm.ToolContext(), {}))!.getReader();
    expect(await reader.read()).toEqual({ done: false, value: "Well, " });

    await reader.cancel();
    expect(turnSignal?.aborted).toBe(true);
  });

  it("cancelling a queued reply neither aborts the running turn nor ever runs its own", async () => {
    const calls: Array<{ request: AgentRunRequest; answer: (response: AgentRunResponse) => void }> = [];
    const session = new AgentSession(createInsuranceDemoRuntime(), (request) =>
      new Promise((resolve) => calls.push({ request, answer: resolve })),
    );
    const agent = new CurbVoiceAgent({
      instructions: "Test agent",
      runTurn: (text, signal) => session.runTurnStream(text, { signal }),
    });

    const running = (await agent.llmNode(userSaid("first"), new llm.ToolContext(), {}))!.getReader();
    const queued = (await agent.llmNode(userSaid("second"), new llm.ToolContext(), {}))!.getReader();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await queued.cancel();

    expect(calls[0]!.request.signal?.aborted).toBe(false);
    calls[0]!.answer({ text: "Answer one.", toolCalls: [] });
    await running.closed;
    await vi.waitFor(() => expect(session.isRunning).toBe(false));
    expect(calls).toHaveLength(1);
    expect(session.messages.map((message) => message.content)).toEqual(["first", "Answer one."]);
  });

  it("reports a failed turn's cause to the call record while the caller hears the apology", async () => {
    const reporter: CallReporter = { event: vi.fn(), turn: vi.fn(), async finish() {}, undelivered: 0 };
    const agent = new CurbVoiceAgent({
      instructions: "Test agent",
      reporter,
      async *runTurn(): AsyncGenerator<AgentTurnStreamEvent> {
        yield { type: "delta", delta: "Sorry, something went wrong.", text: "Sorry, something went wrong." };
        yield { type: "error", error: { kind: "timeout", message: "The LLM did not answer within 60000 ms" } };
        yield { type: "done", reply: "Sorry, something went wrong." };
      },
    });
    const chat = new llm.ChatContext();
    chat.addMessage({ role: "user", content: "hello" });
    const stream = await agent.llmNode(chat, new llm.ToolContext(), {});
    const reader = stream!.getReader();
    const spoken: string[] = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) spoken.push(String(next.value));

    expect(spoken.join("")).toBe("Sorry, something went wrong.");
    expect(reporter.event).toHaveBeenCalledWith("error", {
      kind: "timeout",
      message: "The LLM did not answer within 60000 ms",
    });
  });
});
