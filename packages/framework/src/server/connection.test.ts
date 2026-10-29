import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { openingLineOf } from "../config.js";
import { createInsuranceDemoRuntime, INSURANCE_AGENT_SYSTEM_PROMPT } from "../test-fixtures/insurance-runtime.js";
import { ConnectionController } from "./connection.js";
import type { PreviewAgent, ServerMessage } from "./protocol.js";

/** The agent as the preview shows it; the connection only passes it on. */
const preview = (id: string): PreviewAgent => ({ id, source: "", preview: {}, skills: [] });

function makeController(llm: AgentLlmClient) {
  const runtime = createInsuranceDemoRuntime();
  const session = new AgentSession(runtime, llm);
  const sent: ServerMessage[] = [];
  const controller = new ConnectionController((message) => sent.push(message), {
    runtime,
    session,
  });
  return { runtime, session, controller, sent };
}

const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });

describe("ConnectionController", () => {
  it("pushes an initial context/messages/running snapshot on start", () => {
    const { controller, sent } = makeController(idleLlm);
    controller.start();

    const types = sent.map((message) => message.type);
    expect(types).toEqual([
      "context",
      "messages",
      "llm_trace",
      "running",
      "conversations",
      "mcp_servers",
    ]);
    const context = sent.find((m) => m.type === "context");
    // A conversation starts at the agent level, with no skill loaded.
    expect(context && context.type === "context" && context.context.path).toBe("");
  });

  it("maps a user_text turn to messages + running frames", async () => {
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Hello there.", toolCalls: [] }));
    const { controller, sent } = makeController(llm);
    controller.start();
    sent.length = 0;

    await controller.handle({ type: "user_text", text: "hi" });

    const messageFrames = sent.filter((m) => m.type === "messages");
    const last = messageFrames.at(-1);
    expect(last && last.type === "messages" && last.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Hello there.",
    });
    // running toggled back to false by the end of the turn.
    const runningFrames = sent.filter((m) => m.type === "running");
    expect(runningFrames.at(-1)).toEqual({ type: "running", value: false });
  });

  it("answers two typed messages sent back-to-back, in order", async () => {
    let calls = 0;
    const llm: AgentLlmClient = async () => {
      calls += 1;
      const reply = `Reply ${calls}.`;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: reply, toolCalls: [] };
    };
    const { controller, session, sent } = makeController(llm);
    controller.start();

    // The socket dispatches without awaiting, so the second arrives mid-turn.
    await Promise.all([
      controller.handle({ type: "user_text", text: "one" }),
      controller.handle({ type: "user_text", text: "two" }),
    ]);

    expect(session.messages.map((message) => message.content)).toEqual(["one", "Reply 1.", "two", "Reply 2."]);
    expect(sent.filter((m) => m.type === "error")).toEqual([]);
  });

  it("a failed turn sends the cause as an llm error frame; the transcript gets only the apology", async () => {
    const llm: AgentLlmClient = async () => {
      throw new Error("429 rate limited by provider");
    };
    const { controller, session, sent } = makeController(llm);
    controller.start();

    await controller.handle({ type: "user_text", text: "hi" });

    expect(sent.find((m) => m.type === "error")).toEqual({
      type: "error",
      scope: "llm",
      message: "429 rate limited by provider",
    });
    // The content only: a message's `at` timestamp can contain the digits 429.
    expect(session.messages.map((message) => message.content).join("\n")).not.toContain("429");
  });

  it("emits a context frame after read_skill", async () => {
    const { controller, sent } = makeController(idleLlm);
    controller.start();
    sent.length = 0;

    await controller.handle({ type: "read_skill", skill: "/property-damage" });

    const context = sent.find((m) => m.type === "context");
    expect(context && context.type === "context" && context.context.path).toBe("/property-damage");
  });

  it("surfaces an unknown tool as an explicit error frame (no silent failure)", async () => {
    const { controller, sent } = makeController(idleLlm);
    controller.start();
    sent.length = 0;

    await controller.handle({ type: "call_tool", name: "does_not_exist", input: {} });

    const error = sent.find((m) => m.type === "error");
    expect(error).toMatchObject({ type: "error", scope: "tool" });
  });

  it("switches agents: fresh session, agents frame, full snapshot", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const otherRuntime = createInsuranceDemoRuntime();
    const otherSession = new AgentSession(otherRuntime, idleLlm);
    const create = vi.fn(async () => ({ runtime: otherRuntime, session: otherSession }));

    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance", "ops"],
        initialId: "insurance",
        create,
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();

    // start() announces the available agents and the active one, described for the preview.
    expect(sent.find((m) => m.type === "agents")).toEqual({
      type: "agents",
      agents: ["insurance", "ops"],
      active: preview("insurance"),
    });
    sent.length = 0;

    // Unknown id -> explicit error, current session untouched.
    await controller.handle({ type: "select_agent", id: "nope" });
    expect(sent.find((m) => m.type === "error")).toMatchObject({ scope: "protocol" });
    expect(create).not.toHaveBeenCalled();
    sent.length = 0;

    // Re-selecting the active agent is a no-op beyond re-announcing.
    await controller.handle({ type: "select_agent", id: "insurance" });
    expect(create).not.toHaveBeenCalled();
    sent.length = 0;

    // Real switch: new session bound, agents + snapshot pushed.
    await controller.handle({ type: "select_agent", id: "ops" });
    expect(create).toHaveBeenCalledWith("ops");
    expect(sent.find((m) => m.type === "agents")).toEqual({
      type: "agents",
      agents: ["insurance", "ops"],
      active: preview("ops"),
    });
    expect(sent.filter((m) => m.type === "context").length).toBeGreaterThan(0);

    // Turns now run on the NEW session.
    sent.length = 0;
    await controller.handle({ type: "user_text", text: "hi" });
    expect(otherSession.messages.some((message) => message.content === "hi")).toBe(true);
    expect(session.messages).toEqual([]);
  });

  it("creates and restores complete conversation sessions", async () => {
    const bundles: Array<{ runtime: ReturnType<typeof createInsuranceDemoRuntime>; session: AgentSession }> = [];
    const create = async () => {
      const runtime = createInsuranceDemoRuntime();
      const session = new AgentSession(runtime, idleLlm);
      const bundle = { runtime, session };
      bundles.push(bundle);
      return bundle;
    };
    const initial = await create();
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      ...initial,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create,
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();

    await controller.handle({ type: "user_text", text: "First conversation" });
    await controller.handle({ type: "read_skill", skill: "/property-damage" });
    const firstHistory = sent.filter((message) => message.type === "conversations").at(-1);
    if (!firstHistory || firstHistory.type !== "conversations") throw new Error("missing history");
    const firstId = firstHistory.active;
    expect(firstHistory.conversations[0]).toMatchObject({
      id: firstId,
      title: "First conversation",
    });

    await controller.handle({ type: "reset" });
    const afterReset = sent.filter((message) => message.type === "conversations").at(-1);
    if (!afterReset || afterReset.type !== "conversations") throw new Error("missing history");
    expect(afterReset.conversations).toHaveLength(2);
    expect(afterReset.active).not.toBe(firstId);
    const latestMessages = sent.filter((message) => message.type === "messages").at(-1);
    expect(latestMessages).toEqual({ type: "messages", messages: [] });
    const latestContext = sent.filter((message) => message.type === "context").at(-1);
    expect(latestContext && latestContext.type === "context" && latestContext.context.path).toBe("");

    await controller.handle({ type: "select_conversation", id: firstId });
    const restoredMessages = sent.filter((message) => message.type === "messages").at(-1);
    expect(restoredMessages && restoredMessages.type === "messages" && restoredMessages.messages[0]).toMatchObject({
      role: "user",
      content: "First conversation",
    });
    const restoredContext = sent.filter((message) => message.type === "context").at(-1);
    expect(restoredContext && restoredContext.type === "context" && restoredContext.context.path).toBe(
      "/property-damage",
    );

    sent.length = 0;
    await controller.handle({ type: "select_conversation", id: "missing" });
    expect(sent).toContainEqual({
      type: "error",
      scope: "protocol",
      message: 'Unknown conversation "missing".',
    });
  });

  it("inspects the agent level as the empty path, and leaves the inspector usable", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => ({ runtime, session }),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();
    sent.length = 0;

    // The page opens on the conversation's own path, which is "" until a skill is read.
    await controller.handle({ type: "inspect_skill", skill: "" });
    expect(sent.find((message) => message.type === "error")).toBeUndefined();
    const agentLevel = sent.find((message) => message.type === "inspect_context");
    expect(agentLevel).toMatchObject({ type: "inspect_context", skill: "", context: { path: "", loadedSkills: [] } });

    // A skill opens as before, and a tool run on the agent level comes back to it.
    await controller.handle({ type: "inspect_skill", skill: "/member-portal" });
    await controller.handle({ type: "inspect_skill", skill: "" });
    sent.length = 0;
    await controller.handle({ type: "call_tool", name: "request_callback", input: { name: "A", phone: "1", topic: "t" } });
    expect(sent.find((message) => message.type === "error")).toBeUndefined();
    expect(sent.filter((message) => message.type === "inspect_context").at(-1)).toMatchObject({ skill: "", canUndo: true });
    await controller.handle({ type: "inspect_undo" });
    expect(sent.find((message) => message.type === "error")).toBeUndefined();
    expect(session.messages).toEqual([]);
  });

  it("inspects skills and runs UI tools WITHOUT touching the agent session", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => ({ runtime, session }),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();
    sent.length = 0;

    // Browsing a skill compiles it on the shadow runtime...
    await controller.handle({ type: "inspect_skill", skill: "/property-damage" });
    const inspect = sent.find((m) => m.type === "inspect_context");
    expect(inspect && inspect.type === "inspect_context" && inspect.context.path).toBe(
      "/property-damage",
    );
    // ...while the agent session stays at the agent level with an empty transcript.
    expect(runtime.snapshot().context.path).toBe("");
    expect(session.messages).toEqual([]);

    // A UI tool form runs on the shadow too: result frame, no session events.
    sent.length = 0;
    await controller.handle({
      type: "call_tool",
      name: "request_callback",
      input: { name: "A", phone: "1", topic: "t" },
    });
    expect(sent.find((m) => m.type === "inspect_context")).toBeDefined();
    expect(session.messages).toEqual([]);
  });

  it("inspect_undo reverts the shadow's last state change via replay", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => ({ runtime, session }),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();
    sent.length = 0;

    const lastInspect = () => {
      const frame = sent.filter((m) => m.type === "inspect_context").at(-1);
      if (!frame || frame.type !== "inspect_context") throw new Error("no inspect frame");
      return frame;
    };

    // Navigating to the member portal shows it fresh — nothing to undo yet
    // (navigation is not a state change, just switching which skill is shown).
    await controller.handle({ type: "inspect_skill", skill: "/member-portal" });
    expect(lastInspect().canUndo).toBe(false);

    // Verifying an email flips the page state — now undoable.
    await controller.handle({
      type: "call_tool",
      name: "verify_member_email",
      input: { email: "max@example.com" },
    });
    expect(lastInspect().context.content.join("\n")).toContain("Member profile");
    expect(lastInspect().canUndo).toBe(true);

    // Undo the verification: fresh member-portal runtime, zero tool calls
    // replayed — back to the locked state, nothing left to revert.
    sent.length = 0;
    await controller.handle({ type: "inspect_undo" });
    const frame = lastInspect();
    expect(frame.context.path).toBe("/member-portal");
    expect(frame.context.content.join("\n")).not.toContain("Member profile");
    expect(frame.context.content.join("\n")).toContain("locked");
    expect(frame.canUndo).toBe(false);

    // The live agent session never noticed any of it.
    expect(session.messages).toEqual([]);
    expect(runtime.snapshot().context.path).toBe("");
  });

  it("rewinds the conversation: transcript truncates AND the environment replays to that point", async () => {
    // Scripted LLM: turn 1 loads the member portal and verifies (two tool
    // steps + a reply), later turns are plain replies.
    let call = 0;
    const llm: AgentLlmClient = async () => {
      call += 1;
      if (call === 1) {
        return { text: "", toolCalls: [{ name: "read_skill", input: { skill: "/member-portal" } }] };
      }
      if (call === 2) {
        return {
          text: "",
          toolCalls: [{ name: "verify_member_email", input: { email: "max@example.com" } }],
        };
      }
      return { text: `Reply ${call}.`, toolCalls: [] };
    };
    const makeBundle = () => {
      const runtime = createInsuranceDemoRuntime();
      const session = new AgentSession(runtime, llm);
      return { runtime, session };
    };

    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      ...makeBundle(),
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => makeBundle(),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();

    const lastMessages = () => {
      const frame = sent.filter((m) => m.type === "messages").at(-1);
      if (!frame || frame.type !== "messages") throw new Error("no messages frame");
      return frame.messages;
    };
    const lastSnapshot = () => {
      const frame = sent.filter((m) => m.type === "context").at(-1);
      if (!frame || frame.type !== "context") throw new Error("no context frame");
      return frame.stateSnapshot.join("\n");
    };

    await controller.handle({ type: "user_text", text: "Show me my member info" });
    await controller.handle({ type: "user_text", text: "Thanks!" });

    // Environment after both turns: member portal active and UNLOCKED.
    expect(lastSnapshot()).toContain("Member profile: Max");
    const transcript = lastMessages();
    const secondUserIndex = transcript.findIndex(
      (message) => message.role === "user" && message.content === "Thanks!",
    );
    expect(secondUserIndex).toBeGreaterThan(0);

    // Rewinding to a non-user message is rejected loudly.
    sent.length = 0;
    await controller.handle({ type: "rewind", index: 1 });
    expect(sent.find((m) => m.type === "error")).toMatchObject({ scope: "protocol" });

    // Retry turn 2: earlier turns replay onto a fresh runtime (member portal
    // still verified), the message STAYS, and it gets a FRESH answer.
    sent.length = 0;
    await controller.handle({ type: "rewind", index: secondUserIndex });
    const retried = lastMessages();
    expect(retried).toHaveLength(secondUserIndex + 2); // kept prefix + user + new reply
    expect(retried[secondUserIndex]).toMatchObject({ role: "user", content: "Thanks!" });
    expect(retried.at(-1)?.content).toBe("Reply 5."); // a NEW llm call answered it
    expect(lastSnapshot()).toContain("Member profile: Max");

    // The conversation continues from there on the rebuilt session.
    await controller.handle({ type: "user_text", text: "Different follow-up" });
    expect(lastMessages().at(-1)?.content).toContain("Reply");

    // ROLLBACK (rerun: false) to before the follow-up: the message is dropped
    // too — the user rewrites it — while the earlier turns' environment
    // replays (member portal still verified).
    const followUpIndex = lastMessages().findIndex(
      (message) => message.role === "user" && message.content === "Different follow-up",
    );
    expect(followUpIndex).toBeGreaterThan(0);
    sent.length = 0;
    await controller.handle({ type: "rewind", index: followUpIndex, rerun: false });
    expect(lastMessages()).toHaveLength(followUpIndex);
    expect(lastMessages().at(-1)?.role).toBe("assistant");
    expect(lastSnapshot()).toContain("Member profile: Max");

    // Retry the FIRST message: pristine environment for the replay (nothing
    // before it), the message re-runs from scratch.
    sent.length = 0;
    await controller.handle({ type: "rewind", index: 0 });
    const restarted = lastMessages();
    expect(restarted[0]).toMatchObject({ role: "user", content: "Show me my member info" });
    // The scripted LLM is past its tool steps now — plain reply, no tools, so
    // the environment stays pristine: the agent level, no skill, no member state.
    expect(restarted.at(-1)?.content).toBe("Reply 7.");
    expect(lastSnapshot()).not.toContain("Member profile");
    expect(lastSnapshot()).not.toContain("active_skill:");
  });

  it("keeps inspector state across navigation — a login survives browsing away", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => ({ runtime, session }),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();

    const lastInspect = () => {
      const frame = sent.filter((m) => m.type === "inspect_context").at(-1);
      if (!frame || frame.type !== "inspect_context") throw new Error("no inspect frame");
      return frame;
    };

    // Log in on the member portal...
    await controller.handle({ type: "inspect_skill", skill: "/member-portal" });
    await controller.handle({
      type: "call_tool",
      name: "verify_member_email",
      input: { email: "max@example.com" },
    });
    expect(lastInspect().context.content.join("\n")).toContain("Member profile");

    // ...browse away and come back: STILL logged in (the runtime persists;
    // only the view is per-skill).
    await controller.handle({ type: "inspect_skill", skill: "/policy-questions" });
    await controller.handle({ type: "inspect_skill", skill: "/member-portal" });
    const frame = lastInspect();
    expect(frame.context.content.join("\n")).toContain("Member profile");
    expect(frame.context.tools.map((tool) => tool.name)).not.toContain("verify_member_email");

    // The view meanwhile stayed isolated: policy-questions never showed the
    // member portal's state or tools.
    const policyFrame = sent
      .filter((m) => m.type === "inspect_context")
      .find((m) => m.type === "inspect_context" && m.skill === "/policy-questions");
    if (!policyFrame || policyFrame.type !== "inspect_context") throw new Error("missing frame");
    expect(policyFrame.context.content.join("\n")).not.toContain("Member profile");
  });

  it("inspects each skill in isolation — no tool leakage from other skills", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => ({ runtime, session }),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();

    const lastInspect = () => {
      const frame = sent.filter((m) => m.type === "inspect_context").at(-1);
      if (!frame || frame.type !== "inspect_context") throw new Error("no inspect frame");
      return frame;
    };

    // Visit member portal and unlock it (loads its tool + flips shared state)...
    await controller.handle({ type: "inspect_skill", skill: "/member-portal" });
    await controller.handle({
      type: "call_tool",
      name: "verify_member_email",
      input: { email: "max@example.com" },
    });
    // ...then navigate to property damage: it must show ONLY its own tools in
    // its own initial state — none of member-portal's, no cross-skill leak.
    sent.length = 0;
    await controller.handle({ type: "inspect_skill", skill: "/property-damage" });
    const pageTools = lastInspect()
      .context.tools.filter((tool) => tool.scope === "page")
      .map((tool) => tool.name);
    expect(pageTools).not.toContain("verify_member_email");
    // Property damage's intake is gated behind the (unrun) claim procedure, so
    // in isolation it stays locked — no stray tools at all.
    expect(pageTools).toEqual([]);
    expect(lastInspect().context.content.join("\n")).toContain("locked");
  });
});

