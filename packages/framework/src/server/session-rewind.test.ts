import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentLlmClient } from "../agent-session.js";
import type { AgentChatMessage, AgentRunResponse } from "../llm/types.js";
import { createInsuranceDemoRuntime } from "../test-fixtures/insurance-runtime.js";
import type { AgentSessionBundle } from "./connection.js";
import { rebuildSessionAt } from "./session-rewind.js";

/**
 * Rewind replays the kept turns' tool calls onto a fresh runtime and reports the ones it
 * could not replay. A call refused before it ran (unknown tool or invalid input) had no
 * effect; it is not a divergence, so it is neither replayed nor reported.
 */

function fakeBundle(tools: Array<{ name: string; id: string }>, failing: string[] = []) {
  const callTool = vi.fn(async (name: string) => {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`Tool "${name}" is not available.`);
    if (failing.includes(name)) return { result: { ok: false, message: `${name} failed.` }, contextDiff: [] };
    return { result: { ok: true }, contextDiff: [] };
  });
  const restoreTranscript = vi.fn();
  const bundle = {
    runtime: {
      updateInfo: vi.fn(),
      snapshot: () => ({ context: { tools } }),
      callTool,
    },
    session: { restoreTranscript },
  } as unknown as AgentSessionBundle;
  return { bundle, callTool, restoreTranscript };
}

function toolStep(
  id: string,
  name: string,
  ok: boolean,
  invalid?: string,
): [AgentChatMessage, AgentChatMessage] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, input: { id }, ...(invalid ? { invalid } : {}) }],
    },
    {
      role: "tool",
      content: "",
      toolCallId: id,
      toolName: name,
      result: ok ? { ok: true } : { ok: false, message: `Unknown tool "${name}".` },
      contextDiff: [],
    },
  ];
}

describe("rebuildSessionAt on a conversation stored before the agent level", () => {
  const idle: AgentLlmClient = async () => ({ text: "", toolCalls: [] });
  const readSkill = (id: string, skill: string): AgentChatMessage[] => [
    { role: "assistant", content: "", toolCalls: [{ id, name: "read_skill", input: { skill } }] },
    { role: "tool", content: "Skill read.", toolCallId: id, toolName: "read_skill", result: { ok: true }, contextDiff: [] },
  ];

  it("restores without the skills that are none now, and reports them, instead of failing", async () => {
    // Kept data: "/", where conversations started before the agent level, a skill deleted
    // since, and one that still exists.
    const messages: AgentChatMessage[] = [
      { role: "user", content: "I want to report a claim" },
      ...readSkill("r1", "/claim-procedure"),
      ...readSkill("r2", "/"),
      ...readSkill("r3", "/claims-archive"),
      { role: "assistant", content: "Let us start with the procedure." },
    ];

    const rebuilt = await rebuildSessionAt({
      create: async () => {
        const runtime = createInsuranceDemoRuntime();
        return { runtime, session: new AgentSession(runtime, idle) };
      },
      agentId: "agent",
      sourceMessages: messages,
      index: messages.length,
      liveInfo: {},
    });

    const { context } = rebuilt.bundle.runtime.snapshot();
    expect(context.loadedSkills.map((skill) => skill.path)).toEqual(["/claim-procedure"]);
    expect(rebuilt.skipped).toEqual(["read_skill", "read_skill"]);
    // Not replayed, so no refusal of read_skill is left in what the model reads.
    expect(context.errors).toEqual([]);
    expect(context.toolErrors).toEqual({});
    expect(rebuilt.bundle.session.messages).toHaveLength(messages.length);
  });
});

describe("rebuildSessionAt", () => {
  it("replays real calls and reports only the ones it could not replay", async () => {
    const { bundle, callTool, restoreTranscript } = fakeBundle([
      { name: "lookup_policy", id: "skill:policy/lookup_policy" },
      { name: "search_docs", id: "mcp:docs/search_docs" },
    ]);
    const messages: AgentChatMessage[] = [
      { role: "user", content: "hi" },
      ...toolStep("c1", "lookup_policy", true),
      // Refused before running: an invented tool, and a real tool with invalid input.
      ...toolStep("c2", "made_up_tool", false, "unknown tool"),
      ...toolStep("c2b", "lookup_policy", false, "invalid input: id is required"),
      // External: never re-executed, always reported.
      ...toolStep("c3", "search_docs", true),
      // Ran successfully back then, gone now: a real divergence.
      ...toolStep("c4", "removed_tool", true),
      { role: "user", content: "cut here" },
    ];

    const rebuilt = await rebuildSessionAt({
      create: async () => bundle,
      agentId: "agent",
      sourceMessages: messages,
      index: messages.length - 1,
      liveInfo: {},
    });

    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["lookup_policy", "removed_tool"]);
    expect(rebuilt.skipped).toEqual(["search_docs", "removed_tool"]);
    // Nothing in the kept prefix waits for the caller's yes.
    expect(restoreTranscript).toHaveBeenCalledWith(messages.slice(0, -1), null);
  });

  it("reports a replay that fails where the recorded call succeeded", async () => {
    const { bundle, callTool } = fakeBundle(
      [
        { name: "submit_claim", id: "skill:claims/submit_claim" },
        { name: "lookup_policy", id: "skill:policy/lookup_policy" },
      ],
      ["submit_claim", "lookup_policy"],
    );
    const messages: AgentChatMessage[] = [
      { role: "user", content: "hi" },
      // Succeeded back then, fails on replay: the rebuilt state lacks its effect.
      ...toolStep("c1", "submit_claim", true),
      // Failed back then too: replaying it the same way is no divergence.
      ...toolStep("c2", "lookup_policy", false),
      { role: "user", content: "cut here" },
    ];

    const rebuilt = await rebuildSessionAt({
      create: async () => bundle,
      agentId: "agent",
      sourceMessages: messages,
      index: messages.length - 1,
      liveInfo: {},
    });

    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["submit_claim", "lookup_policy"]);
    expect(rebuilt.skipped).toEqual(["submit_claim"]);
  });

  it("does not report a call to a tool the model does not have (a real session's transcript)", async () => {
    const script: AgentRunResponse[] = [
      { text: "", toolCalls: [{ id: "t1", name: "book_flight", input: {} }] },
      { text: "I cannot book flights.", toolCalls: [] },
    ];
    const llm: AgentLlmClient = async () => script.shift() ?? { text: "", toolCalls: [] };
    const live = new AgentSession(createInsuranceDemoRuntime(), llm);
    await live.runTurn("book me a flight");
    await live.runTurn("never mind");

    const toolStepMessage = live.messages.find((message) => message.role === "assistant" && message.toolCalls);
    expect(toolStepMessage?.role === "assistant" && toolStepMessage.toolCalls?.[0]?.invalid).toContain("Unknown tool");

    const rebuilt = await rebuildSessionAt({
      create: async () => {
        const runtime = createInsuranceDemoRuntime();
        return { runtime, session: new AgentSession(runtime, llm) };
      },
      agentId: "agent",
      sourceMessages: live.messages,
      index: live.messages.findLastIndex((message) => message.role === "user"),
      liveInfo: {},
    });

    expect(rebuilt.skipped).toEqual([]);
  });
});
