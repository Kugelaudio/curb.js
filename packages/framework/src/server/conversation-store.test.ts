import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import { serializeLlmInput } from "../llm/serialize-input.js";
import {
  createInsuranceDemoRuntime,
  INSURANCE_AGENT_SYSTEM_PROMPT,
} from "../test-fixtures/insurance-runtime.js";
import type { AgentChatMessage, AgentRunResponse } from "../llm/types.js";
import { conversationState } from "./conversation-restore.js";
import {
  attachConversationSink,
  CONVERSATION_SINK_MODULE_ENV,
  continueRecordedConversation,
  ConversationStore,
  describeConversationStore,
  detachConversationRecorder,
  getConversationSink,
  getConversationSinkStatus,
  keepConversationState,
  legacyHistoryNotice,
  loadConfiguredConversationSink,
  recordedConversationId,
  setConversationSink,
  type ConversationSink,
} from "./conversation-store.js";

function makeRecordedSession(
  responses: AgentRunResponse[],
  readMetadata?: () => Readonly<Record<string, unknown>>,
) {
  const runtime = createInsuranceDemoRuntime();
  let step = 0;
  const llm = vi.fn<AgentLlmClient>(async () => responses[step++] ?? { text: "", toolCalls: [] });
  const session = new AgentSession(runtime, llm);
  const store = new ConversationStore(":memory:");
  const recorder = attachConversationSink(store, session, "insurance", readMetadata);
  return { session, store, recorder };
}

describe("ConversationStore", () => {
  it("mirrors user, assistant, tool-call, and tool-result messages", async () => {
    const { session, store, recorder } = makeRecordedSession([
      {
        text: "",
        toolCalls: [{ name: "read_skill", input: { skill: "/property-damage" } }],
      },
      { text: "How can I help with the damage?", toolCalls: [] },
    ]);

    await session.runTurn("My roof is damaged");
    await recorder.flush();

    const conversations = store.listConversations(10);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ agent_id: "insurance", message_count: 4 });

    const messages = store.listMessages(conversations[0].id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    // The tool call the preview never showed is fully queryable now.
    expect(JSON.parse(messages[1].tool_calls ?? "[]")[0]).toMatchObject({
      name: "read_skill",
      input: { skill: "/property-damage" },
    });
    expect(messages[2].tool_name).toBe("read_skill");
    expect(JSON.parse(messages[2].tool_result ?? "{}")).toMatchObject({ ok: true });
    expect(messages[3].content).toBe("How can I help with the damage?");
  });

  it("starts a new conversation row after session.reset()", async () => {
    const { session, store, recorder } = makeRecordedSession([
      { text: "first conversation", toolCalls: [] },
      { text: "second conversation", toolCalls: [] },
    ]);

    await session.runTurn("hello");
    session.reset();
    await session.runTurn("hello again");
    await recorder.flush();

    const conversations = store.listConversations(10);
    expect(conversations).toHaveLength(2);
    const [newer, older] = conversations;
    expect(store.listMessages(older.id).map((message) => message.content)).toEqual([
      "hello",
      "first conversation",
    ]);
    expect(store.listMessages(newer.id).map((message) => message.content)).toEqual([
      "hello again",
      "second conversation",
    ]);
  });
});

