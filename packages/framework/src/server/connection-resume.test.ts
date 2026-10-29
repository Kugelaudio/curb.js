import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import type { AgentChatMessage } from "../llm/types.js";
import { createInsuranceDemoRuntime, insuranceAgent } from "../test-fixtures/insurance-runtime.js";
import { ConnectionController } from "./connection.js";
import type { ConversationState } from "./conversation-restore.js";
import type { PreviewAgent, ServerMessage } from "./protocol.js";

const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });
const FIXTURE_SKILLS: PreviewAgent["skills"] = insuranceAgent.routes.map((route) => ({ path: route.path, source: "" }));

/** A store with one recorded conversation (42), which knows the sessions it records. */
function recordedHistory(
  recording: { messages?: AgentChatMessage[]; state?: ConversationState | null } = {},
) {
  const recorded = new Map<AgentSession, number>();
  const restoredBeforeContinuing: number[] = [];
  const continueRecording = vi.fn((session: AgentSession, id: number) => {
    restoredBeforeContinuing.push(session.messages.length);
    recorded.set(session, id);
  });
  const messages = recording.messages ?? [
    { role: "user" as const, content: "Was macht ihr?" },
    { role: "assistant" as const, content: "Wir bauen Voice-Agents." },
  ];
  const history = {
    list: () => [{ id: 42, agentId: "insurance", startedAt: Date.now() - 60_000, messageCount: messages.length }],
    messages: () => messages,
    systemPrompt: () => null,
    state: () => (recording.state === undefined ? { loadedSkills: [], stores: {} } : recording.state),
    recordedId: (session: AgentSession) => recorded.get(session) ?? null,
    continueRecording,
  };
  return { history, recorded, continueRecording, restoredBeforeContinuing };
}

/** A connection whose agent host builds insurance bundles; `tools` collects every tool any of
 * them runs, and `skills` is what the agent defines as the preview describes it. */
function reconnectingController(
  history: ReturnType<typeof recordedHistory>["history"],
  options: { skills?: PreviewAgent["skills"]; tools?: string[] } = {},
) {
  const runtime = createInsuranceDemoRuntime();
  const sent: ServerMessage[] = [];
  const create = vi.fn(async () => {
    const fresh = createInsuranceDemoRuntime();
    const callTool = fresh.callTool.bind(fresh);
    fresh.callTool = async (name, input) => {
      options.tools?.push(name);
      return callTool(name, input);
    };
    return { runtime: fresh, session: new AgentSession(fresh, idleLlm) };
  });
  const preview = (id: string): PreviewAgent => ({ id, source: "", preview: {}, skills: options.skills ?? [] });
  const controller = new ConnectionController((message) => sent.push(message), {
    runtime,
    session: new AgentSession(runtime, idleLlm),
    agentHost: { ids: ["insurance"], initialId: "insurance", create, createRuntime: async () => runtime, preview },
    history,
  });
  const last = <T extends ServerMessage["type"]>(type: T) => {
    const frame = sent.filter((message) => message.type === type).at(-1);
    if (!frame) throw new Error(`no ${type} frame`);
    return frame as Extract<ServerMessage, { type: T }>;
  };
  return { controller, sent, last };
}

