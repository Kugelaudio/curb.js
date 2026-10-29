import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession,
  type AgentLlmClient,
  type AgentLlmStreamStep,
  type AgentSessionOptions,
} from "./agent-session.js";
import { Agent, AgentSiteRuntime, Tool } from "./index.js";
import { fallbackReplies } from "./llm/localized.js";
import type {
  AgentChatMessage,
  AgentRunRequest,
  AgentRunResponse,
  AgentStreamPart,
  AgentTurnStreamEvent,
} from "./llm/types.js";
import { createInsuranceDemoRuntime } from "./test-fixtures/insurance-runtime.js";

const RAW_ERROR = "ECONNREFUSED 10.0.0.7:5432 (pg pool exhausted)";
const TURN_FAILED_REPLY = fallbackReplies("en").turnFailed;

function crashingToolRuntime() {
  return new AgentSiteRuntime(
    <Agent>
      <Tool
        name="lookup_order"
        description="Look an order up."
        onCall={() => {
          throw new Error(RAW_ERROR);
        }}
      />
    </Agent>,
  );
}

/** A scripted LLM: one response per call, recording every request. */
function scripted(responses: AgentRunResponse[]) {
  const requests: AgentRunRequest[] = [];
  let step = 0;
  const llm: AgentLlmClient = async (request) => {
    requests.push(request);
    return responses[step++] ?? { text: "", toolCalls: [] };
  };
  return { llm, requests };
}

/** An LLM whose calls stay open until released (or forever). */
function held() {
  const calls: Array<{ request: AgentRunRequest; answer: (response: AgentRunResponse) => void }> = [];
  const llm: AgentLlmClient = (request) =>
    new Promise((resolve) => calls.push({ request, answer: resolve }));
  return { llm, calls };
}

async function drain(stream: AsyncGenerator<AgentTurnStreamEvent>) {
  const events: AgentTurnStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function withoutTimestamps(messages: AgentChatMessage[]) {
  return messages.map(({ at: _at, ...rest }) => rest);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("tool failures reach the model as tool results", () => {
  it("a throwing tool becomes ok:false for the next LLM step; the raw error never leaks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { llm, requests } = scripted([
      { text: "", toolCalls: [{ id: "t1", name: "lookup_order", input: { id: "42" } }] },
      { text: "I could not look that up right now. Want me to take a callback number?", toolCalls: [] },
    ]);
    const session = new AgentSession(crashingToolRuntime(), llm);

    const reply = await session.runTurn("where is order 42?");

    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.toolCallId).toBe("t1");
    expect(toolMessage?.role === "tool" && toolMessage.result.ok).toBe(false);
    expect(toolMessage?.role === "tool" && toolMessage.result.message).toContain("internal error");
    expect(reply).toBe("I could not look that up right now. Want me to take a callback number?");
    expect(JSON.stringify(session.messages)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(session.llmTrace)).not.toContain("ECONNREFUSED");
  });

  it("a call to a tool the model does not have is answered, not thrown", async () => {
    const { llm, requests } = scripted([
      { text: "", toolCalls: [{ id: "t1", name: "book_flight", input: {} }] },
      { text: "I cannot book flights.", toolCalls: [] },
    ]);
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    expect(await session.runTurn("book me a flight")).toBe("I cannot book flights.");
    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.result).toEqual({
      ok: false,
      message: 'Unknown tool "book_flight". Call only the tools you currently have.',
    });
  });

  it("an invalid call reported by the transport is fed back without running the tool", async () => {
    const { llm, requests } = scripted([
      {
        text: "",
        toolCalls: [{ id: "t1", name: "request_callback", input: {}, error: 'Invalid input for "request_callback": phone is required.' }],
      },
      { text: "What number should we call?", toolCalls: [] },
    ]);
    const runtime = createInsuranceDemoRuntime();
    const callTool = vi.spyOn(runtime, "callTool");
    const session = new AgentSession(runtime, llm);

    const events = await drain(session.runTurnStream("call me back"));

    expect(callTool).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", ok: false }));
    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.result).toEqual({
      ok: false,
      message: 'Invalid input for "request_callback": phone is required.',
    });
    expect(events.at(-1)).toEqual({ type: "done", reply: "What number should we call?" });
  });
});