describe("the default conversation store", () => {
  it("stays off in a managed runner because the platform owns hosted conversation records", async () => {
    vi.resetModules();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("CURB_MANAGEMENT_ADDR", "127.0.0.1:7071");
    vi.stubEnv("KUGEL_CONVERSATIONS_DB", ":memory:");

    try {
      const { getDefaultConversationStore } = await import("./conversation-store.js");
      expect(getDefaultConversationStore()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("the conversation sink seam", () => {
  afterEach(() => {
    setConversationSink(null);
    delete process.env[CONVERSATION_SINK_MODULE_ENV];
  });

  function fakeSink() {
    const started: Array<{ agentId: string; metadata: Readonly<Record<string, unknown>> }> = [];
    const written: Array<{ conversationId: string; seq: number; message: AgentChatMessage }> = [];
    const sink: ConversationSink = {
      startConversation: async (agentId, metadata) => {
        started.push({ agentId, metadata });
        return `conversation-${started.length}`;
      },
      recordMessage: async (conversationId, seq, message) => {
        written.push({ conversationId, seq, message });
      },
    };
    return { sink, started, written };
  }

  // THE TRAP THIS COVERS: a host pushes its session info (`set_info`) AFTER the session
  // exists, so metadata read at attach time is always empty and the row that should
  // carry the host's key carries nothing. It is read when the conversation starts, and
  // a conversation starts at the first message.
  it("reads host metadata when the conversation starts, not when it is attached", async () => {
    const { sink, started } = fakeSink();
    const runtime = createInsuranceDemoRuntime();
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "hi", toolCalls: [] }));
    const session = new AgentSession(runtime, llm);
    const info: Record<string, unknown> = {};

    const recorder = attachConversationSink(sink, session, "insurance", () => ({ ...info }));
    expect(started).toHaveLength(0);

    info["event.id"] = "de44596b-49e5-4edc-af37-c58aabea0229";
    await session.runTurn("hello");
    await recorder.flush();

    expect(started).toEqual([
      { agentId: "insurance", metadata: { "event.id": "de44596b-49e5-4edc-af37-c58aabea0229" } },
    ]);
  });

  it("writes each message once, in transcript order, with seq as its index", async () => {
    const { sink, written } = fakeSink();
    const runtime = createInsuranceDemoRuntime();
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "sure", toolCalls: [] }));
    const session = new AgentSession(runtime, llm);

    const recorder = attachConversationSink(sink, session, "insurance");
    await session.runTurn("hello");
    await recorder.flush();

    expect(written.map((write) => write.seq)).toEqual([0, 1]);
    expect(written.map((write) => write.conversationId)).toEqual(["conversation-1", "conversation-1"]);
    expect(written.map((write) => write.message.role)).toEqual(["user", "assistant"]);
  });

  // A refused call is marked `invalid` on its record AFTER its step was shown, and rewind
  // and reopening a stored conversation skip only marked calls: a store holding the first
  // version would replay the call. The same holds for a call held for the caller's yes.
  it("writes a message again when the session rewrites it after showing it", async () => {
    const { sink, written } = fakeSink();
    const runtime = createInsuranceDemoRuntime();
    let step = 0;
    const llm = vi.fn<AgentLlmClient>(async () =>
      step++ === 0
        ? { text: "", toolCalls: [{ id: "t1", name: "file_claim_now", input: {} }] }
        : { text: "I can't do that directly.", toolCalls: [] },
    );
    const session = new AgentSession(runtime, llm);

    const recorder = attachConversationSink(sink, session, "insurance");
    await session.runTurn("File it now.");
    session.annotateAudio("assistant", { room: "r1", role: "assistant", ordinals: [0] });
    await recorder.flush();

    const latest = (seq: number) => written.filter((write) => write.seq === seq).at(-1)?.message;
    const toolStep = latest(1);
    expect(toolStep?.role === "assistant" && toolStep.toolCalls?.[0]?.invalid).toBe(
      'Unknown tool "file_claim_now". Call only the tools you currently have.',
    );
    const reply = latest(3);
    expect(reply?.role === "assistant" && reply.audio?.ordinals).toEqual([0]);
  });

  it("falls back to the default store, which the test runner disables", () => {
    expect(getConversationSink()).toBeNull();
    const { sink } = fakeSink();
    setConversationSink(sink);
    expect(getConversationSink()).toBe(sink);
    setConversationSink(null);
    expect(getConversationSink()).toBeNull();
  });

  it("registers the sink the configuration names, by module path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "curb-sink-"));
    try {
      const modulePath = join(directory, "sink.mjs");
      writeFileSync(
        modulePath,
        "export default { startConversation: async () => '42', recordMessage: async () => {} };\n",
      );
      process.env[CONVERSATION_SINK_MODULE_ENV] = modulePath;

      await loadConfiguredConversationSink();

      expect(await getConversationSink()?.startConversation("insurance", {})).toBe("42");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // A misconfigured sink must fail at the configuration, not by silently recording
  // nowhere — "the transcripts stopped appearing" is a much longer way round.
  it("refuses a module that does not default-export a sink", async () => {
    const directory = mkdtempSync(join(tmpdir(), "curb-sink-"));
    try {
      const modulePath = join(directory, "not-a-sink.mjs");
      writeFileSync(modulePath, "export const sink = {};\n");
      process.env[CONVERSATION_SINK_MODULE_ENV] = modulePath;

      await expect(loadConfiguredConversationSink()).rejects.toThrow(
        /does not default-export a ConversationSink/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a module path that cannot be imported", async () => {
    process.env[CONVERSATION_SINK_MODULE_ENV] = join(tmpdir(), "curb-sink-missing", "nope.mjs");
    await expect(loadConfiguredConversationSink()).rejects.toThrow(/could not be imported/);
  });
});

// THE DEFECT THESE COVER: every rejected sink write used to be logged once and
// forgotten. A sink that was down for one write lost that message for good, a failed
// barge-in rewrite was marked written anyway, and a reset dropped whatever the previous
// conversation still owed, so the stored transcript looked complete and was not.
describe("a failing conversation sink", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errors.mockRestore();
  });

  function loggedErrors(): string {
    return errors.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
  }

  function flakySink() {
    const state = { startDown: false, writeDown: false };
    const started: string[] = [];
    const written: Array<{ conversationId: string; seq: number; message: AgentChatMessage }> = [];
    const sink: ConversationSink = {
      startConversation: async () => {
        if (state.startDown) throw new Error("sink unreachable");
        started.push(`conversation-${started.length + 1}`);
        return started[started.length - 1]!;
      },
      recordMessage: async (conversationId, seq, message) => {
        if (state.writeDown) throw new Error("sink unreachable");
        written.push({ conversationId, seq, message });
      },
    };
    return { sink, state, started, written };
  }

  function recordedSession(sink: ConversationSink, replies: string[]) {
    let step = 0;
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: replies[step++] ?? "", toolCalls: [] }));
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);
    const recorder = attachConversationSink(sink, session, "insurance");
    return { session, recorder };
  }

  const rows = (written: Array<{ conversationId: string; seq: number; message: AgentChatMessage }>) =>
    written.map((write) => [write.conversationId, write.seq, write.message.content]);

  it("keeps a failed write pending and retries it, in order, once the sink recovers", async () => {
    const { sink, state, written } = flakySink();
    const { session, recorder } = recordedSession(sink, ["sure"]);
    const before = getConversationSinkStatus();

    state.writeDown = true;
    // The call is the product: a sink that is down must not fail the turn.
    await session.runTurn("hello");
    await recorder.flush();
    expect(written).toEqual([]);
    expect(loggedErrors()).toMatch(/conversation sink write failed/);
    expect(getConversationSinkStatus().failedWrites).toBeGreaterThan(before.failedWrites);
    expect(getConversationSinkStatus().pendingMessages - before.pendingMessages).toBe(2);

    state.writeDown = false;
    await recorder.flush();
    expect(rows(written)).toEqual([
      ["conversation-1", 0, "hello"],
      ["conversation-1", 1, "sure"],
    ]);
    expect(getConversationSinkStatus().pendingMessages).toBe(before.pendingMessages);
  });

  it("retries a conversation whose start failed, and starts it exactly once", async () => {
    const { sink, state, started, written } = flakySink();
    const { session, recorder } = recordedSession(sink, ["sure"]);

    state.startDown = true;
    await session.runTurn("hello");
    await recorder.flush();
    expect(started).toEqual([]);

    state.startDown = false;
    await recorder.flush();
    expect(started).toEqual(["conversation-1"]);
    expect(rows(written)).toEqual([
      ["conversation-1", 0, "hello"],
      ["conversation-1", 1, "sure"],
    ]);
  });

  it("retries a barge-in rewrite whose write failed", async () => {
    const { sink, state, written } = flakySink();
    const { session, recorder } = recordedSession(sink, ["Sure, first, is everyone safe right now?"]);
    await session.runTurn("I want to file a claim");
    await recorder.flush();

    state.writeDown = true;
    session.reconcileInterruptedReply("Sure, first,");
    await recorder.flush();
    state.writeDown = false;
    await recorder.flush();

    const last = written.at(-1)!;
    expect(last.seq).toBe(1);
    expect(last.message.role === "assistant" && last.message.interruption?.spokenText).toBe("Sure, first,");
  });

  it("keeps a reset conversation's unwritten messages in that conversation", async () => {
    const { sink, state, written } = flakySink();
    const { session, recorder } = recordedSession(sink, ["first reply", "second reply"]);

    state.writeDown = true;
    await session.runTurn("hello");
    session.reset();
    await session.runTurn("hello again");
    await recorder.flush();

    state.writeDown = false;
    await recorder.flush();
    expect(rows(written)).toEqual([
      ["conversation-1", 0, "hello"],
      ["conversation-1", 1, "first reply"],
      ["conversation-2", 0, "hello again"],
      ["conversation-2", 1, "second reply"],
    ]);
  });

  it("retries once more at session end", async () => {
    const { sink, state, written } = flakySink();
    const { session } = recordedSession(sink, ["sure"]);

    state.writeDown = true;
    await session.runTurn("hello");
    state.writeDown = false;
    await detachConversationRecorder(session);

    expect(rows(written)).toEqual([
      ["conversation-1", 0, "hello"],
      ["conversation-1", 1, "sure"],
    ]);
  });

  it("reports what is still unwritten at session end, with the conversation id and count", async () => {
    const { sink, state, written } = flakySink();
    const { session, recorder } = recordedSession(sink, ["sure", "later"]);
    const before = getConversationSinkStatus();

    state.writeDown = true;
    await session.runTurn("hello");
    await recorder.detach();

    expect(loggedErrors()).toMatch(/lost 2 messages of conversation conversation-1/);
    expect(getConversationSinkStatus().lostMessages - before.lostMessages).toBe(2);
    expect(getConversationSinkStatus().pendingMessages).toBe(before.pendingMessages);

    // Detached means detached: nothing after the session end is written or retried.
    state.writeDown = false;
    await session.runTurn("still there?");
    await recorder.flush();
    expect(written).toEqual([]);
  });
});

