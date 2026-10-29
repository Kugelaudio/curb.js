import { describe, expect, it } from "vitest";
import type { AgentChatMessage, LlmCallRecord } from "../llm/types.js";
import {
  buildCodingAgentTranscript,
  chatMessagesToTranscript,
  exportedSystemPrompt,
} from "./transcript-export.js";

describe("chatMessagesToTranscript", () => {
  it("shows what the caller of an interrupted reply heard, and what they never heard", () => {
    const items = chatMessagesToTranscript([
      {
        role: "assistant",
        content: "Sure — first,",
        interruption: { spokenText: "Sure — first,", unspokenText: "is anyone hurt?", fullText: "Sure — first, is anyone hurt?" },
      },
      { role: "assistant", content: "", interruption: { spokenText: "", unspokenText: "One moment.", fullText: "One moment." } },
    ]);
    expect(items).toEqual([
      { role: "assistant", text: 'Sure — first, … [the caller talked over the agent here and never heard: "is anyone hurt?"]' },
      { role: "assistant", text: '[the caller talked over this reply before any of it played and never heard: "One moment."]' },
    ]);
  });

  it("pairs each tool call with its result (ok + context changes) and drops plumbing", () => {
    const messages: AgentChatMessage[] = [
      { role: "user", content: "file a claim" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_skill", input: { skill: "/claim-procedure" } }],
      },
      {
        role: "tool",
        content: "Skill read.",
        toolCallId: "c1",
        toolName: "read_skill",
        result: { ok: true },
        contextDiff: ["active_skill: Claim procedure"],
      },
      { role: "assistant", content: "Sure — let's start with safety." },
      // context_event user messages are synthetic plumbing → dropped.
      { role: "user", kind: "context_event", content: "loaded_skills changed" },
    ];

    expect(chatMessagesToTranscript(messages)).toEqual([
      { role: "user", text: "file a claim" },
      {
        role: "tool",
        name: "read_skill",
        input: { skill: "/claim-procedure" },
        ok: true,
        contextChanged: ["active_skill: Claim procedure"],
      },
      { role: "assistant", text: "Sure — let's start with safety." },
    ]);
  });

  it("marks a failed tool call", () => {
    const messages: AgentChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "submit_claim", input: { email: "bad" } }],
      },
      {
        role: "tool",
        content: "failed",
        toolCallId: "c1",
        toolName: "submit_claim",
        result: { ok: false, message: "Email invalid" },
        contextDiff: [],
      },
    ];
    const items = chatMessagesToTranscript(messages);
    expect(items[0]).toMatchObject({ role: "tool", name: "submit_claim", ok: false });
  });
});

describe("buildCodingAgentTranscript", () => {
  it("frames the transcript for a coding agent and renders turns + tools", () => {
    const out = buildCodingAgentTranscript("insurance", [
      { role: "user", text: "file a claim" },
      { role: "tool", name: "read_skill", input: { skill: "/claim-procedure" }, ok: true },
      { role: "assistant", text: "Let's start with safety." },
      { role: "tool", name: "submit_claim", input: { email: "x" }, ok: false },
    ]);

    // Preamble instructs the coding agent to improve src/agent/.
    expect(out).toContain("src/agent/");
    expect(out).toContain("read_skill");
    expect(out).toContain("Agent: `insurance`");
    expect(out).toContain("**User:** file a claim");
    expect(out).toContain("`read_skill`(skill: /claim-procedure)");
    expect(out).toContain("**Agent:** Let's start with safety.");
    expect(out).toContain("FAILED");
  });

  it("shows a call held for the caller's yes as held, not failed", () => {
    const items = chatMessagesToTranscript([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "book_meeting",
            input: { email: "max@example.com" },
            invalid: "Not run: held for the caller's yes.",
            heldFor: "Is max@example.com right?",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "book_meeting",
        content: "",
        result: { ok: false, message: "Held, not run." },
        contextDiff: [],
      },
    ]);
    const out = buildCodingAgentTranscript("booking", items);
    expect(out).toContain(`held, runs on the caller's yes to "Is max@example.com right?"`);
    expect(out).not.toContain("FAILED");
  });

  it("includes the agent surface (prompt, routable skills, available tools)", () => {
    const out = buildCodingAgentTranscript(
      "insurance",
      [{ role: "user", text: "hi" }],
      {
        systemPrompt: { text: "You are an insurance agent.", source: "conversation" },
        activeSkill: "Policy questions",
        skills: [
          { path: "/coverage", label: "Coverage", description: "Use for what a policy covers." },
        ],
        tools: [{ name: "request_callback", description: "Request a human callback." }],
      },
    );
    expect(out).toContain("## System prompt (sent in this conversation)\n\n```\nYou are an insurance agent.\n```");
    expect(out).toContain("## Skills the agent can route to");
    expect(out).toContain("`/coverage` — Coverage — Use for what a policy covers.");
    expect(out).toContain('## Tools available (in skill "Policy questions")');
    expect(out).toContain("`request_callback` — Request a human callback.");
  });

  // The export used to show the live prompt for every conversation, so an older one
  // was handed to a coding agent with a prompt it was never answered with.
  it("labels the prompt from the code when the conversation's own was not recorded", () => {
    const out = buildCodingAgentTranscript("agent", [{ role: "user", text: "hi" }], {
      systemPrompt: { text: "Today's prompt.", source: "current code" },
    });
    expect(out).toContain("## System prompt (current code)");
    expect(out).toContain("was not recorded, so this is the one in the code now.");
    expect(out).not.toContain("sent in this conversation");
  });

  it("keeps the prompt's own structure inside a fence it cannot close", () => {
    const text = "You are an agent.\n\n## Rules\n- Quote ids as ```code```.";
    const out = buildCodingAgentTranscript("agent", [], { systemPrompt: { text, source: "conversation" } });
    expect(out).toContain(`\`\`\`\`\n${text}\n\`\`\`\``);
  });

  it("notes when the active skill exposes no tools (a router)", () => {
    const out = buildCodingAgentTranscript("agent", [{ role: "user", text: "hi" }], {
      activeSkill: "Policy questions",
      tools: [],
    });
    expect(out).toContain("no tools in this context");
  });
});

