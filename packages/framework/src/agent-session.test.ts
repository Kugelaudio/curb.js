import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInsuranceDemoRuntime, INSURANCE_AGENT_SYSTEM_PROMPT } from "./test-fixtures/insurance-runtime.js";
import {
  AgentSession,
  normalizeLlmPunctuation,
  type AgentLlmClient,
  type AgentLlmStreamStep,
} from "./agent-session.js";
import { Agent, Text } from "./components.js";
import { callStaysOpenAfter, FOLLOW_THROUGH_CHECK, namedToolNote } from "./llm/follow-through.js";
import { fallbackReplies } from "./llm/localized.js";
import type { AgentRunRequest, AgentRunResponse, AgentToolCall, AgentTurnStreamEvent } from "./llm/types.js";
import { kugelaudio } from "./providers.js";
import { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME } from "./types.js";
import { AgentSiteRuntime } from "./runtime.js";
import { FixtureApp } from "./test-fixtures/fixture-agent.js";

const TURN_FAILED = fallbackReplies("en").turnFailed;

function makeSession(responses: AgentRunResponse[]) {
  const runtime = createInsuranceDemoRuntime();
  let step = 0;
  const llm = vi.fn<AgentLlmClient>(async () => responses[step++] ?? { text: "", toolCalls: [] });
  const session = new AgentSession(runtime, llm);
  return { runtime, session, llm };
}

const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });

/**
 * A streaming transport playing one scripted step per call the way a provider streams
 * it: the text word by word, then a `tool-input-start` per tool call, then the response.
 */
function scriptedStream(steps: Array<{ text?: string; toolCalls?: AgentToolCall[] }>) {
  const requests: AgentRunRequest[] = [];
  let step = 0;
  const streamLlm: AgentLlmStreamStep = async function* (request) {
    requests.push(request);
    const { text = "", toolCalls = [] } = steps[step++] ?? {};
    let sofar = "";
    for (const word of text.split(/(?<= )/).filter(Boolean)) {
      sofar += word;
      yield { delta: word, text: sofar };
    }
    for (const call of toolCalls) yield { type: "tool-input-start", toolName: call.name };
    return { text: text.trim(), toolCalls };
  };
  return { streamLlm, requests };
}

/** Run one streamed turn; what the caller heard is the deltas joined as they came. */
async function streamTurn(session: AgentSession, input: string) {
  const events: AgentTurnStreamEvent[] = [];
  for await (const event of session.runTurnStream(input, { spoken: true })) events.push(event);
  const deltas = events.flatMap((event) => (event.type === "delta" ? [event.delta] : []));
  const done = events.at(-1);
  return {
    events,
    deltas,
    heard: deltas.join(""),
    reply: done?.type === "done" ? done.reply : undefined,
    errors: events.flatMap((event) => (event.type === "error" ? [event.error] : [])),
  };
}