describe("naming the active conversation store", () => {
  const saved = { ...process.env };
  afterEach(() => {
    setConversationSink(null);
    process.env = { ...saved };
  });

  it("names the sink module when one is configured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "curb-sink-"));
    try {
      const modulePath = join(directory, "sink.mjs");
      writeFileSync(
        modulePath,
        "export default { startConversation: async () => '1', recordMessage: async () => {} };\n",
      );
      process.env[CONVERSATION_SINK_MODULE_ENV] = modulePath;
      await loadConfiguredConversationSink();
      expect(describeConversationStore()).toBe(`sink ${modulePath} (${CONVERSATION_SINK_MODULE_ENV})`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names the JSONL file, or off", () => {
    delete process.env.VITEST;
    process.env.KUGEL_CONVERSATIONS_DB = join(tmpdir(), "curb-named.jsonl");
    expect(describeConversationStore()).toBe(`JSONL ${join(tmpdir(), "curb-named.jsonl")}`);
    process.env.KUGEL_CONVERSATIONS_DB = "off";
    expect(describeConversationStore()).toBe("off (KUGEL_CONVERSATIONS_DB=off)");
  });
});

describe("restoring a conversation", () => {
  // The transcript has to come back as the framework's OWN messages, not as rows.
  // Anything less and a restored conversation can be displayed but not continued,
  // which is the failure this exists to prevent.
  it("round-trips every role, including a tool call and its result", async () => {
    const store = new ConversationStore(":memory:");
    const id = Number(await store.startConversation("agent", {}));

    const original: AgentChatMessage[] = [
      { role: "user", content: "Was macht ihr?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "bewerbung_vormerken", input: { name: "Max" } }],
      },
      {
        role: "tool",
        content: "vorgemerkt",
        toolCallId: "call-1",
        toolName: "bewerbung_vormerken",
        result: { ok: true, message: "vorgemerkt" },
        contextDiff: ["+ bewerbung"],
      },
      { role: "assistant", content: "Erledigt." },
    ];
    original.forEach((message, seq) => store.insertMessage(id, seq, message));

    expect(store.restoreMessages(id)).toEqual(original);
    store.close();
  });

  it("round-trips a barge-in's spoken/unspoken split", async () => {
    const store = new ConversationStore(":memory:");
    const id = Number(await store.startConversation("insurance", {}));
    // A restored conversation used to render this as a complete reply: the
    // preview greys out `unspokenText`, and with the column gone there was
    // nothing to grey, so the record of what the caller never heard died at the
    // first refresh.
    const interrupted: AgentChatMessage = {
      role: "assistant",
      content: "Hey, I'm Juno, here",
      interruption: {
        spokenText: "Hey, I'm Juno, here",
        unspokenText: "to help. Is everyone safe right now?",
        fullText: "Hey, I'm Juno, here to help. Is everyone safe right now?",
      },
    };
    store.insertMessage(id, 0, interrupted);

    expect(store.restoreMessages(id)).toEqual([interrupted]);
    store.close();
  });

  // THE BUG THIS COVERS: the record loop only appends, and the write used to be
  // INSERT OR IGNORE. Reconciliation rewrites a message that is already on disk, so
  // every interrupted reply persisted as though it had been spoken in full.
  it("persists a barge-in that rewrites a reply already recorded", async () => {
    const { session, store, recorder } = makeRecordedSession([
      { text: "Sure — first, is everyone safe right now?", toolCalls: [] },
    ]);
    await session.runTurn("I want to file a claim");

    session.reconcileInterruptedReply("Sure — first,");
    await recorder.flush();

    const [conversation] = store.listConversations(1);
    const restored = store.restoreMessages(conversation!.id);
    const assistant = restored.find((message) => message.role === "assistant");
    expect(assistant?.role === "assistant" && assistant.interruption).toEqual({
      spokenText: "Sure — first,",
      unspokenText: "is everyone safe right now?",
      fullText: "Sure — first, is everyone safe right now?",
    });
    expect(assistant?.content).toBe("Sure — first,");
    // REPLACED, not duplicated: (conversation_id, seq) is the identity of a message.
    expect(store.listMessages(conversation!.id).filter((row) => row.role === "assistant")).toHaveLength(1);
    store.close();
  });

  it("replaces the message already written at a (conversation, seq)", async () => {
    const store = new ConversationStore(":memory:");
    const id = await store.startConversation("agent", {});
    await store.recordMessage(id, 0, { role: "assistant", content: "first draft" });
    await store.recordMessage(id, 0, { role: "assistant", content: "rewritten" });

    const messages = store.listMessages(Number(id));
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("rewritten");
    store.close();
  });

  // The pairing id is what the provider matches tool_use to tool_result on. A
  // restored transcript that dropped it would be refused on the NEXT turn, a long
  // way from the restore that caused it.
  it("gives a tool message stored without its id a stable one rather than refusing it", () => {
    withJournal((path) => {
      const conversation = '{"t":"conversation","id":1,"agentId":"agent","startedAt":"2026-10-28T10:00:00.000Z"}';
      const tool = (seq: number, content: string) =>
        JSON.stringify({ t: "message", conversation: 1, seq, writtenAt: "2026-10-28T10:00:01.000Z", message: { role: "tool", content } });
      writeFileSync(path, [conversation, tool(0, "done"), tool(1, "also done")].join("\n") + "\n");

      const store = new ConversationStore(path);
      const restored = store.restoreMessages(1);
      const ids = restored.map((message) => (message.role === "tool" ? message.toolCallId : null));
      for (const toolCallId of ids) expect(toolCallId).toBeTruthy();
      // UNIQUE, not merely present. A shared id pairs one tool_result with the wrong
      // tool_use, and the provider rejects the turn rather than the restore.
      expect(new Set(ids).size).toBe(ids.length);
      expect(restored[0]).toEqual({
        role: "tool",
        content: "done",
        toolCallId: "restored-1-0",
        toolName: "",
        result: { ok: true },
        contextDiff: [],
      });
      store.close();
    });
  });
});

// THE BUG THESE COVER: the store kept no `kind`, so every user row came back as
// speech. A restored conversation then sent its context events to the model as things
// the caller had said, and the export listed them as user turns. Times and the system
// prompt were lost the same way, so an export of an older conversation showed no
// clock and today's prompt.
describe("what a restored conversation keeps", () => {
  const at = Date.UTC(2026, 9, 23, 15, 51, 0);
  const prompt = "Du bist ein Support-Agent.\n\n## Regeln\n- Antworte kurz.";

  it("round-trips each message's kind and time, and the conversation's system prompt", async () => {
    const store = new ConversationStore(":memory:");
    const id = await store.startConversation("agent", {});
    const original: AgentChatMessage[] = [
      { role: "user", kind: "context_event", content: "The caller opened /schaden in the UI.", at },
      { role: "user", content: "Mein Dach ist kaputt.", at: at + 1_000 },
      {
        role: "assistant",
        content: "",
        at: at + 2_000,
        toolCalls: [{ id: "call-1", name: "read_skill", input: { skill: "/schaden" } }],
      },
      {
        role: "tool",
        content: "Skill read.",
        at: at + 2_100,
        toolCallId: "call-1",
        toolName: "read_skill",
        result: { ok: true },
        contextDiff: ["instruction: Frag nach dem Schaden.\n\n  ## Ablauf\n  - Adresse"],
      },
      { role: "user", kind: "synthetic", content: "(The caller has been silent.)", at: at + 9_000 },
      { role: "assistant", content: "Sind Sie noch da?", at: at + 9_500 },
    ];
    for (const [seq, message] of original.entries()) await store.recordMessage(id, seq, message);
    await store.recordSystemPrompt(id, prompt);

    expect(store.restoreMessages(Number(id))).toEqual(original);
    expect(store.restoreSystemPrompt(Number(id))).toBe(prompt);
    store.close();
  });

  it("sends a restored context event to the model as a context event, not as speech", async () => {
    const store = new ConversationStore(":memory:");
    const id = await store.startConversation("agent", {});
    await store.recordMessage(id, 0, {
      role: "user",
      kind: "context_event",
      content: "The caller opened /schaden in the UI.",
      at,
    });

    const input = serializeLlmInput({
      systemPrompt: prompt,
      skillTitle: "Schaden",
      stateSnapshot: ["active_skill: Schaden"],
      tools: [],
      messages: store.restoreMessages(Number(id)),
    });
    expect(input.messages[0]).toEqual({
      role: "user",
      content: "<context_event>\nThe caller opened /schaden in the UI.\n</context_event>",
    });
    store.close();
  });

  it("replaces the stored prompt, and refuses a conversation it never started", async () => {
    const store = new ConversationStore(":memory:");
    const id = await store.startConversation("agent", {});
    expect(store.restoreSystemPrompt(Number(id))).toBeNull();

    await store.recordSystemPrompt(id, "first");
    await store.recordSystemPrompt(id, "second");
    expect(store.restoreSystemPrompt(Number(id))).toBe("second");

    await expect(store.recordSystemPrompt("999", "orphan")).rejects.toThrow(/no conversation 999/);
    store.close();
  });

  it("records what the conversation's model calls carried as its system prompt", async () => {
    const { session, store, recorder } = makeRecordedSession([{ text: "Hello!", toolCalls: [] }]);
    session.recordContextEvent(["The caller opened /property-damage in the UI."]);
    await session.runTurn("hello");
    await recorder.flush();

    const [conversation] = store.listConversations(1);
    const sent = session.llmTrace.at(-1)!.input.system;
    expect(store.restoreSystemPrompt(conversation!.id)).toBe(sent);
    expect(sent).toContain(INSURANCE_AGENT_SYSTEM_PROMPT);

    const restored = store.restoreMessages(conversation!.id);
    expect(restored.map((message) => (message.role === "user" ? message.kind ?? "speech" : message.role))).toEqual([
      "context_event",
      "speech",
      "assistant",
    ]);
    expect(restored.every((message) => typeof message.at === "number")).toBe(true);
    store.close();
  });

  it("hands a sink the prompt once per change, after the conversation started", async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    const sink: ConversationSink = {
      startConversation: async () => {
        calls.push("start");
        return "c1";
      },
      recordMessage: async (_id, seq) => {
        calls.push(`message ${seq}`);
      },
      recordSystemPrompt: async (conversationId, systemPrompt) => {
        calls.push(`prompt ${conversationId}`);
        prompts.push(systemPrompt);
      },
    };
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "sure", toolCalls: [] }));
    const session = new AgentSession(createInsuranceDemoRuntime(), llm);
    const recorder = attachConversationSink(sink, session, "insurance");

    await session.runTurn("hello");
    await session.runTurn("and again");
    await recorder.flush();

    const sent = session.llmTrace.map((call) => call.input.system);
    expect(sent).toHaveLength(2);
    expect(prompts.at(-1)).toBe(sent.at(-1));
    // Never the same prompt twice in a row, and no more writes than distinct prompts:
    // two turns with an unchanged prompt hand it over once.
    expect(prompts.every((prompt, index) => index === 0 || prompt !== prompts[index - 1])).toBe(true);
    expect(prompts.length).toBeLessThanOrEqual(new Set(sent).size);
    expect(calls.indexOf("prompt c1")).toBeGreaterThan(calls.indexOf("start"));
  });

  it("replays the file when it is opened again: every message, its kind and time, the prompt and the state", async () => {
    await withJournalAsync(async (path) => {
      const store = new ConversationStore(path);
      const id = await store.startConversation("agent", {});
      const original: AgentChatMessage[] = [
        { role: "user", content: "Hallo" },
        { role: "assistant", content: "", at, toolCalls: [{ id: "call-1", name: "read_skill", input: { skill: "/schaden" } }] },
        {
          role: "tool",
          content: "Skill read.",
          at: at + 100,
          toolCallId: "call-1",
          toolName: "read_skill",
          result: { ok: true },
          contextDiff: ["+ schaden"],
        },
        { role: "user", kind: "context_event", content: "opened /schaden", at: at + 200 },
      ];
      for (const [seq, message] of original.entries()) await store.recordMessage(id, seq, message);
      await store.recordSystemPrompt(id, "first");
      await store.recordSystemPrompt(id, prompt);
      await store.recordState(id, { loadedSkills: ["/schaden"], stores: {} });
      store.close();

      const reopened = new ConversationStore(path);
      // Nothing was recorded about the first message's kind or time; what was recorded comes back.
      expect(reopened.restoreMessages(Number(id))).toEqual(original);
      expect(reopened.restoreSystemPrompt(Number(id))).toBe(prompt);
      expect(reopened.restoreState(Number(id))).toEqual({ loadedSkills: ["/schaden"], stores: {} });
      // Ids go on from the highest one in the file.
      expect(await reopened.startConversation("agent", {})).toBe(String(Number(id) + 1));
      reopened.close();
    });
  });
});