describe("ConnectionController voice attachment", () => {
  function makeVoiceCall() {
    return {
      transport: "livekit" as const,
      url: "ws://livekit.local",
      token: "tok-1",
      room: "curb-abc",
      sendText: vi.fn(async (_text: string): Promise<void> => undefined),
      setBundle: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(async () => undefined),
    };
  }

  function makeVoiceController(llm: AgentLlmClient = idleLlm) {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, llm);
    const call = makeVoiceCall();
    let onClosed: (() => void) | undefined;
    const start = vi.fn(async (args: { onClosed: () => void }) => {
      onClosed = args.onClosed;
      return call;
    });
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create: async () => ({ runtime: createInsuranceDemoRuntime(), session: new AgentSession(createInsuranceDemoRuntime(), llm) }),
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
      voiceHost: { start },
    });
    return { controller, sent, call, start, session, serverClose: () => onClosed?.() };
  }

  it("voice_start without a voice host is an explicit voice-scoped error", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), { runtime, session });
    controller.start();
    sent.length = 0;

    await controller.handle({ type: "voice_start" });
    expect(sent.find((m) => m.type === "error")).toMatchObject({ scope: "voice" });
  });

  it("voice_start attaches a call to THIS session and returns the ticket", async () => {
    const { controller, sent, start } = makeVoiceController();
    controller.start();
    sent.length = 0;

    await controller.handle({ type: "voice_start" });
    expect(start).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toEqual({
      type: "voice_session",
      live: true,
      transport: "livekit" as const,
      url: "ws://livekit.local",
      token: "tok-1",
      room: "curb-abc",
    });

    // Idempotent while live: a second start resends the ticket, no new room.
    await controller.handle({ type: "voice_start" });
    expect(start).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toMatchObject({ type: "voice_session", live: true, token: "tok-1" });
  });

  it("typed input during a live call runs through the voice pipeline", async () => {
    const { controller, call } = makeVoiceController();
    controller.start();
    await controller.handle({ type: "voice_start" });

    await controller.handle({ type: "user_text", text: "also add oat milk" });
    expect(call.sendText).toHaveBeenCalledWith("also add oat milk");
  });

  it("waits for a typed voice barge-in to reconcile before completing the input", async () => {
    const { controller, call } = makeVoiceController();
    controller.start();
    await controller.handle({ type: "voice_start" });
    let release!: () => void;
    call.sendText.mockImplementation(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let handled = false;
    const handling = controller
      .handle({ type: "user_text", text: "typed interruption" })
      .then(() => {
        handled = true;
      });
    await Promise.resolve();
    expect(handled).toBe(false);
    release();
    await handling;
    expect(handled).toBe(true);
  });

  it("voice_stop hangs up and the conversation continues by text", async () => {
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "By text now.", toolCalls: [] }));
    const { controller, sent, call } = makeVoiceController(llm);
    controller.start();
    await controller.handle({ type: "voice_start" });
    sent.length = 0;

    await controller.handle({ type: "voice_stop" });
    expect(call.close).toHaveBeenCalledOnce();
    expect(sent[0]).toEqual({ type: "voice_session", live: false });

    await controller.handle({ type: "user_text", text: "hi" });
    expect(call.sendText).not.toHaveBeenCalled();
    expect(llm).toHaveBeenCalledOnce();
  });

  it("says why a call did not close cleanly", async () => {
    const { controller, sent, call } = makeVoiceController();
    controller.start();
    await controller.handle({ type: "voice_start" });
    call.close.mockRejectedValueOnce(new Error("room already deleted"));
    sent.length = 0;

    await controller.handle({ type: "voice_stop" });

    expect(sent).toContainEqual({
      type: "error",
      scope: "voice",
      message: "The call did not close cleanly: room already deleted",
    });
  });

  it("a server-side hangup is reflected to the client exactly once", async () => {
    const { controller, sent, serverClose } = makeVoiceController();
    controller.start();
    await controller.handle({ type: "voice_start" });
    sent.length = 0;

    serverClose();
    serverClose();
    expect(sent).toEqual([{ type: "voice_session", live: false }]);
  });

  it("rewind during a call interrupts speech and repoints the call at the rebuilt session", async () => {
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Reply.", toolCalls: [] }));
    const { controller, call, session } = makeVoiceController(llm);
    controller.start();
    await controller.handle({ type: "voice_start" });
    await session.runTurn("first message");

    await controller.handle({ type: "rewind", index: 0, rerun: true });
    expect(call.interrupt).toHaveBeenCalled();
    expect(call.setBundle).toHaveBeenCalledOnce();
    // The retry is spoken: routed through the call, not the chat turn.
    expect(call.sendText).toHaveBeenCalledWith("first message");
  });

  it("dispose tears the call down", async () => {
    const { controller, call } = makeVoiceController();
    controller.start();
    await controller.handle({ type: "voice_start" });

    controller.dispose();
    expect(call.close).toHaveBeenCalledOnce();
  });

  it("streams assistant deltas to the client no matter who drives the turn", async () => {
    const runtime = createInsuranceDemoRuntime();
    // Streaming transport: two token batches, then the final response.
    async function* streamLlm() {
      yield { delta: "Hel", text: "Hel" };
      yield { delta: "lo.", text: "Hello." };
      return { text: "Hello.", toolCalls: [] };
    }
    const session = new AgentSession(runtime, idleLlm, { streamLlm });
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session,
    });
    controller.start();
    sent.length = 0;

    // Drive the turn OUTSIDE the controller — exactly what the voice
    // pipeline does. The client must still see the generation stream.
    for await (const event of session.runTurnStream("hi", { spoken: true })) void event;

    const deltas = sent.filter((m) => m.type === "assistant_delta").map((m) => m.type === "assistant_delta" && m.text);
    // A sentence streams once it is complete: the last one is held until the step
    // ends, so a step that turns into a tool call never speaks it.
    expect(deltas).toEqual(["Hello."]);
    controller.dispose();
  });
});