/** A one-page agent that speaks German (`<Agent tts={kugelaudio.tts({ language: "de" })}>`). */
function germanRuntime() {
  return new AgentSiteRuntime(
    createElement(
      Agent,
      { tts: kugelaudio.tts({ language: "de" }) },
      createElement("agent-page", { path: "/", title: "Termine" }, createElement(Text, null, "Termine vereinbaren.")),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentSession", () => {
  it("spokenStyleSuffix is appended on spoken turns only, after the authored prompt", async () => {
    const runtime = createInsuranceDemoRuntime();
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Hi.", toolCalls: [] }));
    const session = new AgentSession(runtime, llm, { spokenStyleSuffix: "## Voice rules\nSpeak briefly." });

    // Typed turn: the authored prompt, untouched.
    await session.runTurn("hello");
    const typed = llm.mock.calls[0]![0];
    expect(typed.systemPrompt.includes("## Voice rules")).toBe(false);
    expect(typed.systemPrompt.startsWith(INSURANCE_AGENT_SYSTEM_PROMPT.slice(0, 40))).toBe(true);

    // Spoken turn on the SAME session: the speech rules are appended.
    await session.runTurn("hello again", { spoken: true });
    const spoken = llm.mock.calls[1]![0];
    expect(spoken.systemPrompt.endsWith("\n\n## Voice rules\nSpeak briefly.")).toBe(true);
    expect(spoken.systemPrompt.startsWith(INSURANCE_AGENT_SYSTEM_PROMPT.slice(0, 40))).toBe(true);
  });

  it("a synthetic turn marks its user message so UIs can hide it", async () => {
    const { session } = makeSession([{ text: "Still there?", toolCalls: [] }]);
    await session.runTurn("(the user has been quiet)", { spoken: true, kind: "synthetic" });
    const user = session.messages.find((m) => m.role === "user");
    expect(user && "kind" in user && user.kind).toBe("synthetic");
  });

  it("annotateAudio attaches clips to the newest matching message, skipping synthetic input", async () => {
    const { session } = makeSession([
      { text: "Done.", toolCalls: [] },
      { text: "Still there?", toolCalls: [] },
    ]);
    await session.runTurn("hello", { spoken: true });
    session.annotateAudio("user", { room: "r1", role: "user", ordinals: [0] });
    session.annotateAudio("assistant", { room: "r1", role: "assistant", ordinals: [0] });

    await session.runTurn("(quiet)", { spoken: true, kind: "synthetic" });
    // The synthetic user message must NOT claim clips; the real one already has its own.
    session.annotateAudio("user", { room: "r1", role: "user", ordinals: [1] });

    const users = session.messages.filter((m) => m.role === "user");
    expect(users[0]?.audio?.ordinals).toEqual([0]);
    expect(users[1]?.audio).toBeUndefined();
    const assistant = session.messages.find((m) => m.role === "assistant");
    expect(assistant?.audio?.ordinals).toEqual([0]);
  });

  it("reconcileInterruptedReply rewrites the last assistant reply to the spoken prefix", async () => {
    const { session } = makeSession([
      { text: "Sure — first, is everyone safe right now, and is the water shut off?", toolCalls: [] },
    ]);
    await session.runTurn("I want to file a claim");

    // The user barged in after two words: history must match their ears.
    session.reconcileInterruptedReply("Sure — first,");
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    // Only the heard words: the model is told the rest in a context event (serialize-input.ts).
    expect(last?.content).toBe("Sure — first,");
    expect(last?.role === "assistant" && last.interruption).toEqual({
      spokenText: "Sure — first,",
      unspokenText: "is everyone safe right now, and is the water shut off?",
      fullText: "Sure — first, is everyone safe right now, and is the water shut off?",
    });

    // Cut before anything played.
    session.reconcileInterruptedReply("");
    const again = [...session.messages].reverse().find((m) => m.role === "assistant");
    expect(again?.content).toBe("");
    expect(again?.role === "assistant" && again.interruption).toEqual({
      spokenText: "",
      unspokenText: "Sure — first, is everyone safe right now, and is the water shut off?",
      fullText: "Sure — first, is everyone safe right now, and is the water shut off?",
    });
  });

  it("reconcileInterruptedReply leaves a reply the caller heard to its last word", async () => {
    // The caller spoke over the last word: they heard all of it, so it was not cut off.
    const { session } = makeSession([{ text: "Guten Morgen. Wie kann ich Ihnen heute helfen?", toolCalls: [] }]);
    await session.runTurn("Guten Morgen.");

    session.reconcileInterruptedReply("Guten Morgen Wie kann ich Ihnen heute helfen");
    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    expect(last).toMatchObject({ content: "Guten Morgen. Wie kann ich Ihnen heute helfen?" });
    expect(last?.role === "assistant" && last.interruption).toBeUndefined();
  });

  it("a cut-off fallback line leaves the reply before it alone (the transcript never held the line)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = false;
    const session = new AgentSession(createInsuranceDemoRuntime(), async () => {
      if (failing) throw new Error("overloaded_error");
      return { text: "Your claim is open.", toolCalls: [] };
    });
    await session.runTurn("what about my claim?", { spoken: true });
    failing = true;
    expect(await session.runTurn("and the adjuster?", { spoken: true })).toBe(TURN_FAILED);

    // The voice host reports the apology's clip, then the caller talking over it.
    session.annotateAudio("assistant", { room: "r1", role: "assistant", ordinals: [1] });
    session.reconcileInterruptedReply("Sorry, something");

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant).toMatchObject({ content: "Your claim is open." });
    expect(assistant?.role === "assistant" && (assistant.interruption ?? assistant.audio)).toBeUndefined();
  });

  it("reconciles a forced-alignment prefix, which carries no punctuation", async () => {
    const full = "Hey, I'm Juno, here to help. Is everyone safe right now?";
    const { session } = makeSession([{ text: full, toolCalls: [] }]);
    await session.runTurn("hi");

    // WHAT THE TTS ACTUALLY REPORTS: bare words joined by single spaces. It is
    // not a character-prefix of the reply, so slicing by its length used to cut
    // five characters short and land inside "here" — the muted remainder then
    // started mid-word and the split on screen was visibly wrong.
    session.reconcileInterruptedReply("Hey I'm Juno here ");

    const last = [...session.messages].reverse().find((m) => m.role === "assistant");
    expect(last?.role === "assistant" && last.interruption).toEqual({
      spokenText: "Hey, I'm Juno, here",
      unspokenText: "to help. Is everyone safe right now?",
      fullText: full,
    });
  });

  it("executes a tool-calling turn through the runtime and records the transcript", async () => {
    const { runtime, session, llm } = makeSession([
      {
        text: "On it.",
        toolCalls: [
          { name: "request_callback", input: { name: "Ada", phone: "+491234567", topic: "Coverage" } },
        ],
      },
      { text: "All set — an advisor will call you back.", toolCalls: [] },
    ]);

    const notifications: number[] = [];
    session.subscribe(() => notifications.push(session.messages.length));

    const reply = await session.runTurn("I need a callback about coverage");

    // "On it." came with a tool call, so it was never said: the reply is the answer.
    expect(reply).toBe("All set — an advisor will call you back.");
    expect(llm).toHaveBeenCalledTimes(2);
    expect(session.isRunning).toBe(false);

    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(session.messages[2].content).toContain("request_callback");

    // Tool calls are recorded natively: assistant carries the call (with a
    // generated id when the transport omits one), the tool message pairs it.
    const assistant = session.messages[1];
    expect(assistant.content).toBe("");
    expect(assistant.role === "assistant" && assistant.toolCalls).toEqual([
      { id: "call_1", name: "request_callback", input: { name: "Ada", phone: "+491234567", topic: "Coverage" } },
    ]);
    const toolMessage = session.messages[2];
    expect(toolMessage.role === "tool" && toolMessage.toolCallId).toBe("call_1");
    expect(toolMessage.role === "tool" && toolMessage.result.ok).toBe(true);

    // The tool actually ran against the runtime (not just recorded as text).
    expect(runtime.snapshot().context.content).toContain("Callback request was recorded.");
    expect(notifications.length).toBeGreaterThan(0);
    expect(session.llmTrace).toHaveLength(2);
    // The state snapshot is the FINAL message of every serialized call.
    const lastMessage = session.llmTrace[0].input.messages.at(-1);
    expect(lastMessage?.role).toBe("user");
    expect(typeof lastMessage?.content === "string" && lastMessage.content).toContain("<current_context");
  });

  it("a text-then-tool step says nothing and records nothing; the answer after the result is the reply", async () => {
    const { runtime, session } = makeSession([
      {
        text: "Sure, let me pull up property damage.",
        toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }],
      },
      { text: "Is everyone safe?", toolCalls: [] },
    ]);

    const reply = await session.runTurn("My roof is damaged");

    expect(reply).toBe("Is everyone safe?");
    expect(session.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "My roof is damaged"],
      ["assistant", ""],
      ["tool", "Skill read."],
      ["assistant", "Is everyone safe?"],
    ]);
    const assistant = session.messages[1];
    expect(assistant.role === "assistant" && assistant.toolCalls?.[0]).toMatchObject({
      name: "read_skill",
      input: { skill: "/property-damage" },
    });
    // read_skill still drove the runtime.
    expect(runtime.snapshot().context.path).toBe("/property-damage");
  });

  it("records the owning skill on page-scoped tool calls", async () => {
    const runtime = new AgentSiteRuntime(({ path, loadedPaths }) =>
      FixtureApp({ path, loadedPaths }),
    );
    runtime.loadSkill("/alpha");
    const session = new AgentSession(runtime, async () => ({
      text: "Saved.",
      toolCalls: [{ name: "alpha_note", input: {} }],
    }), { maxSteps: 1 });

    await session.runTurn("Make an alpha note");

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.role === "assistant" && assistant.toolCalls?.[0]).toMatchObject({
      name: "alpha_note",
      skillPath: "/alpha",
    });
  });

  it("sends the system prompt authored in the tree via <SystemPrompt>", async () => {
    const runtime = createInsuranceDemoRuntime();
    const seen: string[] = [];
    const llm: AgentLlmClient = async (request) => {
      seen.push(request.systemPrompt);
      return { text: "ok", toolCalls: [] };
    };

    const session = new AgentSession(runtime, llm);
    await session.runTurn("hello");
    await session.runTurn("hello again");

    // The prompt comes from the compiled context (the <SystemPrompt> node),
    // not a per-session/per-channel option — one prompt for every turn.
    expect(seen).toEqual([INSURANCE_AGENT_SYSTEM_PROMPT, INSURANCE_AGENT_SYSTEM_PROMPT]);
  });

  it("records external context events as context_event user messages", async () => {
    const { runtime, session } = makeSession([]);

    const { contextDiff } = runtime.loadSkill("/property-damage");
    session.recordContextEvent([
      'The user opened "/property-damage" in the UI.',
      ...contextDiff.map((line) => `+ ${line}`),
    ]);

    expect(session.messages).toHaveLength(1);
    const event = session.messages[0];
    expect(event.role).toBe("user");
    expect(event.role === "user" && event.kind).toBe("context_event");
    expect(event.content).toContain('opened "/property-damage"');
  });

  it("records a context event for external info only when the context is affected", async () => {
    const { runtime, session } = makeSession([]);

    // Nothing rendered at "/" reads the caller number — silent update.
    session.updateInfo({ "caller.phoneNumber": "+49 89 555 0000" });
    expect(session.messages).toHaveLength(0);

    // The member portal renders the caller banner — now the LLM must hear it.
    runtime.loadSkill("/member-portal");
    session.updateInfo({ "caller.phoneNumber": "+49 89 555 1111" });
    expect(session.messages).toHaveLength(1);
    const event = session.messages[0];
    expect(event.role === "user" && event.kind).toBe("context_event");
    expect(event.content).toContain("+49 89 555 1111");
  });

  describe("what a streamed turn says", () => {
    it("a stage direction is never said: the model is asked again once", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { streamLlm, requests } = scriptedStream([
        { text: "[assistant turned their head away]" },
        { text: "I'm sorry to hear that. Is anyone hurt?" },
      ]);
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm });

      const turn = await streamTurn(session, "My roof is damaged");

      expect(turn.heard).toBe("I'm sorry to hear that. Is anyone hurt?");
      expect(requests).toHaveLength(2);
      // Neither the caller nor the model's memory has the stage direction.
      expect(session.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "My roof is damaged"],
        ["assistant", "I'm sorry to hear that. Is anyone hurt?"],
      ]);
    });

    it("a second stage direction ends the turn silent, without the failed-turn apology", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { streamLlm } = scriptedStream([{ text: "[assistant turned their head away]" }, { text: "(stays silent)" }]);
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm });

      const turn = await streamTurn(session, "so he needs the back part, right?");

      expect(turn.deltas).toEqual([]);
      expect(turn.reply).toBe("");
      expect(turn.errors).toEqual([]);
      expect(session.messages.map((message) => message.role)).toEqual(["user"]);
      expect(String(warn.mock.calls[0]?.[0])).toContain("only a stage direction");
    });

    it("a text-then-tool step is never spoken; the step after the result is", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm } = scriptedStream([
        {
          text: "Let me pull up the member portal for you.",
          toolCalls: [{ name: "read_skill", input: { skill: "/member-portal" } }],
        },
        { text: "What's your work email?" },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });

      const turn = await streamTurn(session, "I want to log in");

      expect(turn.heard).toBe("What's your work email?");
      expect(turn.reply).toBe("What's your work email?");
      // The transcript holds what was spoken, and nothing the caller never heard.
      expect(session.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "I want to log in"],
        ["assistant", ""],
        ["tool", "Skill read."],
        ["assistant", "What's your work email?"],
      ]);
      expect(runtime.snapshot().context.path).toBe("/member-portal");
    });

    it("a text-only step streams sentence by sentence while the model is still writing", async () => {
      let finished = false;
      const streamLlm: AgentLlmStreamStep = async function* () {
        yield { delta: "Your claim is open. ", text: "Your claim is open. " };
        yield { delta: "An adjuster", text: "Your claim is open. An adjuster" };
        yield { delta: " calls tomorrow.", text: "Your claim is open. An adjuster calls tomorrow." };
        finished = true;
        return { text: "Your claim is open. An adjuster calls tomorrow.", toolCalls: [] };
      };
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm });
      const live: string[] = [];
      session.subscribeDeltas((text) => live.push(text));

      const stream = session.runTurnStream("what about my claim?", { spoken: true });
      const first = await stream.next();
      // The first sentence is out once the second one started, before the step ended.
      expect(first.value).toEqual({ type: "delta", delta: "Your claim is open. ", text: "Your claim is open." });
      expect(finished).toBe(false);
      const rest: AgentTurnStreamEvent[] = [];
      for await (const event of stream) rest.push(event);

      expect(rest).toEqual([
        {
          type: "delta",
          delta: "An adjuster calls tomorrow.",
          text: "Your claim is open. An adjuster calls tomorrow.",
        },
        { type: "done", reply: "Your claim is open. An adjuster calls tomorrow." },
      ]);
      expect(live).toEqual(["Your claim is open.", "Your claim is open. An adjuster calls tomorrow."]);
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Your claim is open. An adjuster calls tomorrow.",
      });
    });

    it("drops the held sentence when a tool call starts, and says nothing more of that step", async () => {
      const streamLlm: AgentLlmStreamStep = async function* () {
        yield { delta: "One sec. ", text: "One sec. " };
        yield { type: "tool-input-start", toolName: "request_callback" };
        // Text after the tool call opened: would release "Checking now." on its own.
        yield { delta: "Checking now. Done.", text: "One sec. Checking now. Done." };
        return {
          text: "One sec. Checking now. Done.",
          toolCalls: [{ name: "request_callback", input: { name: "Ada", phone: "+491234567", topic: "Coverage" } }],
        };
      };
      let step = 0;
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, {
        streamLlm: (request) =>
          step++ === 0 ? streamLlm(request) : scriptedStream([{ text: "An advisor will call you back." }]).streamLlm(request),
      });

      const turn = await streamTurn(session, "call me back");

      expect(turn.deltas).toEqual(["An advisor will call you back."]);
      expect(session.messages[1]).toMatchObject({ role: "assistant", content: "" });
    });

    it("keeps the words that were said before the tool call showed, joined to the answer with a space", async () => {
      const { streamLlm } = scriptedStream([
        {
          text: "Sure. Let me check that for you.",
          toolCalls: [{ name: "read_skill", input: { skill: "/member-portal" } }],
        },
        { text: "What's your work email?" },
      ]);
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm });

      const turn = await streamTurn(session, "I want to log in");

      // "Sure." was out before the tool call showed; "Let me check that for you." was held and dropped.
      expect(turn.heard).toBe("Sure. What's your work email?");
      expect(turn.reply).toBe("Sure. What's your work email?");
      expect(session.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([
        "Sure.",
        "What's your work email?",
      ]);
    });

    it("an end_call step says only its goodbye, once the call ran, never its own words", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const { streamLlm, requests } = scriptedStream([
        {
          // The model narrating its plan in the step that hangs up: never said, never recorded.
          text: "The caller is done, so I say goodbye and end the call.",
          toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Glad I could help! Take care." } }],
        },
        { text: "should never run" },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });

      const turn = await streamTurn(session, "that's all, thanks, bye");

      expect(turn.events.map((event) => event.type)).toEqual(["tool", "delta", "done"]);
      expect(turn.deltas).toEqual(["Glad I could help. Take care."]);
      expect(turn.reply).toBe("Glad I could help. Take care.");
      expect(hangUp).toHaveBeenCalledTimes(1);
      expect(session.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "that's all, thanks, bye"],
        ["assistant", ""],
        ["tool", "The call ends once the goodbye has played."],
        ["assistant", "Glad I could help. Take care."],
      ]);
      expect(requests).toHaveLength(1);
    });

    it("a goodbye the step wrote as text too is heard once: the closing line goes on from what was said", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const goodbye = "Glad I could help, Alex. Take care and see you Monday!";
      // Of the step's text the first sentence is out before the tool call shows; the second is held and dropped.
      const { streamLlm } = scriptedStream([{ text: goodbye, toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye } }] }]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });

      const turn = await streamTurn(session, "No, that's everything. Thanks, bye.");

      expect(turn.deltas).toEqual(["Glad I could help, Alex. ", "Take care and see you Monday."]);
      expect(turn.heard).toBe("Glad I could help, Alex. Take care and see you Monday.");
      expect(turn.reply).toBe("Glad I could help, Alex. Take care and see you Monday.");
      expect(hangUp).toHaveBeenCalledTimes(1);
      expect(session.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "No, that's everything. Thanks, bye."],
        ["assistant", "Glad I could help, Alex."],
        ["tool", "The call ends once the goodbye has played."],
        ["assistant", "Take care and see you Monday."],
      ]);
    });

    it("a goodbye that was said to its end before end_call ran adds nothing, and the call still ends", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const goodbye = "Glad I could help. Take care.";
      const { streamLlm, requests } = scriptedStream([
        { text: `${goodbye} Have a lovely day.`, toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye } }] },
        { text: "should never run" },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });

      const turn = await streamTurn(session, "that's all, thanks, bye");

      expect(turn.events.map((event) => event.type)).toEqual(["delta", "delta", "tool", "done"]);
      expect(turn.reply).toBe("Glad I could help. Take care.");
      expect(hangUp).toHaveBeenCalledTimes(1);
      expect(session.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "that's all, thanks, bye"],
        ["assistant", "Glad I could help. Take care."],
        ["tool", "The call ends once the goodbye has played."],
      ]);
      expect(requests).toHaveLength(1);
    });

    it("a goodbye that only resembles what the step said is said in full: no word the caller has not heard is dropped", async () => {
      const runtime = createInsuranceDemoRuntime();
      runtime.setEndCallRequest(() => {});
      const { streamLlm } = scriptedStream([
        { text: "Glad I could help, Alex. Bye for now.", toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Glad I could help, Alex, and take care!" } }] },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });

      const turn = await streamTurn(session, "bye");

      expect(turn.reply).toBe("Glad I could help, Alex. Glad I could help, Alex, and take care.");
    });

    it("refuses an end_call without a goodbye: the call stays up and the turn goes on", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const { streamLlm, requests } = scriptedStream([
        { toolCalls: [{ name: END_CALL_TOOL_NAME, input: {} }] },
        { toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "  " } }] },
        { toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Take care." } }] },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });

      const turn = await streamTurn(session, "bye");

      expect(turn.heard).toBe("Take care.");
      expect(turn.errors).toEqual([]);
      expect(requests).toHaveLength(3);
      expect(hangUp).toHaveBeenCalledTimes(1);
      const refused = {
        ok: false,
        message:
          "end_call needs your closing line as goodbye: one short sentence to the caller, in their language. The call is still on; call end_call again with it.",
      };
      expect(session.messages.flatMap((message) => (message.role === "tool" ? [message.result] : []))).toEqual([
        refused,
        refused,
        { ok: true },
      ]);
    });

    it("keeps the call up when another call of the step failed: end_call runs last and is refused, the model fixes the call", async () => {
      const callback = { name: "Alex Doe", phone: "555 0100", topic: "claim status" };
      for (const order of ["end_call last", "end_call first"] as const) {
        const runtime = createInsuranceDemoRuntime();
        const hangUp = vi.fn();
        runtime.setEndCallRequest(hangUp);
        const bad = { name: "request_callback", input: { name: "Alex Doe" } };
        const end = { name: END_CALL_TOOL_NAME, input: { goodbye: "Bye." } };
        const { streamLlm, requests } = scriptedStream([
          { toolCalls: order === "end_call last" ? [bad, end] : [end, bad] },
          { toolCalls: [{ name: "request_callback", input: callback }, end] },
        ]);
        const session = new AgentSession(runtime, idleLlm, { streamLlm });

        const turn = await streamTurn(session, "please have someone call me back, bye");

        expect(requests).toHaveLength(2);
        expect(turn.heard).toBe("Bye.");
        expect(hangUp).toHaveBeenCalledTimes(1);
        const results = session.messages.flatMap((message) =>
          message.role === "tool" ? [[message.toolName, message.result.ok !== false]] : [],
        );
        // In the model's order, whatever order they ran in.
        expect(results).toEqual(
          order === "end_call last"
            ? [["request_callback", false], [END_CALL_TOOL_NAME, false], ["request_callback", true], [END_CALL_TOOL_NAME, true]]
            : [[END_CALL_TOOL_NAME, false], ["request_callback", false], ["request_callback", true], [END_CALL_TOOL_NAME, true]],
        );
        const refusedEnd = session.messages.find(
          (message) => message.role === "tool" && message.toolName === END_CALL_TOOL_NAME,
        );
        expect(refusedEnd?.role === "tool" && refusedEnd.result.message).toBe(callStaysOpenAfter(["request_callback"]));
      }
    });
  });

  describe("follow-through: an action the reply speaks of is taken", () => {
    const callback = { name: "Alex Doe", phone: "555 0100", topic: "claim status" };
    const notes = (session: AgentSession) =>
      session.messages.flatMap((message) => (message.role === "user" && message.kind === "context_event" ? [message.content] : []));

    it("never says a tool call written as words, and asks the model once more with a note", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([
        { text: "Sure. request_callback(name=Alex Doe)" },
        { toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor will call you back." },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const turn = await streamTurn(session, "please have someone call me back");

      expect(turn.heard).toBe("An advisor will call you back.");
      expect(turn.errors).toEqual([]);
      expect(requests).toHaveLength(3);
      expect(notes(session)).toEqual([namedToolNote("request_callback")]);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("a second tool call written as words ends the turn on the fixed line", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([{ text: "request_callback()" }, { text: "request_callback(name=Alex)" }]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const turn = await streamTurn(session, "call me back");

      expect(requests).toHaveLength(2);
      expect(turn.errors.map((error) => error.kind)).toEqual(["empty_reply"]);
      expect(turn.heard).not.toContain("request_callback");
      warn.mockRestore();
    });

    it("asks once, after a statement, whether the reply spoke of a tool it did not call, and runs the call", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([
        { text: "I have noted your callback request." },
        { text: "This is never said.", toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor calls you tomorrow." },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "I'm Alex Doe, 555 0100, call me about my claim status");

      expect(requests).toHaveLength(3);
      const asked = requests[1]!.messages.at(-1);
      expect(asked?.role === "user" && asked.content).toBe(FOLLOW_THROUGH_CHECK);
      expect(turn.heard).toBe("I have noted your callback request. An advisor calls you tomorrow.");
      expect(turn.events.filter((event) => event.type === "tool").map((event) => event.type === "tool" && event.ok)).toEqual([true]);
      expect(notes(session)).toEqual([FOLLOW_THROUGH_CHECK]);
    });

    it("after a plain answer the check never offers end_call: an answer it misreads as a goodbye cannot hang up", async () => {
      for (const text of ["Your policy covers water damage.", "Alright, call us any time. Bye for now."]) {
        const runtime = createInsuranceDemoRuntime();
        const hangUp = vi.fn();
        runtime.setEndCallRequest(hangUp);
        const { streamLlm, requests } = scriptedStream([
          { text },
          { toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Goodbye." } }] },
        ]);
        const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

        const turn = await streamTurn(session, "does my policy cover water damage");

        expect(requests).toHaveLength(2);
        expect(requests[1]!.tools.map((tool) => tool.name)).not.toContain(END_CALL_TOOL_NAME);
        expect(turn.heard).toBe(text);
        expect(hangUp).not.toHaveBeenCalled();
      }
    });

    it("after the turn's own action, a goodbye without end_call is followed through: the check offers only end_call", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const { streamLlm, requests } = scriptedStream([
        { toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor calls you tomorrow. Goodbye." },
        { toolCalls: [{ name: "request_callback", input: callback }, { name: END_CALL_TOOL_NAME, input: { goodbye: "Bye." } }] },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "I'm Alex Doe, 555 0100, call me about my claim status, bye");

      expect(requests).toHaveLength(3);
      expect(requests[2]!.tools.map((tool) => tool.name)).toEqual([END_CALL_TOOL_NAME]);
      // A tool the check did not offer is never run, so the callback is not booked twice.
      expect(turn.events.filter((event) => event.type === "tool" && event.toolCall.name === "request_callback")).toHaveLength(1);
      expect(turn.heard).toBe("An advisor calls you tomorrow. Goodbye.");
      expect(hangUp).toHaveBeenCalledTimes(0);

      const { streamLlm: again } = scriptedStream([
        { toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor calls you tomorrow. Goodbye." },
        { toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Bye." } }] },
      ]);
      const ending = createInsuranceDemoRuntime();
      ending.setEndCallRequest(hangUp);
      const session2 = new AgentSession(ending, idleLlm, { streamLlm: again, checkFollowThrough: true });
      const ended = await streamTurn(session2, "I'm Alex Doe, 555 0100, call me about my claim status, bye");

      expect(ended.heard).toBe("An advisor calls you tomorrow. Goodbye.");
      expect(hangUp).toHaveBeenCalledTimes(1);
    });

    it("a callback rejected before its handler ran is no action: the check cannot hang up after it", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const { streamLlm, requests } = scriptedStream([
        { toolCalls: [{ name: "request_callback", input: { name: "Alex Doe" } }] },
        { text: "An advisor calls you tomorrow. Goodbye." },
        { toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "Bye." } }] },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "call me about my claim status, bye");

      const rejected = turn.events.find((event) => event.type === "tool" && event.toolCall.name === "request_callback");
      expect(rejected && rejected.type === "tool" ? rejected.ok : undefined).toBe(false);
      expect(requests.slice(2).flatMap((request) => request.tools.map((tool) => tool.name))).not.toContain(END_CALL_TOOL_NAME);
      expect(hangUp).toHaveBeenCalledTimes(0);
    });

    it("a restored tool result the guard cannot serialize never fails the answered turn", async () => {
      const { streamLlm, requests } = scriptedStream([{ text: "Your policy covers water damage." }, { text: "" }]);
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm, checkFollowThrough: true });
      session.restoreTranscript([
        { role: "user", content: "what is my claim number" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "request_callback", input: {} }] },
        {
          role: "tool",
          content: "noted",
          toolCallId: "c1",
          toolName: "request_callback",
          result: { ok: true, data: { claim: 12345678901234567890n } },
          contextDiff: [],
        },
        { role: "assistant", content: "Noted." },
      ]);

      const turn = await streamTurn(session, "does my policy cover water damage");

      expect(requests).toHaveLength(2);
      expect(turn.errors).toEqual([]);
      expect(turn.heard).toBe("Your policy covers water damage.");
    });

    it("the check's instructions hold the hang-up rules only when the check may call end_call", async () => {
      const hangUp = vi.fn();
      const plain = createInsuranceDemoRuntime();
      plain.setEndCallRequest(hangUp);
      const answered = scriptedStream([{ text: "Your policy covers water damage." }, { text: "" }]);
      await streamTurn(
        new AgentSession(plain, idleLlm, { streamLlm: answered.streamLlm, checkFollowThrough: true, spokenStyleSuffix: "## Voice" }),
        "does my policy cover water damage",
      );
      expect(answered.requests[0]!.systemPrompt).toContain(END_CALL_TOOL_NAME);
      expect(answered.requests[1]!.systemPrompt).not.toContain(END_CALL_TOOL_NAME);

      const acting = createInsuranceDemoRuntime();
      acting.setEndCallRequest(hangUp);
      const acted = scriptedStream([
        { toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor calls you tomorrow. Goodbye." },
        { text: "" },
      ]);
      await streamTurn(
        new AgentSession(acting, idleLlm, { streamLlm: acted.streamLlm, checkFollowThrough: true, spokenStyleSuffix: "## Voice" }),
        "I'm Alex Doe, 555 0100, call me about my claim status, bye",
      );
      expect(acted.requests[2]!.tools.map((tool) => tool.name)).toEqual([END_CALL_TOOL_NAME]);
      expect(acted.requests[2]!.systemPrompt).toContain(END_CALL_TOOL_NAME);
    });

    it("a check call carrying a number the conversation never had is not run: the check makes up no input", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([
        { text: "The advisor notes your number and calls you back." },
        { toolCalls: [{ name: "request_callback", input: { name: "Alex Doe", phone: "+1 123 456 789", topic: "claim" } }] },
        { text: "Your callback is noted." },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "I'm Alex Doe. How do callbacks work?");

      expect(requests).toHaveLength(2);
      expect(turn.heard).toBe("The advisor notes your number and calls you back.");
      expect(turn.events.filter((event) => event.type === "tool")).toEqual([]);
      expect(notes(session)).toEqual([]);
    });

    it("the check's number guard reads the tool's fields: a heard phone number fits its phone field, not an id", async () => {
      const said = "I'm Alex Doe, my number is +49 30 1234567, call me about my claim";
      const run = async (input: Record<string, string>) => {
        const { streamLlm } = scriptedStream([{ text: "I'm noting your callback." }, { toolCalls: [{ name: "request_callback", input }] }, { text: "" }]);
        const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm, checkFollowThrough: true });
        const turn = await streamTurn(session, said);
        return turn.events.filter((event) => event.type === "tool").length;
      };

      expect(await run({ name: "Alex Doe", phone: "030 1234567", topic: "claim" })).toBe(1);
      expect(await run({ name: "Alex Doe", phone: "+49 30 1234567", topic: "claim 0301234567" })).toBe(0);
    });

    it("a check call with a short made-up phone value is not run", async () => {
      const { streamLlm, requests } = scriptedStream([
        { text: "The advisor notes the caller's name and number and calls back." },
        { toolCalls: [{ name: "request_callback", input: { name: "Alex Doe", phone: "000", topic: "callbacks" } }] },
        { text: "Your callback is noted." },
      ]);
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "I'm Alex Doe. Who calls a caller back?");

      expect(requests).toHaveLength(2);
      expect(turn.events.filter((event) => event.type === "tool")).toEqual([]);
    });

    it("a check that finds nothing to do ends the turn as it was and leaves no trace", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([{ text: "Your policy covers water damage." }, { text: "Nothing to do." }]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "does my policy cover water damage");

      expect(requests).toHaveLength(2);
      expect(turn.heard).toBe("Your policy covers water damage.");
      expect(session.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "does my policy cover water damage"],
        ["assistant", "Your policy covers water damage."],
      ]);
    });

    it("checks nothing after a question, or when the session does not ask for it", async () => {
      for (const [text, checkFollowThrough] of [
        ["Shall I have an advisor call you?", true],
        ["I have noted your callback request.", false],
      ] as const) {
        const { streamLlm, requests } = scriptedStream([{ text }, { toolCalls: [{ name: "request_callback", input: callback }] }]);
        const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm, checkFollowThrough });

        const turn = await streamTurn(session, "call me back");

        expect(requests).toHaveLength(1);
        expect(turn.heard).toBe(text);
      }
    });

    it("sends no check after a statement when the turn's action already ran: nothing is left to offer", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([
        { toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor calls you tomorrow." },
        { toolCalls: [{ name: "request_callback", input: callback }] },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "I'm Alex Doe, 555 0100, call me about my claim status");

      expect(requests).toHaveLength(2);
      expect(turn.heard).toBe("An advisor calls you tomorrow.");
      expect(turn.events.filter((event) => event.type === "tool")).toHaveLength(1);
    });


    it("a skip_turn beside the check's call is dropped: a failed call is still repaired before the turn ends", async () => {
      const runtime = createInsuranceDemoRuntime();
      const { streamLlm, requests } = scriptedStream([
        { text: "I have noted your callback request." },
        { toolCalls: [{ name: "request_callback", input: { name: "Alex Doe" } }, { name: SKIP_TURN_TOOL_NAME, input: {} }] },
        { toolCalls: [{ name: "request_callback", input: callback }] },
        { text: "An advisor calls you tomorrow." },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm, checkFollowThrough: true });

      const turn = await streamTurn(session, "I'm Alex Doe, 555 0100, call me about my claim status");

      expect(requests).toHaveLength(4);
      const ran = turn.events.flatMap((event) => (event.type === "tool" ? [[event.toolCall.name, event.ok]] : []));
      expect(ran).toEqual([
        ["request_callback", false],
        ["request_callback", true],
      ]);
      expect(turn.heard).toBe("I have noted your callback request. An advisor calls you tomorrow.");
      expect(turn.errors).toEqual([]);
    });

    it("a check that fails or times out keeps the turn answered: no apology, no error, the cause logged", async () => {
      for (const failure of ["provider", "timeout"] as const) {
        const requests: AgentRunRequest[] = [];
        const streamLlm: AgentLlmStreamStep = async function* (request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { delta: "Your policy covers water damage.", text: "Your policy covers water damage." };
            return { text: "Your policy covers water damage.", toolCalls: [] };
          }
          if (failure === "provider") throw new Error("upstream 503");
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { text: "", toolCalls: [] };
        };
        const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, {
          streamLlm,
          checkFollowThrough: true,
          llmTimeoutMs: 20,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        const turn = await streamTurn(session, "does my policy cover water damage");

        expect(requests).toHaveLength(2);
        expect(turn.errors).toEqual([]);
        expect(turn.heard).toBe("Your policy covers water damage.");
        expect(turn.reply).toBe("Your policy covers water damage.");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
        expect(session.llmTrace.at(-1)?.error).toContain(failure === "provider" ? "upstream 503" : "20");
        expect(session.messages.map((message) => [message.role, message.content])).toEqual([
          ["user", "does my policy cover water damage"],
          ["assistant", "Your policy covers water damage."],
        ]);
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it("a caller who cancels during the check cancels the turn as before: nothing logged as a failed check", async () => {
      const cancel = new AbortController();
      let calls = 0;
      const streamLlm: AgentLlmStreamStep = async function* () {
        calls += 1;
        if (calls === 1) {
          yield { delta: "Your policy covers water damage.", text: "Your policy covers water damage." };
          return { text: "Your policy covers water damage.", toolCalls: [] };
        }
        cancel.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { text: "", toolCalls: [] };
      };
      const session = new AgentSession(createInsuranceDemoRuntime(), idleLlm, { streamLlm, checkFollowThrough: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const events: AgentTurnStreamEvent[] = [];
      for await (const event of session.runTurnStream("does my policy cover water damage", { spoken: true, signal: cancel.signal })) {
        events.push(event);
      }

      expect(calls).toBe(2);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("a typed reply that names a tool is answered in full: only speech is kept from saying tool names", async () => {
      const reply = "To get a callback, I use request_callback with your name and number.";
      const { session, llm } = makeSession([{ text: reply, toolCalls: [] }]);

      expect(await session.runTurn("which tool books a callback")).toBe(reply);
      expect(llm).toHaveBeenCalledTimes(1);
      expect(notes(session)).toEqual([]);
    });
  });

  describe("the greeting of a call (firstTurn: agent)", () => {
    const GREETING = "(The voice call has just connected. Greet the caller.)";
    const goodbye = "Glad I could help. Take care.";

    async function greet(direction?: "inbound" | "outbound") {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const { streamLlm, requests } = scriptedStream([
        { text: "Hi, I'm Lisa. I can help you with your policy.", toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye } }] },
        { text: "What can I do for you?" },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });
      if (direction) session.updateInfo({ "call.direction": direction });
      const events: AgentTurnStreamEvent[] = [];
      for await (const event of session.runTurnStream(GREETING, { spoken: true, kind: "synthetic" })) events.push(event);
      const done = events.at(-1);
      return { hangUp, requests, session, reply: done?.type === "done" ? done.reply : undefined };
    }

    it("never hangs up an inbound call: the end_call is refused, and the greeting goes on", async () => {
      for (const direction of [undefined, "inbound"] as const) {
        const { hangUp, requests, session, reply } = await greet(direction);

        expect(hangUp).not.toHaveBeenCalled();
        expect(requests).toHaveLength(2);
        expect(reply).toBe("Hi, I'm Lisa. What can I do for you?");
        expect(session.messages.find((message) => message.role === "tool")).toMatchObject({
          toolName: END_CALL_TOOL_NAME,
          result: {
            ok: false,
            message: "Not run: the call has just opened and the caller has not said anything yet. Finish your greeting and let them answer.",
          },
        });
      }
    });

    it("lets an outbound call hang up in its opening: it may have reached a voicemail", async () => {
      const { hangUp, requests, reply } = await greet("outbound");

      expect(hangUp).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
      expect(reply).toBe(`Hi, I'm Lisa. ${goodbye}`);
    });

    it("lets a later turn hang up once the agent greeted, even if the caller stays silent", async () => {
      const runtime = createInsuranceDemoRuntime();
      const hangUp = vi.fn();
      runtime.setEndCallRequest(hangUp);
      const { streamLlm } = scriptedStream([
        { text: "Hi, I'm Lisa. How can I help?" },
        { toolCalls: [{ name: END_CALL_TOOL_NAME, input: { goodbye: "I can't hear you, so I'll hang up. Goodbye." } }] },
      ]);
      const session = new AgentSession(runtime, idleLlm, { streamLlm });
      for await (const _event of session.runTurnStream(GREETING, { spoken: true, kind: "synthetic" })) void _event;
      for await (const _event of session.runTurnStream("(The caller has been silent.)", { spoken: true, kind: "synthetic" })) void _event;

      expect(hangUp).toHaveBeenCalledTimes(1);
    });
  });

  it("answers a failed LLM call with a fixed apology and reports the real error (no silent failure)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = createInsuranceDemoRuntime();
    const llm: AgentLlmClient = async () => {
      throw new Error("invalid x-api-key");
    };
    const session = new AgentSession(runtime, llm);

    const events: AgentTurnStreamEvent[] = [];
    for await (const event of session.runTurnStream("hello")) events.push(event);

    // The caller hears the apology, never the provider's error text…
    expect(events).toContainEqual({ type: "delta", delta: TURN_FAILED, text: TURN_FAILED });
    expect(events.at(-1)).toEqual({ type: "done", reply: TURN_FAILED });
    // …the transcript does not pretend the model said it…
    expect(session.messages.map((message) => message.role)).toEqual(["user"]);
    expect(JSON.stringify(session.messages)).not.toContain("x-api-key");
    // …developers get the cause, on the event and on the failed trace entry.
    expect(events).toContainEqual({ type: "error", error: { kind: "failed", message: "invalid x-api-key" } });
    expect(session.llmTrace.at(-1)?.error).toBe("invalid x-api-key");
    expect(session.isRunning).toBe(false);
  });

  it("speaks the fallback reply in the agent's language", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = new AgentSession(germanRuntime(), async () => {
      throw new Error("overloaded_error");
    });

    const turn = await streamTurn(session, "Ich brauche einen Termin.");

    const german = fallbackReplies("de").turnFailed;
    expect(german).toBe("Entschuldigung, bei mir ist etwas schiefgelaufen. Können Sie das bitte noch einmal sagen?");
    expect(turn.heard).toBe(german);
    expect(turn.reply).toBe(german);
    expect(turn.errors).toEqual([{ kind: "failed", message: "overloaded_error" }]);
    expect(session.messages.map((message) => message.role)).toEqual(["user"]);
  });

  describe("an empty final step", () => {
    it("is asked again once, and the second answer is the reply", async () => {
      const { session, llm } = makeSession([
        { text: "", toolCalls: [] },
        { text: "Here you go.", toolCalls: [] },
      ]);

      expect(await session.runTurn("hello?")).toBe("Here you go.");
      expect(llm).toHaveBeenCalledTimes(2);
      expect(session.messages.map((message) => message.content)).toEqual(["hello?", "Here you go."]);
    });

    it("empty twice ends the turn with an empty_reply error and the fallback reply", async () => {
      const { session, llm } = makeSession([
        { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }] },
        { text: "", toolCalls: [] },
        { text: "", toolCalls: [] },
        { text: "never asked", toolCalls: [] },
      ]);

      const events: AgentTurnStreamEvent[] = [];
      for await (const event of session.runTurnStream("my roof is leaking")) events.push(event);

      expect(llm).toHaveBeenCalledTimes(3);
      expect(events).toContainEqual({
        type: "error",
        error: { kind: "empty_reply", message: "The model answered with no text and no tool call, twice in a row." },
      });
      expect(events.at(-1)).toEqual({ type: "done", reply: TURN_FAILED });
      expect(session.llmTrace.at(-1)?.error).toContain("no text and no tool call");
      // The read_skill step stays; nothing was said, so nothing else is recorded.
      expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    });
  });

  describe("the date line", () => {
    it("every request carries today's date and time in the agent's time zone, and the next 14 days", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-23T15:51:00Z"));
      const runtime = createInsuranceDemoRuntime();
      const seen: AgentRunRequest[] = [];
      const session = new AgentSession(
        runtime,
        async (request) => {
          seen.push(request);
          return { text: "ok", toolCalls: [] };
        },
        { timeZone: "Europe/Berlin" },
      );

      await session.runTurn("what day is it?");

      const line = seen[0]!.stateSnapshot[0]!;
      const [today, days] = line.split(" The next days: ");
      expect(today).toBe("Today is Friday, October 23, 2026, 17:51 (Europe/Berlin).");
      const listed = days!.split(", ");
      expect(listed).toHaveLength(14);
      expect([listed[0], listed.at(-1)]).toEqual(["Sat Oct 24", "Fri Nov 6"]);
      // It reaches the model as the head of the current context, not in the system prompt…
      expect(seen[0]!.systemPrompt).not.toContain("Today is");
      const last = session.llmTrace[0]!.input.messages.at(-1);
      expect(typeof last?.content === "string" && last.content).toContain(line);
      // …and it is never rendered into the tree, so it causes no context event.
      expect(runtime.snapshot().stateSnapshot.join("\n")).not.toContain("Today is");
      expect(session.messages.some((message) => message.role === "user" && message.kind === "context_event")).toBe(false);
    });

    it("defaults to UTC and states it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-23T15:51:00Z"));
      const seen: AgentRunRequest[] = [];
      const session = new AgentSession(createInsuranceDemoRuntime(), async (request) => {
        seen.push(request);
        return { text: "ok", toolCalls: [] };
      });

      await session.runTurn("what time is it?");

      expect(seen[0]!.stateSnapshot[0]).toContain("Friday, October 23, 2026, 15:51 (UTC)");
    });

    it("follows the agent's language", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-23T15:51:00Z"));
      const seen: AgentRunRequest[] = [];
      const session = new AgentSession(
        germanRuntime(),
        async (request) => {
          seen.push(request);
          return { text: "Heute ist Freitag.", toolCalls: [] };
        },
        { timeZone: "Europe/Berlin" },
      );

      await session.runTurn("Welcher Tag ist heute?");

      expect(seen[0]!.stateSnapshot[0]).toMatch(
        /^Heute ist Freitag, 23\. Oktober 2026, 17:51 Uhr \(Europe\/Berlin\)\. Die nächsten Tage: Sa\.? 24\. Okt\./,
      );
    });

    it("refuses a time zone that does not exist", () => {
      expect(() => new AgentSession(createInsuranceDemoRuntime(), idleLlm, { timeZone: "Berlin" })).toThrow(
        /not an IANA time zone/,
      );
    });
  });

  it("reset() clears the transcript and LLM trace for a new conversation", async () => {
    const { session } = makeSession([{ text: "hello there", toolCalls: [] }]);
    await session.runTurn("hi");
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.llmTrace.length).toBeGreaterThan(0);

    let notified = false;
    session.subscribe(() => {
      notified = true;
    });
    session.reset();

    expect(session.messages).toEqual([]);
    expect(session.llmTrace).toEqual([]);
    expect(notified).toBe(true);
  });

  it("says why it stopped when the step limit is exhausted, and reports it as an error", async () => {
    // Every step calls a tool, so the turn can never finish on its own.
    const looping: AgentRunResponse = {
      text: "",
      toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }],
    };
    const runtime = createInsuranceDemoRuntime();
    const llm = vi.fn<AgentLlmClient>(async () => looping);
    const session = new AgentSession(runtime, llm, {
      maxSteps: 2,
    });

    const events: AgentTurnStreamEvent[] = [];
    for await (const event of session.runTurnStream("keep going forever")) events.push(event);

    const notice = fallbackReplies("en").stepLimit;
    expect(llm).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "delta", delta: notice, text: notice });
    expect(events).toContainEqual({ type: "error", error: expect.objectContaining({ kind: "step_limit" }) });
    expect(events.at(-1)).toEqual({ type: "done", reply: notice });
    // The notice is the framework's, not the model's: the transcript ends at the last tool result.
    expect(session.messages.at(-1)?.role).toBe("tool");
  });

  it("allows 8 steps per turn by default", async () => {
    const llm = vi.fn<AgentLlmClient>(async () => ({
      text: "",
      toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }],
    }));
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);

    await session.runTurn("keep going forever");

    expect(llm).toHaveBeenCalledTimes(8);
  });

  it("caps the transcript sent to the LLM without breaking tool pairing", async () => {
    const runtime = createInsuranceDemoRuntime();
    const seen: number[] = [];
    let firstRole: string | undefined;
    const llm: AgentLlmClient = async (request) => {
      seen.push(request.messages.length);
      firstRole = request.messages[0]?.role;
      return { text: "ok", toolCalls: [] };
    };
    const session = new AgentSession(runtime, llm, {
      maxTranscriptMessages: 4,
    });

    for (let turn = 0; turn < 6; turn += 1) {
      await session.runTurn(`message ${turn}`);
    }

    // The UI transcript keeps everything…
    expect(session.messages.length).toBe(12);
    // …but the LLM only ever sees the capped window, starting at a user message.
    expect(Math.max(...seen)).toBeLessThanOrEqual(4);
    expect(firstRole).toBe("user");
  });

  it("ignores empty input and re-entrant turns", async () => {
    const { session, llm } = makeSession([{ text: "hi", toolCalls: [] }]);

    expect(await session.runTurn("   ")).toBe("");
    expect(llm).not.toHaveBeenCalled();
    expect(session.messages).toEqual([]);
  });

  it("replaces exclamation marks in assistant replies", async () => {
    const { session } = makeSession([{ text: "Hi there! Welcome!", toolCalls: [] }]);

    const reply = await session.runTurn("hello");

    expect(reply).toBe("Hi there. Welcome.");
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hi there. Welcome." });
  });

  it("skip_turn ends the turn with no reply, even if the model also sent text", async () => {
    const { runtime, session } = makeSession([
      {
        // The model should never do this per prompt, but the session must not
        // half-honor it — dropping the text is what makes the tool reliable.
        text: "Okay, waiting.",
        toolCalls: [{ name: SKIP_TURN_TOOL_NAME, input: {} }],
      },
      { text: "should never run", toolCalls: [] },
    ]);

    const reply = await session.runTurn("hold on a sec");

    expect(reply).toBe("");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = session.messages[1];
    expect(assistant.content).toBe("");
    expect(assistant.role === "assistant" && assistant.toolCalls?.[0]).toMatchObject({
      name: SKIP_TURN_TOOL_NAME,
    });
    // The turn stopped after step 1 — the second queued response never ran.
    expect(session.llmTrace).toHaveLength(1);
    // A real runtime tool call happened (tool_use/tool_result pairing holds).
    const outcome = await runtime.callTool(SKIP_TURN_TOOL_NAME, {});
    expect(outcome.result).toEqual({ ok: true });
  });

  it("a step that saves and hangs up says only its goodbye, recorded as the reply after both results", async () => {
    const runtime = createInsuranceDemoRuntime();
    const hangUp = vi.fn();
    runtime.setEndCallRequest(hangUp);
    let step = 0;
    const responses: AgentRunResponse[] = [
      {
        // The words of a step that calls a tool are narration, end_call or not.
        text: "The caller declined and gave feedback, so I save it and say goodbye.",
        toolCalls: [
          { name: "request_callback", input: { name: "Ada", phone: "+491234567", topic: "Feedback" } },
          { name: END_CALL_TOOL_NAME, input: { goodbye: "Thanks for your feedback! Goodbye." } },
        ],
      },
      { text: "should never run", toolCalls: [] },
    ];
    const llm = vi.fn<AgentLlmClient>(async () => responses[step++] ?? { text: "", toolCalls: [] });
    const session = new AgentSession(runtime, llm, {
      spokenStyleSuffix: "## Voice rules\nSpeak briefly.",
    });

    const reply = await session.runTurn("No thanks, but the voice was great. Bye.", { spoken: true });

    expect(reply).toBe("Thanks for your feedback. Goodbye.");
    expect(hangUp).toHaveBeenCalledTimes(1);
    const [, step1, saved, ended, goodbye, ...rest] = session.messages;
    expect(rest).toEqual([]);
    expect(step1).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "request_callback" }, { name: END_CALL_TOOL_NAME }],
    });
    expect(saved).toMatchObject({ role: "tool", toolName: "request_callback", result: { ok: true } });
    expect(ended).toMatchObject({ role: "tool", toolName: END_CALL_TOOL_NAME, result: { ok: true } });
    // What the caller heard is the agent's reply on record.
    expect(goodbye).toEqual({ role: "assistant", content: "Thanks for your feedback. Goodbye.", at: expect.any(Number) });
    expect(session.llmTrace).toHaveLength(1);

    // Voice turns are told how to use the tool only while it exists, and it takes the goodbye.
    const request = llm.mock.calls[0]![0];
    expect(request.systemPrompt).toContain("## Ending the call");
    expect(request.tools.find((tool) => tool.name === END_CALL_TOOL_NAME)?.inputSchema).toMatchObject({
      required: ["goodbye"],
    });
  });

  it("skip_turn streams no deltas and ends runTurnStream with an empty reply", async () => {
    const runtime = createInsuranceDemoRuntime();
    const llm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });
    async function* streamStep(): AsyncGenerator<{ delta: string; text: string }, AgentRunResponse> {
      // The model calls skip_turn as its very first action — no deltas.
      return { text: "", toolCalls: [{ name: SKIP_TURN_TOOL_NAME, input: {} }] };
    }
    const session = new AgentSession(runtime, llm, {
      streamLlm: () => streamStep(),
    });

    const events: string[] = [];
    let doneReply = "unset";
    for await (const event of session.runTurnStream("never mind")) {
      events.push(event.type);
      if (event.type === "done") doneReply = event.reply;
    }

    // No text deltas, but the skip_turn tool call is emitted (chat shows it
    // as "Stayed silent"; the voice panel renders the same tool row).
    expect(events).toEqual(["tool", "done"]);
    expect(doneReply).toBe("");
  });
});