describe("continuing a stored conversation", () => {
  it("records a session that continues a stored conversation into it, not into a copy", async () => {
    const { session, store, recorder } = makeRecordedSession([{ text: "First answer.", toolCalls: [] }]);
    expect(recordedConversationId(session)).toBeNull();
    await session.runTurn("hello");
    await recorder.flush();
    const [stored] = store.listConversations(10);
    expect(recordedConversationId(session)).toBe(String(stored.id));

    // What `curb dev` does after reloading the agent: a fresh session restores the stored
    // transcript and the conversation goes on.
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Second answer.", toolCalls: [] }));
    const next = new AgentSession(createInsuranceDemoRuntime(), llm);
    const nextRecorder = attachConversationSink(store, next, "insurance");
    continueRecordedConversation(next, String(stored.id));
    next.restoreTranscript(store.restoreMessages(stored.id));
    await next.runTurn("and again");
    await nextRecorder.flush();

    expect(store.listConversations(10)).toHaveLength(1);
    expect(store.listMessages(stored.id).map((message) => message.content)).toEqual([
      "hello",
      "First answer.",
      "and again",
      "Second answer.",
    ]);
    expect(recordedConversationId(next)).toBe(String(stored.id));
    store.close();
  });

  it("refuses to continue one once the session has recorded something of its own", async () => {
    const { session, store, recorder } = makeRecordedSession([{ text: "Hi.", toolCalls: [] }]);
    await session.runTurn("hello");
    await recorder.flush();
    expect(() => continueRecordedConversation(session, "99")).toThrow(/only before it has recorded anything/);
    store.close();
  });
});