describe("LLM calls are cancellable and time-bounded", () => {
  it("a hung LLM is aborted by the timeout and the turn ends with the fallback reply", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm, { llmTimeoutMs: 20 });

    const events = await drain(session.runTurnStream("hello?"));

    expect(calls[0]?.request.signal?.aborted).toBe(true);
    expect(events).toContainEqual({ type: "error", error: expect.objectContaining({ kind: "timeout" }) });
    // Streamed, so a voice caller hears the apology.
    expect(events).toContainEqual({ type: "delta", delta: TURN_FAILED_REPLY, text: TURN_FAILED_REPLY });
    expect(events.at(-1)).toEqual({ type: "done", reply: TURN_FAILED_REPLY });
    expect(logged).toHaveBeenCalledWith("[curb] turn timeout:", expect.objectContaining({ name: "LlmTimeoutError" }));
    // The apology is the framework's, not the model's: the transcript does not record it.
    expect(session.messages.map((message) => message.role)).toEqual(["user"]);
    expect(session.llmTrace.at(-1)?.error).toContain("did not answer within 20 ms");
    expect(session.isRunning).toBe(false);
  });

  it("AGENT_LLM_TIMEOUT_MS sets the default and a malformed value is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("AGENT_LLM_TIMEOUT_MS", "15");
    const { llm } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);
    expect(await session.runTurn("hi")).toBe(TURN_FAILED_REPLY);

    vi.stubEnv("AGENT_LLM_TIMEOUT_MS", "soon");
    expect(() => new AgentSession(createInsuranceDemoRuntime(), llm)).toThrow(/AGENT_LLM_TIMEOUT_MS/);
  });

  it("aborting the turn's signal aborts the LLM request and ends the turn without an apology", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);
    const stop = new AbortController();

    const turn = session.runTurn("tell me everything", { signal: stop.signal });
    await settle();
    expect(session.isRunning).toBe(true);
    stop.abort();

    expect(await turn).toBe("");
    expect(calls[0]?.request.signal?.aborted).toBe(true);
    expect(session.isRunning).toBe(false);
    expect(session.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("a cancelled stream keeps the text already streamed and closes the provider stream", async () => {
    let closed = false;
    const streamLlm: AgentLlmStreamStep = async function* (request): AsyncGenerator<AgentStreamPart, AgentRunResponse> {
      try {
        yield { delta: "Let me explain. ", text: "Let me explain. " };
        // The second sentence starts, so the first one is said.
        yield { delta: "First", text: "Let me explain. First" };
        // The provider stalls mid-reply until the abort reaches it.
        await new Promise((_, reject) =>
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason)),
        );
        return { text: "", toolCalls: [] };
      } finally {
        closed = true;
      }
    };
    const session = new AgentSession(createInsuranceDemoRuntime(), async () => ({ text: "", toolCalls: [] }), {
      streamLlm,
    });

    const stop = new AbortController();
    const events: AgentTurnStreamEvent[] = [];
    for await (const event of session.runTurnStream("explain", { spoken: true, signal: stop.signal })) {
      events.push(event);
      if (event.type === "delta") stop.abort();
    }

    expect(events.at(-1)).toEqual({ type: "done", reply: "Let me explain." });
    // The partial reply is in the transcript, where a barge-in reconcile finds it.
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: "Let me explain." });
    expect(session.isRunning).toBe(false);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it("a cancel during a tool leaves the call paired with its result", async () => {
    let release!: () => void;
    const runtime = new AgentSiteRuntime(
      <Agent>
        <Tool
          name="slow_lookup"
          description="Takes a while."
          onCall={() => new Promise((resolve) => (release = () => resolve({ ok: true })))}
        />
      </Agent>,
    );
    const { llm } = scripted([
      { text: "", toolCalls: [{ id: "t1", name: "slow_lookup", input: {} }] },
      { text: "never asked", toolCalls: [] },
    ]);
    const session = new AgentSession(runtime, llm);
    const stop = new AbortController();

    const turn = session.runTurn("look it up", { signal: stop.signal });
    await settle();
    stop.abort();
    release();
    await turn;

    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(session.llmTrace).toHaveLength(1);
  });
});