describe("conversations recorded before this connection", () => {
  const history = {
    list: () => [{ id: 7, agentId: "insurance", startedAt: Date.now() - 60_000, messageCount: 2 }],
    messages: () => [
      { role: "user" as const, content: "Was macht ihr?" },
      { role: "assistant" as const, content: "Wir bauen Voice-Agents." },
    ],
    systemPrompt: (id: number) => (id === 7 ? "Du bist der Agent von damals." : null),
  };

  // A restored session has sent no prompt yet, so the export fell back to the code's,
  // although the store kept the one the conversation ran with.
  it("names the prompt a restored conversation ran with, and only while it is the active one", async () => {
    const runtime = createInsuranceDemoRuntime();
    const sent: ServerMessage[] = [];
    const create = vi.fn(async () => {
      const fresh = createInsuranceDemoRuntime();
      return { runtime: fresh, session: new AgentSession(fresh, idleLlm) };
    });
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session: new AgentSession(runtime, idleLlm),
      agentHost: { ids: ["insurance"], initialId: "insurance", create, createRuntime: async () => runtime, preview },
      history,
    });
    controller.start();
    const lastConversations = () => {
      const frame = sent.filter((message) => message.type === "conversations").at(-1);
      if (frame?.type !== "conversations") throw new Error("missing conversations frame");
      return frame;
    };
    const live = lastConversations().active;
    expect(lastConversations().recordedSystemPrompt).toBeUndefined();

    await controller.handle({ type: "select_conversation", id: "stored-7" });
    expect(lastConversations()).toMatchObject({ active: "stored-7", recordedSystemPrompt: "Du bist der Agent von damals." });

    await controller.handle({ type: "select_conversation", id: live });
    expect(lastConversations().recordedSystemPrompt).toBeUndefined();
  });

  // The point of the whole feature: a refresh is a NEW connection, so what it can
  // offer has to come from somewhere outside it. Before this, the sidebar showed
  // only the conversation that connection had just started.
  it("offers them in the sidebar without building a runtime for each", () => {
    const runtime = createInsuranceDemoRuntime();
    const sent: ServerMessage[] = [];
    const create = vi.fn(async () => ({ runtime, session: new AgentSession(runtime, idleLlm) }));

    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session: new AgentSession(runtime, idleLlm),
      agentHost: { ids: ["insurance"], initialId: "insurance", create, createRuntime: async () => runtime, preview },
      history,
    });
    controller.start();

    const frame = sent.find((message) => message.type === "conversations");
    expect(frame).toBeDefined();
    if (frame?.type !== "conversations") throw new Error("unreachable");

    // Both the live one and the stored one, the stored one titled from its
    // transcript rather than from a session it does not have yet.
    expect(frame.conversations).toHaveLength(2);
    expect(frame.conversations.map((c) => c.title)).toContain("Was macht ihr?");
    // Listing must stay cheap: nothing is replayed until one is opened.
    expect(create).not.toHaveBeenCalled();
  });

  // A host with no registry cannot replay a transcript, and has to say so rather
  // than switch to an empty session that answers as if the history were loaded.
  it("refuses to open one when the host has no agent registry", async () => {
    const runtime = createInsuranceDemoRuntime();
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), {
      runtime,
      session: new AgentSession(runtime, idleLlm),
      history,
    });
    controller.start();

    await controller.handle({ type: "select_conversation", id: "stored-7" });

    const error = sent.find((message) => message.type === "error");
    expect(error).toBeDefined();
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.message).toMatch(/agent registry/i);
  });
});