describe("keeping a conversation's state with its transcript", () => {
  it("records the state after every change, and only when it changed", async () => {
    const runtime = createInsuranceDemoRuntime();
    const llm = vi.fn<AgentLlmClient>(async () => ({ text: "Sure.", toolCalls: [] }));
    const session = new AgentSession(runtime, llm);
    const store = new ConversationStore(":memory:");
    const recordState = vi.spyOn(store, "recordState");
    const recorder = attachConversationSink(store, session, "insurance");
    keepConversationState(session, () => conversationState(runtime, session));

    await session.runTurn("hello");
    await recorder.flush();
    const [conversation] = store.listConversations(1);
    expect(store.restoreState(conversation!.id)).toEqual(conversationState(runtime, session));
    const writes = recordState.mock.calls.length;

    // A turn that changed nothing but the transcript hands over no state.
    await session.runTurn("again");
    await recorder.flush();
    expect(recordState).toHaveBeenCalledTimes(writes);

    // A skill the page opened is state: recorded with the context event it caused (`read_skill`).
    runtime.loadSkill("/property-damage");
    session.recordContextEvent(["The user opened /property-damage in the UI."]);
    await recorder.flush();
    expect(store.restoreState(conversation!.id)?.loadedSkills.at(-1)).toBe("/property-damage");
    store.close();
  });

  it("takes the state once more when the recording ends, for a change the transcript never saw", async () => {
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, vi.fn<AgentLlmClient>(async () => ({ text: "Hi.", toolCalls: [] })));
    const store = new ConversationStore(":memory:");
    attachConversationSink(store, session, "insurance");
    keepConversationState(session, () => conversationState(runtime, session));
    await session.runTurn("hello");

    // Page info nothing in the context reads: no context event, no transcript change.
    runtime.updateInfo({ "client.event": "webinar-11-04" });
    await detachConversationRecorder(session);

    const [conversation] = store.listConversations(1);
    expect(store.restoreState(conversation!.id)?.client).toEqual({ event: "webinar-11-04" });
    store.close();
  });

  it("records into a sink without recordState exactly as before: the transcript only", async () => {
    const recorded: number[] = [];
    const sink: ConversationSink = {
      startConversation: async () => "c1",
      recordMessage: async (_id, seq) => {
        recorded.push(seq);
      },
    };
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, vi.fn<AgentLlmClient>(async () => ({ text: "Hi.", toolCalls: [] })));
    const read = vi.fn(() => conversationState(runtime, session));
    const recorder = attachConversationSink(sink, session, "insurance");
    keepConversationState(session, read);
    await session.runTurn("hello");
    await recorder.flush();

    expect(recorded).toEqual([0, 1]);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads back a stored state this version cannot read as none, so the conversation still opens", () => {
    withJournal((path) => {
      writeFileSync(
        path,
        [
          '{"t":"conversation","id":1,"agentId":"agent","startedAt":"2026-10-28T10:00:00.000Z"}',
          '{"t":"conversation","id":2,"agentId":"agent","startedAt":"2026-10-28T10:00:00.000Z"}',
          '{"t":"state","conversation":1,"state":"{not json"}',
          '{"t":"state","conversation":2,"state":{"stores":{}}}',
        ].join("\n") + "\n",
      );
      const store = new ConversationStore(path);
      expect(store.restoreState(1)).toBeNull();
      expect(store.restoreState(2)).toBeNull();
      store.close();
    });
  });
});

