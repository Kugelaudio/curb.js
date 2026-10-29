import { describe, expect, it, vi } from "vitest";
import { snapshotAgentStores } from "../agent-state.js";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import type { AgentChatMessage } from "../llm/types.js";
import { createInsuranceDemoRuntime, insuranceAgent } from "../test-fixtures/insurance-runtime.js";
import {
  CUT_TOOL_CALL_MESSAGE,
  conversationState,
  restoreConversation,
  type ConversationState,
} from "./conversation-restore.js";

const idleLlm: AgentLlmClient = async () => ({ text: "", toolCalls: [] });
const SKILL_PATHS = insuranceAgent.routes.map((route) => route.path);

function freshBundle() {
  const runtime = createInsuranceDemoRuntime();
  const session = new AgentSession(runtime, idleLlm);
  return { runtime, session, callTool: vi.spyOn(runtime, "callTool") };
}

/** A finished claim procedure: the read_skill call, the stage the procedure completed with, the reply. */
const CLAIM_TRANSCRIPT: AgentChatMessage[] = [
  { role: "user", content: "I want to report a claim" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_skill", input: { skill: "/claim-procedure" } }] },
  { role: "tool", content: "Skill read.", toolCallId: "c1", toolName: "read_skill", result: { ok: true }, contextDiff: [] },
  { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "complete_claim_procedure_stage", input: {} }] },
  {
    role: "tool",
    content: "Procedure is complete.",
    toolCallId: "c2",
    toolName: "complete_claim_procedure_stage",
    result: { ok: true, message: "Procedure is complete." },
    contextDiff: [],
  },
  { role: "assistant", content: "Your claim is ready to submit." },
];