describe("the page the preview runs in", () => {
  /** A connection whose every conversation is a fresh session opening with `line`. */
  function pageConnection(line: string) {
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Gern.", toolCalls: [] }));
    const bundles: Array<{ runtime: ReturnType<typeof createInsuranceDemoRuntime>; session: AgentSession }> = [];
    const create = async () => {
      const runtime = createInsuranceDemoRuntime();
      const session = new AgentSession(runtime, llm, {
        opening: openingLineOf({ say: (info) => `${line} ${String(info["client.event"] ?? "")}`.trim() }),
      });
      bundles.push({ runtime, session });
      return { runtime, session };
    };
    return { llm, bundles, create };
  }

  it("puts its client.* info on every conversation it starts, before the agent opens", async () => {
    const { bundles, create } = pageConnection("Willkommen.");
    const initial = await create();
    const controller = new ConnectionController(() => {}, {
      ...initial,
      agentHost: {
        ids: ["insurance"],
        initialId: "insurance",
        create,
        createRuntime: async () => createInsuranceDemoRuntime(),
        preview,
      },
    });
    controller.start();

    await controller.handle({ type: "set_info", values: { "client.event": "webinar-11-04", "user.id": "u1" } });
    await controller.handle({ type: "user_text", text: "Hallo" });
    await controller.handle({ type: "reset" });
    await controller.handle({ type: "user_text", text: "Hallo nochmal" });

    expect(bundles).toHaveLength(2);
    // Each conversation opened with the line the page's info wrote.
    const opening = ({ session }: (typeof bundles)[number]) =>
      session.messages.find((message) => message.role === "assistant")?.content;
    expect(bundles.map(opening)).toEqual(["Willkommen. webinar-11-04", "Willkommen. webinar-11-04"]);
    // Only the page's info carries over; other info stays with the conversation it was set on.
    expect(bundles[1].runtime.info.snapshot()).toEqual({ "client.event": "webinar-11-04" });
  });

  it("opens typed chat with the agent's fixed line, once, ahead of the first message", async () => {
    const { llm, create } = pageConnection("Ich bin Clara.");
    const { runtime, session } = await create();
    const sent: ServerMessage[] = [];
    const controller = new ConnectionController((message) => sent.push(message), { runtime, session });
    controller.start();

    await controller.handle({ type: "user_text", text: "Hallo" });
    await controller.handle({ type: "user_text", text: "Und noch etwas" });

    const last = sent.filter((message) => message.type === "messages").at(-1);
    if (last?.type !== "messages") throw new Error("missing messages frame");
    expect(last.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "(The conversation has just started.)"],
      ["assistant", "Ich bin Clara."],
      ["user", "Hallo"],
      ["assistant", "Gern."],
      ["user", "Und noch etwas"],
      ["assistant", "Gern."],
    ]);
    expect(llm).toHaveBeenCalledTimes(2);
  });
});