describe("cancellation is scoped to one turn", () => {
  it("returning a turn's stream aborts its LLM request", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    const turn = session.runTurnStream("tell me everything");
    const pending = turn.next();
    await settle();
    await turn.return(undefined);

    expect(calls[0]?.request.signal?.aborted).toBe(true);
    expect((await pending).value).toEqual({ type: "done", reply: "" });
    expect(session.isRunning).toBe(false);
  });

  it("a late cancel of a finished turn leaves the next spoken turn alone", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    const first = session.runTurnStream("tell me about coverage", { spoken: true });
    const firstEvents = drain(first);
    await settle();
    calls[0]!.answer({ text: "Coverage is broad.", toolCalls: [] });
    expect((await firstEvents).at(-1)).toEqual({ type: "done", reply: "Coverage is broad." });

    const bargeIn = drain(session.runTurnStream("and the deductible?", { spoken: true }));
    await settle();
    // LiveKit cancels the first reply's stream only now.
    await first.return(undefined);

    expect(calls[1]!.request.signal?.aborted).toBe(false);
    calls[1]!.answer({ text: "It is 500 euros.", toolCalls: [] });
    expect((await bargeIn).at(-1)).toEqual({ type: "done", reply: "It is 500 euros." });
  });

  it("cancelling a queued turn leaves the running turn alone and never runs it", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);
    const queuedStop = new AbortController();

    const running = session.runTurn("first");
    const queued = session.runTurn("second", { signal: queuedStop.signal });
    await settle();
    queuedStop.abort();

    expect(await queued).toBe("");
    expect(calls[0]!.request.signal?.aborted).toBe(false);
    calls[0]!.answer({ text: "Answer one.", toolCalls: [] });
    expect(await running).toBe("Answer one.");
    await settle();
    expect(calls).toHaveLength(1);
    expect(session.messages.map((message) => message.content)).toEqual(["first", "Answer one."]);
    expect(session.isRunning).toBe(false);
  });

  it("a queued turn whose stream is returned never starts: no transcript entry, no LLM call, no tool", async () => {
    const { llm, calls } = held();
    const runtime = createInsuranceDemoRuntime();
    const callTool = vi.spyOn(runtime, "callTool");
    const session = new AgentSession(runtime, llm);

    const a = session.runTurn("first");
    const b = session.runTurnStream("second");
    const bNext = b.next();
    await settle();
    const bReturned = b.return(undefined);
    calls[0]!.answer({ text: "Answer one.", toolCalls: [] });

    expect(await a).toBe("Answer one.");
    await bNext;
    await bReturned;
    await settle();
    expect(calls).toHaveLength(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(session.messages.map((message) => message.content)).toEqual(["first", "Answer one."]);
    expect(session.isRunning).toBe(false);
  });
});

describe("a failed turn is logged and recorded, never silent", () => {
  it("a failure after the LLM answered is logged, recorded on the step's trace entry and apologised for", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { llm } = scripted([{ text: "", toolCalls: [{ id: "t1", name: "lookup_policy", input: {} }] }]);
    const runtime = createInsuranceDemoRuntime();
    vi.spyOn(runtime, "toolDefinition").mockImplementation(() => {
      throw new Error("tool registry corrupted");
    });
    const session = new AgentSession(runtime, llm);

    const events = await drain(session.runTurnStream("look my policy up"));

    expect(events).toContainEqual({
      type: "error",
      error: { kind: "failed", message: "tool registry corrupted" },
    });
    expect(events.at(-1)).toEqual({ type: "done", reply: TURN_FAILED_REPLY });
    expect(logged).toHaveBeenCalledWith("[curb] turn failed:", expect.objectContaining({ message: "tool registry corrupted" }));
    expect(session.llmTrace.at(-1)?.error).toBe("tool registry corrupted");
    expect(session.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("runTurn returns the apology for a failed turn while the cause is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const llm: AgentLlmClient = async () => {
      throw new Error(RAW_ERROR);
    };
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    expect(await session.runTurn("hi")).toBe(TURN_FAILED_REPLY);
    expect(logged).toHaveBeenCalledWith("[curb] turn failed:", expect.objectContaining({ message: RAW_ERROR }));
    expect(session.llmTrace.at(-1)?.error).toBe(RAW_ERROR);
    expect(JSON.stringify(session.messages)).not.toContain("ECONNREFUSED");
  });
});