describe("exportedSystemPrompt", () => {
  const call = (system: string): LlmCallRecord => ({
    index: 0,
    at: "2026-10-23T15:51:00.000Z",
    input: { system, messages: [], tools: {} },
  });

  it("takes the prompt this conversation's latest model call carried", () => {
    expect(exportedSystemPrompt([call("older"), call("as sent")], "in the code")).toEqual({
      text: "as sent",
      source: "conversation",
    });
  });

  it("falls to the code's prompt, labelled, when the conversation sent nothing here", () => {
    expect(exportedSystemPrompt([], "in the code")).toEqual({ text: "in the code", source: "current code" });
    expect(exportedSystemPrompt([], "in the code", null)).toEqual({ text: "in the code", source: "current code" });
    expect(exportedSystemPrompt([], undefined)).toBeUndefined();
  });

  it("takes the prompt the store recorded for a restored conversation, until a turn sends one", () => {
    expect(exportedSystemPrompt([], "in the code", "as recorded")).toEqual({ text: "as recorded", source: "conversation" });
    expect(exportedSystemPrompt([call("as sent again")], "in the code", "as recorded")).toEqual({
      text: "as sent again",
      source: "conversation",
    });
    const out = buildCodingAgentTranscript("agent", [{ role: "user", text: "hi" }], {
      systemPrompt: exportedSystemPrompt([], "in the code", "as recorded"),
    });
    expect(out).toContain("## System prompt (sent in this conversation)\n\n```\nas recorded\n```");
    expect(out).not.toContain("current code");
  });
});

describe("multi-line content in the transcript", () => {
  it("quotes a multi-line turn under its speaker, so its lists stay inside the turn", () => {
    const out = buildCodingAgentTranscript("agent", [
      { role: "user", text: "Two things:\n\n- my roof\n- my car" },
      { role: "assistant", text: "One at a time." },
    ]);
    expect(out).toContain("**User:**\n> Two things:\n>\n> - my roof\n> - my car\n\n**Agent:** One at a time.");
  });

  it("indents a multi-line context change under its tool call", () => {
    const out = buildCodingAgentTranscript("agent", [
      {
        role: "tool",
        name: "read_skill",
        ok: true,
        contextChanged: ["instruction: Ask what happened.\n\n  ## Order\n  - address", "tool: report_damage() [page]"],
      },
    ]);
    expect(out).toContain(
      [
        "- _tool_ `read_skill`",
        "  - ↳ instruction: Ask what happened.",
        "",
        "      ## Order",
        "      - address",
        "  - ↳ tool: report_damage() [page]",
      ].join("\n"),
    );
  });
});

describe("transcript timestamps", () => {
  it("renders clock times on user, agent, and tool lines when stamps exist", () => {
    // 2026-07-13 18:28:49 local — fixed instant so the format is exact.
    const at = new Date(2026, 6, 13, 18, 28, 49).getTime();
    const text = buildCodingAgentTranscript("agent", [
      { role: "user", text: "Uh, not sure.", at },
      { role: "tool", at: at + 1000, name: "skip_turn", ok: true },
      { role: "assistant", text: "Take your time.", at: at + 3000 },
    ]);
    expect(text).toContain("**User (18:28:49):** Uh, not sure.");
    expect(text).toContain("- _tool_ `skip_turn` (18:28:50)");
    expect(text).toContain("**Agent (18:28:52):** Take your time.");
  });

  it("omits the clock when a message carries no stamp", () => {
    const text = buildCodingAgentTranscript("agent", [{ role: "user", text: "hi" }]);
    expect(text).toContain("**User:** hi");
    expect(text).not.toMatch(/\*\*User \(/);
  });
});