// The store is one append-only JSON-lines file, replayed into memory when it opens. These
// cover what the file itself has to get right: the last record for a seq wins, a crash
// mid-write costs at most that one line, and anything else that is not a record is loud.
describe("the conversation file", () => {
  let warnings: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnings.mockRestore();
  });
  const warned = () => warnings.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

  async function recordTwo(path: string): Promise<void> {
    const store = new ConversationStore(path);
    const id = await store.startConversation("agent", {});
    await store.recordMessage(id, 0, { role: "user", content: "Hallo" });
    await store.recordMessage(id, 1, { role: "assistant", content: "Hallo!" });
    store.close();
  }

  it("keeps the last message written at a seq, across a reopen, with the time it was first written", async () => {
    await withJournalAsync(async (path) => {
      const store = new ConversationStore(path);
      const id = await store.startConversation("agent", {});
      await store.recordMessage(id, 0, { role: "assistant", content: "first draft" });
      const firstWritten = store.listMessages(Number(id))[0]!.created_at;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.recordMessage(id, 0, { role: "assistant", content: "rewritten" });
      store.close();

      // Both versions are in the file; the replay keeps the later one.
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
      const reopened = new ConversationStore(path);
      const messages = reopened.listMessages(Number(id));
      expect(messages.map((message) => message.content)).toEqual(["rewritten"]);
      expect(messages[0]!.created_at).toBe(firstWritten);
      expect(reopened.listConversations(10)[0]?.message_count).toBe(1);
      reopened.close();
    });
  });

  it("lists conversations newest first, leaves out those without a message, and honours the limit", async () => {
    const store = new ConversationStore(":memory:");
    const first = await store.startConversation("a", {});
    const empty = await store.startConversation("b", {});
    const third = await store.startConversation("c", {});
    await store.recordMessage(first, 0, { role: "user", content: "one" });
    await store.recordMessage(third, 0, { role: "user", content: "three" });
    await store.recordMessage(third, 1, { role: "assistant", content: "three!" });

    expect([first, empty, third]).toEqual(["1", "2", "3"]);
    const listed = store.listConversations(10);
    expect(listed.map((row) => [row.id, row.agent_id, row.message_count])).toEqual([
      [3, "c", 2],
      [1, "a", 1],
    ]);
    expect(listed.every((row) => !Number.isNaN(Date.parse(row.started_at)))).toBe(true);
    expect(store.listConversations(1).map((row) => row.id)).toEqual([3]);
    store.close();
  });

  it("refuses a message for a conversation it never started, and writes nothing for it", async () => {
    await withJournalAsync(async (path) => {
      const store = new ConversationStore(path);
      await expect(store.recordMessage("7", 0, { role: "user", content: "orphan" })).rejects.toThrow(/no conversation 7/);
      await expect(store.recordState("7", { loadedSkills: [], stores: {} })).rejects.toThrow(/no conversation 7/);
      expect(existsSync(path)).toBe(false);
      store.close();
    });
  });

  it("skips a final line a crash cut off, says so with its line number, and records on after it", async () => {
    await withJournalAsync(async (path) => {
      await recordTwo(path);
      appendFileSync(path, '{"t":"message","conversation":1,"seq":2,"writtenAt":"2026-10-28T1');

      const store = new ConversationStore(path);
      expect(warned()).toMatch(/conversations\.jsonl:4: dropped the last line/);
      expect(store.listMessages(1).map((message) => message.content)).toEqual(["Hallo", "Hallo!"]);

      // The broken tail is gone, so the next record starts a line of its own.
      await store.recordMessage("1", 2, { role: "user", content: "Noch da?" });
      store.close();
      const reopened = new ConversationStore(path);
      expect(reopened.listMessages(1).map((message) => message.content)).toEqual(["Hallo", "Hallo!", "Noch da?"]);
      reopened.close();
      expect(warnings).toHaveBeenCalledTimes(1);
    });
  });

  it("takes in a final record that only lacks its newline, and ends it before the next one", async () => {
    await withJournalAsync(async (path) => {
      await recordTwo(path);
      writeFileSync(path, readFileSync(path, "utf8").trimEnd());

      const store = new ConversationStore(path);
      expect(store.listMessages(1)).toHaveLength(2);
      await store.recordMessage("1", 2, { role: "user", content: "Noch da?" });
      store.close();
      expect(new ConversationStore(path).listMessages(1)).toHaveLength(3);
      expect(warnings).not.toHaveBeenCalled();
    });
  });

  it("throws naming the file and line for a line in the middle that is not a record", async () => {
    await withJournalAsync(async (path) => {
      await recordTwo(path);
      const lines = readFileSync(path, "utf8").split("\n");
      lines.splice(1, 0, '{"t":"message","conversation":1,"seq":');
      writeFileSync(path, lines.join("\n"));

      expect(() => new ConversationStore(path)).toThrow(/conversations\.jsonl:2 is not a conversation record: not JSON/);
      // Refused, not repaired: the file is exactly as it was.
      expect(readFileSync(path, "utf8")).toBe(lines.join("\n"));
    });
  });

  it("throws for a record in the middle that names a conversation no earlier line starts", () => {
    withJournal((path) => {
      writeFileSync(
        path,
        [
          '{"t":"message","conversation":4,"seq":0,"writtenAt":"x","message":{"role":"user","content":"hi"}}',
          '{"t":"conversation","id":1,"agentId":"agent","startedAt":"2026-10-28T10:00:00.000Z"}',
        ].join("\n") + "\n",
      );
      expect(() => new ConversationStore(path)).toThrow(/:1 is not a conversation record: it names conversation 4/);
    });
  });

  it("sees what another process appended to the same file", async () => {
    await withJournalAsync(async (path) => {
      const dev = new ConversationStore(path);
      const say = new ConversationStore(path);
      const first = await dev.startConversation("agent", {});
      const second = await say.startConversation("agent", {});
      expect(second).not.toBe(first);
      await say.recordMessage(second, 0, { role: "user", content: "from curb say" });
      expect(dev.listConversations(10).map((row) => row.id)).toEqual([Number(second)]);
      dev.close();
      say.close();
    });
  });

  it("refuses an SQLite file of an older curb instead of reading or cutting it", () => {
    withJournal((path) => {
      const sqlite = Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.from([0, 1, 10, 2, 3])]);
      writeFileSync(path, sqlite);
      expect(() => new ConversationStore(path)).toThrow(/\[AGENT_CONVERSATION_STORE_SQLITE\].*is an SQLite database from an older curb/);
      expect(readFileSync(path)).toEqual(sqlite);
    });
  });

  it("names an older history file beside the store, which it does not read", () => {
    withJournal((path) => {
      expect(legacyHistoryNotice(path)).toBeNull();
      writeFileSync(join(dirname(path), "conversations.db"), "");
      expect(legacyHistoryNotice(path)).toMatch(/conversations\.db is the SQLite conversation history of an older curb and is no longer read/);
      expect(legacyHistoryNotice(":memory:")).toBeNull();
    });
  });
});

/** A fresh `conversations.jsonl` path in a temp directory, removed afterwards. */
function withJournal(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "curb-store-"));
  try {
    run(join(directory, "conversations.jsonl"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withJournalAsync(run: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "curb-store-"));
  try {
    await run(join(directory, "conversations.jsonl"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