describe("overlapping input is queued, never dropped", () => {
  it("two typed messages sent back-to-back are both answered, in order", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    const first = session.runTurn("first");
    const second = session.runTurn("second");
    await settle();
    expect(calls).toHaveLength(1);
    calls[0]!.answer({ text: "Answer one.", toolCalls: [] });
    await settle();
    expect(calls).toHaveLength(2);
    calls[1]!.answer({ text: "Answer two.", toolCalls: [] });

    expect(await first).toBe("Answer one.");
    expect(await second).toBe("Answer two.");
    expect(session.messages.map((message) => message.content)).toEqual([
      "first",
      "Answer one.",
      "second",
      "Answer two.",
    ]);
    expect(session.isRunning).toBe(false);
  });

  it("input beyond the queue bound is refused with an explicit busy error", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm, { maxQueuedTurns: 1 });

    const running = session.runTurn("one");
    const queued = session.runTurn("two");
    await settle();
    const refused = await drain(session.runTurnStream("three"));
    await expect(session.runTurn("four")).rejects.toThrow(/already waiting/);

    expect(refused[0]).toMatchObject({ type: "error", error: { kind: "busy" } });
    expect(refused.at(-1)).toEqual({ type: "done", reply: "" });

    calls[0]!.answer({ text: "A.", toolCalls: [] });
    await settle();
    calls[1]!.answer({ text: "B.", toolCalls: [] });
    expect([await running, await queued]).toEqual(["A.", "B."]);
    expect(session.messages.map((message) => message.content)).not.toContain("three");
  });

  it("a new spoken turn barges in: it aborts the turn in flight, then runs", async () => {
    const { llm, calls } = held();
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    const interrupted = drain(session.runTurnStream("tell me about coverage", { spoken: true }));
    await settle();
    const bargeIn = drain(session.runTurnStream("actually, stop", { spoken: true }));
    await settle();

    expect(calls[0]!.request.signal?.aborted).toBe(true);
    expect((await interrupted).at(-1)).toEqual({ type: "done", reply: "" });
    await settle();
    calls[1]!.answer({ text: "Okay.", toolCalls: [] });
    expect((await bargeIn).at(-1)).toEqual({ type: "done", reply: "Okay." });
  });
});

describe("runTurn and runTurnStream share one loop", () => {
  it("produce identical transcripts for the same script", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const script = (): AgentRunResponse[] => [
      { text: "Checking.", toolCalls: [{ id: "t1", name: "lookup_order", input: { id: "7" } }] },
      { text: "", toolCalls: [{ id: "t2", name: "nope", input: {} }] },
      { text: "That did not work.", toolCalls: [] },
    ];
    const options: AgentSessionOptions = {};

    const plain = new AgentSession(crashingToolRuntime(), scripted(script()).llm, options);
    const plainReply = await plain.runTurn("order 7?");

    const streamedScript = script();
    let step = 0;
    const streamLlm: AgentLlmStreamStep = async function* () {
      const response = streamedScript[step++] ?? { text: "", toolCalls: [] };
      if (response.text) yield { delta: response.text, text: response.text };
      return response;
    };
    const streamed = new AgentSession(crashingToolRuntime(), async () => ({ text: "", toolCalls: [] }), {
      ...options,
      streamLlm,
    });
    const events = await drain(streamed.runTurnStream("order 7?"));

    expect(withoutTimestamps(streamed.messages)).toEqual(withoutTimestamps(plain.messages));
    expect(events.at(-1)).toEqual({ type: "done", reply: plainReply });
  });
});