describe("a page reconnecting after curb dev reloaded the agent", () => {
  it("opens the conversation it was on, records into it, and drops the fresh one it never used", async () => {
    const { history, continueRecording, restoredBeforeContinuing } = recordedHistory();
    const { controller, last } = reconnectingController(history);

    await controller.resume(42);
    controller.start();

    expect(last("conversations").active).toBe("stored-42");
    expect(controller.recordedConversationId()).toBe(42);
    expect(last("conversations").conversations.map((conversation) => conversation.id)).toEqual(["stored-42"]);
    expect(last("messages").messages.map((message) => message.content)).toEqual([
      "Was macht ihr?",
      "Wir bauen Voice-Agents.",
    ]);
    // Told before the transcript was restored onto the session, so no message went to a copy.
    expect(continueRecording).toHaveBeenCalledWith(expect.any(AgentSession), 42);
    expect(restoredBeforeContinuing).toEqual([0]);
  });

  it("stays on its fresh conversation, and says why, when that conversation is not recorded", async () => {
    const { history, continueRecording } = recordedHistory();
    const { controller, sent, last } = reconnectingController(history);

    await controller.resume(7);
    controller.start();

    expect(last("conversations").active).toBe("conversation-1");
    expect(continueRecording).not.toHaveBeenCalled();
    expect(sent.find((message) => message.type === "error")).toMatchObject({
      message: "Conversation 7 is not among the recorded ones; this is a new conversation.",
    });
  });

  it("comes back with its skills and store data, runs none of its tools, and says calmly what it could not restore", async () => {
    const tools: string[] = [];
    const { history } = recordedHistory({
      messages: [
        { role: "user", content: "I want to report a claim" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "complete_claim_procedure_stage", input: {} }] },
        {
          role: "tool",
          content: "Procedure is complete.",
          toolCallId: "c1",
          toolName: "complete_claim_procedure_stage",
          result: { ok: true },
          contextDiff: [],
        },
        { role: "assistant", content: "Your claim is ready." },
      ],
      state: {
        loadedSkills: ["/claim-procedure", "/property-damage", "/gone"],
        stores: { insurance: { values: { procedureComplete: true } } },
        client: { event: "webinar-11-04" },
      },
    });
    const { controller, sent, last } = reconnectingController(history, { skills: FIXTURE_SKILLS, tools });

    // The page sent its info first thing; it arrived while the agent was built.
    await controller.resume(42, { "client.event": "webinar-11-04" });
    controller.start();

    expect(tools).toEqual([]);
    expect(last("context").context.path).toBe("/property-damage");
    expect(last("context").context.tools.map((tool) => tool.name)).toContain("submit_property_damage_claim");
    // The page's info was there before anything rendered: nothing to tell the model about.
    expect(last("messages").messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    await controller.handle({ type: "set_info", values: { "client.event": "webinar-11-04" } });
    expect(last("messages").messages).toHaveLength(4);
    // Said once the conversation is shown, and not as an error.
    const types = sent.map((message) => message.type);
    expect(types.indexOf("notice")).toBeGreaterThan(types.lastIndexOf("conversations"));
    expect(last("notice").message).toBe("Skill(s) /gone no longer exist and were not reloaded.");
    expect(sent.filter((message) => message.type === "error")).toEqual([]);
  });

  it("opens a conversation from the list the same way, and one recorded without its state from its transcript", async () => {
    const tools: string[] = [];
    const { history } = recordedHistory({
      messages: [
        { role: "user", content: "Policy question" },
        { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_skill", input: { skill: "/policy-questions" } }] },
        { role: "tool", content: "Skill read.", toolCallId: "r1", toolName: "read_skill", result: { ok: true }, contextDiff: [] },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "request_callback", input: { name: "Ada", phone: "1", topic: "x" } }] },
        { role: "tool", content: "ok", toolCallId: "t1", toolName: "request_callback", result: { ok: true }, contextDiff: [] },
        { role: "assistant", content: "An advisor will call you." },
      ],
      state: null,
    });
    const { controller, sent, last } = reconnectingController(history, { skills: FIXTURE_SKILLS, tools });
    controller.start();

    await controller.handle({ type: "select_conversation", id: "stored-42" });

    expect(tools).toEqual([]);
    expect(last("conversations").active).toBe("stored-42");
    expect(last("context").context.path).toBe("/policy-questions");
    expect(last("notice").message).toMatch(/^This conversation was recorded without its state/);
    expect(sent.filter((message) => message.type === "error")).toEqual([]);
  });

  it("restores a conversation stored before the agent level without the old home skill, and names only skills deleted since", async () => {
    // Kept data: conversations used to start in "/", the home skill, whose content is the
    // agent's own now; one skill the conversation read was deleted since.
    const tools: string[] = [];
    const readSkill = (id: string, skill: string): AgentChatMessage[] => [
      { role: "assistant", content: "", toolCalls: [{ id, name: "read_skill", input: { skill } }] },
      { role: "tool", content: "Skill read.", toolCallId: id, toolName: "read_skill", result: { ok: true }, contextDiff: [] },
    ];
    const { history } = recordedHistory({
      messages: [
        { role: "user", content: "I want to report a claim" },
        ...readSkill("r1", "/claim-procedure"),
        ...readSkill("r2", "/"),
        ...readSkill("r3", "/claims-archive"),
        { role: "assistant", content: "Let us start with the procedure." },
      ],
      state: null,
    });
    const { controller, sent, last } = reconnectingController(history, { skills: FIXTURE_SKILLS, tools });

    await controller.resume(42);
    controller.start();

    expect(tools).toEqual([]);
    const { context } = last("context");
    expect(context.loadedSkills.map((skill) => skill.path)).toEqual(["/claim-procedure"]);
    // No refusal of read_skill rides into what the model reads next.
    expect(context.errors).toEqual([]);
    expect(last("notice").message).toContain("/claims-archive");
    expect(last("notice").message).not.toMatch(/Skill\(s\) \/(,| no)/);
    expect(sent.filter((message) => message.type === "error")).toEqual([]);
  });

  it("restores saved state that had the old home skill loaded without it, and without a note", async () => {
    const tools: string[] = [];
    const { history } = recordedHistory({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi, how can I help?" },
      ],
      state: { loadedSkills: ["/", "/claim-procedure"], stores: {}, client: {} },
    });
    const { controller, sent, last } = reconnectingController(history, { skills: FIXTURE_SKILLS, tools });

    await controller.resume(42);
    controller.start();

    expect(last("context").context.loadedSkills.map((skill) => skill.path)).toEqual(["/claim-procedure"]);
    expect(sent.some((message) => message.type === "notice")).toBe(false);
    expect(sent.filter((message) => message.type === "error")).toEqual([]);
  });

  it("names the stored id of the conversation it is on, once recorded, for the page to come back to", () => {
    const { history, recorded } = recordedHistory();
    const runtime = createInsuranceDemoRuntime();
    const session = new AgentSession(runtime, idleLlm);
    const controller = new ConnectionController(() => {}, { runtime, session, history: { ...history, list: () => [] } });
    controller.start();
    expect(controller.recordedConversationId()).toBeNull();

    // The store wrote the conversation's first message.
    recorded.set(session, 43);
    expect(controller.recordedConversationId()).toBe(43);

    // Without a store there is nothing to come back to.
    const other = createInsuranceDemoRuntime();
    const bare = new ConnectionController(() => {}, { runtime: other, session: new AgentSession(other, idleLlm) });
    expect(bare.recordedConversationId()).toBeNull();
  });
});
