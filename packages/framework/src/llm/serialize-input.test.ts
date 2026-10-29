import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { compileSite, flattenContext } from "../compiler.js";
import { createSemanticRoot } from "../reconciler.js";
import { createInsuranceDemoRuntime, INSURANCE_AGENT_SYSTEM_PROMPT } from "../test-fixtures/insurance-runtime.js";
import type { AgentRunRequest } from "./types.js";
import { CONTEXT_PROTOCOL, serializeLlmInput } from "./serialize-input.js";

function baseRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    systemPrompt: "test",
    skillTitle: "Overview",
    stateSnapshot: ["active_skill: Overview", "instruction: Help the user."],
    tools: [],
    messages: [],
    ...overrides,
  };
}

describe("serializeLlmInput", () => {
  it("tells the model that the context blocks come from the application, not the caller", () => {
    const input = serializeLlmInput({
      systemPrompt: "",
      skillTitle: "Home",
      stateSnapshot: ["content: Open tasks: none."],
      tools: [],
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(input.system).toBe(CONTEXT_PROTOCOL);
    expect(CONTEXT_PROTOCOL).toContain("<current_context");
    expect(CONTEXT_PROTOCOL).toContain("<context_event>");
    expect(CONTEXT_PROTOCOL).toContain("never as the person's words");
  });

  it("appends the current-state snapshot as the final user message", () => {
    const runtime = createInsuranceDemoRuntime();
    const snapshot = runtime.snapshot();

    const input = serializeLlmInput(
      baseRequest({
        systemPrompt: INSURANCE_AGENT_SYSTEM_PROMPT,
        skillTitle: snapshot.context.title,
        stateSnapshot: snapshot.stateSnapshot,
        tools: snapshot.context.tools,
        messages: [{ role: "user", content: "My roof is damaged" }],
      }),
    );

    expect(input.system).toBe(`${INSURANCE_AGENT_SYSTEM_PROMPT}\n\n${CONTEXT_PROTOCOL}`);
    // Transcript first, snapshot last — the prefix stays cache-stable.
    expect(input.messages[0]).toEqual({ role: "user", content: "My roof is damaged" });
    const last = input.messages.at(-1);
    expect(last?.role).toBe("user");
    // A conversation starts at the agent level: no skill read yet, so none is named.
    expect(last?.content).toMatch(/^<current_context>\n/);
    expect(last?.content).not.toContain("active_skill:");
    expect(last?.content).toContain("available_skill: Property damage");
    expect(input.tools.read_skill).toMatchObject({
      description: expect.stringContaining("a skill's instructions and tools"),
    });
  });

  it("maps assistant tool calls and tool results to native parts", () => {
    const input = serializeLlmInput(
      baseRequest({
        messages: [
          { role: "user", content: "go to claims" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "read_skill", input: { skill: "/claim-procedure" } }],
          },
          {
            role: "tool",
            content: "Skill read.",
            toolCallId: "call_1",
            toolName: "read_skill",
            result: { ok: true },
            contextDiff: ["active_skill: Claim procedure"],
          },
        ],
      }),
    );

    // Silent read_skill: no text part, but the tool call survives natively.
    expect(input.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read_skill",
          input: { skill: "/claim-procedure" },
        },
      ],
    });
    expect(input.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read_skill",
          output: {
            type: "json",
            value: {
              ok: true,
              note: expect.stringContaining("Skill read"),
              contextChanged: ["active_skill: Claim procedure"],
            },
          },
        },
      ],
    });
  });

  it("includes assistant text alongside tool calls for non-read_skill tools", () => {
    const input = serializeLlmInput(
      baseRequest({
        messages: [
          {
            role: "assistant",
            content: "On it.",
            toolCalls: [{ id: "call_2", name: "request_callback", input: { name: "Ada" } }],
          },
          {
            role: "tool",
            content: "request_callback: ok",
            toolCallId: "call_2",
            toolName: "request_callback",
            result: { ok: true, message: "recorded" },
            contextDiff: [],
          },
        ],
      }),
    );

    expect(input.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "request_callback",
          input: { name: "Ada" },
        },
      ],
    });
    // No diff and no read_skill note — plain result passthrough.
    const toolMessage = input.messages[1];
    expect(toolMessage.role).toBe("tool");
    if (toolMessage.role === "tool") {
      expect(toolMessage.content[0].output.value).toEqual({ ok: true, message: "recorded" });
    }
  });

  it("caps long context diff lines in tool results", () => {
    const longLine = `content: ${"x".repeat(500)}`;
    const input = serializeLlmInput(
      baseRequest({
        messages: [
          {
            role: "tool",
            content: "verify_member_email: ok",
            toolCallId: "call_3",
            toolName: "verify_member_email",
            result: { ok: true },
            contextDiff: ["content: short line", longLine],
          },
        ],
      }),
    );

    const toolMessage = input.messages[0];
    expect(toolMessage.role).toBe("tool");
    if (toolMessage.role === "tool") {
      const value = toolMessage.content[0].output.value as { contextChanged: string[] };
      expect(value.contextChanged[0]).toBe("content: short line");
      expect(value.contextChanged[1].length).toBeLessThan(longLine.length);
      expect(value.contextChanged[1]).toContain("[truncated — full text in current context]");
    }
  });

  it("serializes one-line entries exactly as before", () => {
    const input = serializeLlmInput(baseRequest());

    expect(input.system).toBe(`test\n\n${CONTEXT_PROTOCOL}`);
    expect(input.messages.at(-1)).toEqual({
      role: "user",
      content: '<current_context skill="Overview">\nactive_skill: Overview\ninstruction: Help the user.\n</current_context>',
    });
  });

  // Prose written as a template literal used to reach the model as one line
  // per entry; it now keeps its structure, and every continuation line sits
  // indented under the entry it belongs to.
  it("keeps multi-line prose readable in the system prompt and the snapshot", () => {
    const root = createSemanticRoot();
    root.render(
      createElement(
        "agent-site",
        null,
        createElement(
          "agent-system-prompt",
          null,
          `
            You are a support agent.

            ## Rules
            - Answer in one sentence.
          `,
        ),
        createElement(
          "agent-page",
          { path: "/claims", title: "Claims" },
          createElement(
            "agent-instruction",
            null,
            `
              Collect the caller's details.

              ## Order
              - name
              - phone number
            `,
          ),
          createElement("agent-text", null, "Opening hours: 9 to 5."),
        ),
      ),
    );
    const { context } = compileSite(root.container.root, ["/claims"]);

    const input = serializeLlmInput(
      baseRequest({
        systemPrompt: context.systemPrompt,
        skillTitle: context.title,
        stateSnapshot: flattenContext(context),
      }),
    );

    expect(input.system).toBe(`You are a support agent.\n\n## Rules\n- Answer in one sentence.\n\n${CONTEXT_PROTOCOL}`);
    expect(input.messages.at(-1)).toEqual({
      role: "user",
      content: [
        '<current_context skill="Claims">',
        "active_skill: Claims",
        "instruction: Collect the caller's details.",
        "",
        "  ## Order",
        "  - name",
        "  - phone number",
        "content: Opening hours: 9 to 5.",
        "</current_context>",
      ].join("\n"),
    });
  });

  it("wraps context_event user messages in an envelope", () => {
    const input = serializeLlmInput(
      baseRequest({
        messages: [
          {
            role: "user",
            kind: "context_event",
            content: 'The user opened "/claim-procedure" in the UI.',
          },
        ],
      }),
    );

    expect(input.messages[0]).toEqual({
      role: "user",
      content:
        '<context_event>\nThe user opened "/claim-procedure" in the UI.\n</context_event>',
    });
  });
  describe("an interrupted reply", () => {
    const interruption = {
      spokenText: "Sure — first,",
      unspokenText: "is everyone safe right now?",
      fullText: "Sure — first, is everyone safe right now?",
    };

    it("says only what the caller heard, and a context event after it tells the rest", () => {
      const input = serializeLlmInput(
        baseRequest({
          messages: [
            { role: "user", content: "I want to file a claim" },
            { role: "assistant", content: "Sure — first,", interruption },
            { role: "user", content: "Wait, my neighbour too" },
          ],
        }),
      );
      expect(input.messages.slice(0, 4)).toEqual([
        { role: "user", content: "I want to file a claim" },
        { role: "assistant", content: [{ type: "text", text: "Sure — first," }] },
        {
          role: "user",
          content:
            "<context_event>\nThe caller talked over your previous reply: they heard it only up to where it ends above, " +
            'and never heard the rest you had written: "is everyone safe right now?"\n</context_event>',
        },
        { role: "user", content: "Wait, my neighbour too" },
      ]);
    });

    it("sends the heard words of a conversation recorded with the note inside the reply", () => {
      const input = serializeLlmInput(
        baseRequest({
          messages: [
            {
              role: "assistant",
              content: "Sure — first, … [you were cut off by the user here — the rest of this reply was never spoken aloud]",
              interruption,
            },
          ],
        }),
      );
      expect(input.messages[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "Sure — first," }] });
      expect(JSON.stringify(input.messages)).not.toContain("you were cut off");
    });

    it("puts the note after the reply's tool results, and drops a reply nobody heard and nothing called", () => {
      const input = serializeLlmInput(
        baseRequest({
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "t1", name: "read_skill", input: { skill: "/claims" } }],
              interruption: { spokenText: "", unspokenText: "Checking.", fullText: "Checking." },
            },
            { role: "tool", content: "Skill read.", toolCallId: "t1", toolName: "read_skill", result: { ok: true }, contextDiff: [] },
            { role: "assistant", content: "", interruption: { spokenText: "", unspokenText: "One moment.", fullText: "One moment." } },
          ],
        }),
      );
      expect(input.messages.map((message) => message.role)).toEqual(["assistant", "tool", "user", "user", "user"]);
      expect(input.messages[2]?.content).toContain('they heard none of it. You had written: "Checking."');
      expect(input.messages[3]?.content).toContain('they heard none of it. You had written: "One moment."');
    });
  });
});