describe("restoreConversation", () => {
  it("puts back the store data, the open skills, the page info and the transcript, and runs no tool", () => {
    const { runtime, session, callTool } = freshBundle();
    const state: ConversationState = {
      loadedSkills: ["/claim-procedure", "/property-damage"],
      stores: { insurance: { values: { procedureComplete: true } } },
      client: { event: "webinar-11-04" },
      pendingConfirmation: null,
    };

    const notes = restoreConversation({ runtime, session }, { messages: CLAIM_TRANSCRIPT, state }, { skillPaths: SKILL_PATHS });

    expect(notes).toEqual([]);
    expect(callTool).not.toHaveBeenCalled();
    const { context } = runtime.snapshot();
    expect(context.path).toBe("/property-damage");
    expect(context.loadedSkills.map((skill) => skill.path)).toContain("/claim-procedure");
    // Unlocked by the restored store, not by running the procedure's tools again.
    expect(context.tools.map((tool) => tool.name)).toContain("submit_property_damage_claim");
    expect(runtime.info.snapshot()).toMatchObject({ "client.event": "webinar-11-04" });
    expect(session.messages).toEqual(CLAIM_TRANSCRIPT);

    // What the conversation keeps, read back, is what was restored.
    expect(conversationState(runtime, session)).toMatchObject({
      loadedSkills: expect.arrayContaining(["/claim-procedure", "/property-damage"]),
      stores: { insurance: { values: { procedureComplete: true } } },
      client: { event: "webinar-11-04" },
      pendingConfirmation: null,
    });
  });

  it("opens with the page's info over the saved one, as state the conversation had all along", () => {
    const { runtime, session } = freshBundle();
    const state: ConversationState = { loadedSkills: [], stores: {}, client: { event: "old", ref: "kept" } };

    restoreConversation(
      { runtime, session },
      { messages: CLAIM_TRANSCRIPT, state },
      { skillPaths: SKILL_PATHS, info: { "client.event": "new" } },
    );

    expect(runtime.info.snapshot()).toMatchObject({ "client.event": "new", "client.ref": "kept" });
    // No context event: the model is not told about a change that happened before it spoke.
    expect(session.messages).toEqual(CLAIM_TRANSCRIPT);
  });

  it("keeps the experiment variants a conversation ran with, and puts them back", () => {
    const { runtime, session } = freshBundle();
    runtime.updateInfo({ "experiment.greeting": "casual", "client.greeting": "formal" });
    const state = conversationState(runtime, session);
    expect(state).toMatchObject({ experiments: { greeting: "casual" }, client: { greeting: "formal" } });

    const restored = freshBundle();
    restoreConversation(restored, { messages: CLAIM_TRANSCRIPT, state }, { skillPaths: SKILL_PATHS });
    expect(restored.runtime.info.snapshot()).toMatchObject({ "experiment.greeting": "casual", "client.greeting": "formal" });

    // A conversation without variants saves none.
    expect(conversationState(freshBundle().runtime, session)).not.toHaveProperty("experiments");
  });

  it("says, one note each, what no longer exists or was never saved", () => {
    const { runtime, session } = freshBundle();
    const state: ConversationState = {
      loadedSkills: ["/claim-procedure", "/removed-skill"],
      stores: { insurance: { values: { procedureComplete: true } }, renamed: { values: { step: 2 } } },
      unsavedStoreFields: ["insurance.openedAt"],
    };

    const notes = restoreConversation({ runtime, session }, { messages: CLAIM_TRANSCRIPT, state }, { skillPaths: SKILL_PATHS });

    expect(notes).toEqual([
      "No createAgentStore defines renamed any more; that saved state was dropped.",
      "Store fields kept only within the run that set them (not JSON data): insurance.openedAt. They start from their initial values.",
      "Skill(s) /removed-skill no longer exist and were not reloaded.",
    ]);
    expect(runtime.snapshot().context.path).toBe("/claim-procedure");
  });

  it("restores a conversation recorded without its state from its transcript, and says its state starts over", () => {
    const { runtime, session, callTool } = freshBundle();
    const messages: AgentChatMessage[] = [
      ...CLAIM_TRANSCRIPT,
      // Refused: not a skill it opened.
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "read_skill", input: { skill: "/nowhere" } }] },
      {
        role: "tool",
        content: "read_skill failed",
        toolCallId: "c3",
        toolName: "read_skill",
        result: { ok: false, message: "Unknown skill." },
        contextDiff: [],
      },
      { role: "user", content: "Can you call me back?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c4",
            name: "request_callback",
            input: { name: "Ada", phone: "+4930123", topic: "claim" },
            invalid: "Held for the caller's yes.",
            heldFor: "Shall I ask an advisor to call Ada back about the claim?",
          },
        ],
      },
      {
        role: "tool",
        content: "Held.",
        toolCallId: "c4",
        toolName: "request_callback",
        result: { ok: false, message: "Held, not run." },
        contextDiff: [],
      },
      { role: "assistant", content: "Shall I ask an advisor to call Ada back about the claim?" },
    ];

    const notes = restoreConversation({ runtime, session }, { messages, state: null }, { skillPaths: SKILL_PATHS });

    expect(notes).toEqual([
      "This conversation was recorded without its state: its transcript and the skills it read are back, and its store data starts over.",
    ]);
    expect(callTool).not.toHaveBeenCalled();
    expect(runtime.snapshot().context.path).toBe("/claim-procedure");
    expect(snapshotAgentStores(runtime).stores.insurance?.values ?? { procedureComplete: false }).toEqual({
      procedureComplete: false,
    });
    // The read-back it ended on is still the open question.
    expect(session.pendingConfirmation).toMatchObject({ toolName: "request_callback", toolCallId: "c4" });
  });

  it("closes a tool step the conversation was cut off in, so the next request is valid", () => {
    const { runtime, session } = freshBundle();
    const messages: AgentChatMessage[] = [
      { role: "user", content: "Book both" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "request_callback", input: { name: "Ada", phone: "1", topic: "x" } },
          { id: "b", name: "request_callback", input: { name: "Bo", phone: "2", topic: "y" } },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "a", toolName: "request_callback", result: { ok: true }, contextDiff: [] },
    ];

    restoreConversation(
      { runtime, session },
      { messages, state: { loadedSkills: [], stores: {} } },
      { skillPaths: SKILL_PATHS },
    );

    expect(session.messages.slice(0, 3)).toEqual(messages);
    expect(session.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "b",
      result: { ok: false, message: CUT_TOOL_CALL_MESSAGE },
    });
    expect(session.messages).toHaveLength(4);
  });
});
