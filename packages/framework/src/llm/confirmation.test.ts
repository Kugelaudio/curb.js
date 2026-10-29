import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAnswer,
  confirmationRequest,
  isConfirmationRequest,
  readVerdict,
  withConfirmNote,
} from "./confirmation.js";
import { serializeLlmInput } from "./serialize-input.js";
import type { AgentRunRequest, AgentRunResponse } from "./types.js";

const READ_BACK = "lisa@example.com, Tuesday 15:00: is that right?";
const never = () => new Promise<AgentRunResponse>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe("confirmation check", () => {
  it("sends the read-back and the caller's words only: no tools, no transcript", () => {
    const request = confirmationRequest(READ_BACK, "Ja, genau.");
    expect(isConfirmationRequest(request)).toBe(true);

    const input = serializeLlmInput(request);
    expect(input.tools).toEqual({});
    expect(input.messages).toEqual([
      {
        role: "user",
        content: `<current_context skill="confirmation">\nquestion: ${READ_BACK}\nanswer: Ja, genau.\n</current_context>`,
      },
    ]);
    expect(input.system).toContain("Reply with exactly one word");
  });

  it("is told apart from the agent's own requests", () => {
    const agentRequest: AgentRunRequest = {
      systemPrompt: "You book appointments.",
      skillTitle: "confirmation",
      stateSnapshot: [],
      tools: [],
      messages: [],
    };
    expect(isConfirmationRequest(agentRequest)).toBe(false);
  });

  it.each([
    ["yes", "yes"],
    ["Yes.", "yes"],
    ["**YES**", "yes"],
    ["no", "no"],
    ["No, they changed the date.", "no"],
    ["unclear", "unclear"],
    ["", "unclear"],
    ["ja", "unclear"],
    ["nope", "unclear"],
    ["yesterday", "unclear"],
    ["The caller agrees.", "unclear"],
  ])("reads %j as %s", (reply, verdict) => {
    expect(readVerdict(reply)).toBe(verdict);
  });

  it("asks the given client, passing it a signal", async () => {
    const llm = vi.fn(async (_request: AgentRunRequest) => ({ text: "yes", toolCalls: [] }));
    const request = confirmationRequest(READ_BACK, "Yes please.");

    await expect(checkAnswer(llm, request, new AbortController().signal, 1_000)).resolves.toEqual({
      verdict: "yes",
    });
    expect(llm).toHaveBeenCalledWith({ ...request, signal: expect.any(AbortSignal) });
  });

  it("a check that fails counts as unclear and says why", async () => {
    const error = new Error("provider down");
    const result = await checkAnswer(
      async () => {
        throw error;
      },
      confirmationRequest(READ_BACK, "yes"),
      new AbortController().signal,
      1_000,
    );
    expect(result).toEqual({ verdict: "unclear", failed: { error } });
  });

  it("a check that does not answer in time counts as unclear", async () => {
    vi.useFakeTimers();
    const pending = checkAnswer(never, confirmationRequest(READ_BACK, "yes"), new AbortController().signal, 50);
    await vi.advanceTimersByTimeAsync(50);

    const result = await pending;
    expect(result.verdict).toBe("unclear");
    expect(String(result.failed?.error)).toContain("did not answer within 50 ms");
  });

  it("a cancelled turn stays cancelled instead of counting as unclear", async () => {
    const turn = new AbortController();
    const pending = checkAnswer(never, confirmationRequest(READ_BACK, "yes"), turn.signal, 10_000);
    turn.abort(new Error("the caller talked over the agent"));

    await expect(pending).rejects.toThrow("the caller talked over the agent");
  });

  it("tells the model what calling a confirm tool does", () => {
    const tool = withConfirmNote({
      id: "node-1",
      name: "book_meeting",
      description: "Book the chosen slot.",
      inputSchema: { type: "object", properties: {} },
      scope: "page",
    });
    expect(tool.description.startsWith("Book the chosen slot. Calling this tool does not run it yet")).toBe(true);
    expect(tool.description).toContain("without asking for that confirmation yourself");
  });
});
