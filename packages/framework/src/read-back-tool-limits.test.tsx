import { describe, expect, it } from "vitest";
import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { Agent, AgentSiteRuntime, SystemPrompt, Tool, z } from "./index.js";

function simpleRuntime(tools: React.ReactNode) {
  return new AgentSiteRuntime(
    <Agent>
      <SystemPrompt>You help callers.</SystemPrompt>
      {tools}
    </Agent>,
  );
}

describe("Tool limits during confirmation", () => {
  it("refuses confirmation before the prerequisite tool succeeds", async () => {
    const runtime = simpleRuntime(
      <>
        <Tool
          name="verify_caller"
          description="Verify identity."
          schema={z.object({ pin: z.string() })}
          onSubmit={() => ({ ok: true, message: "Verified." })}
        />
        <Tool
          name="issue_refund"
          description="Issue a refund."
          onlyAfter="verify_caller"
          schema={z.object({ amount: z.number() })}
          confirm={({ amount }) => `Refund $${amount}?`}
          onSubmit={({ amount }) => ({ ok: true, message: `Refunded $${amount}.` })}
        />
      </>,
    );

    const llm: AgentLlmClient = async (req) => {
      const hasRefusal = req.messages.some((m) => m.role === "tool" && !m.result.ok);
      if (hasRefusal) return { text: "First I need your PIN to verify you.", toolCalls: [] };
      return { text: "", toolCalls: [{ id: "c1", name: "issue_refund", input: { amount: 50 } }] };
    };
    const session = new AgentSession(runtime, llm);

    const reply = await session.runTurn("Refund me $50.");
    expect(session.pendingConfirmation).toBeNull();
    expect(reply).toBe("First I need your PIN to verify you.");
  });

  it("refuses confirmation once the conversation call limit is reached", async () => {
    const runtime = simpleRuntime(
      <Tool
        name="send_sms"
        description="Send SMS."
        maxCallsPerConversation={1}
        schema={z.object({ body: z.string() })}
        confirm={({ body }) => `Send "${body}"?`}
        onSubmit={() => ({ ok: true, message: "Sent." })}
      />,
    );
    const firstCall = await runtime.callTool("send_sms", { body: "first" });
    expect(firstCall.result.ok).toBe(true);

    const llm: AgentLlmClient = async (req) => {
      const hasRefusal = req.messages.some((m) => m.role === "tool" && !m.result.ok);
      if (hasRefusal) return { text: "I already sent an SMS on this call.", toolCalls: [] };
      return { text: "", toolCalls: [{ id: "c2", name: "send_sms", input: { body: "second" } }] };
    };
    const session = new AgentSession(runtime, llm);

    const reply = await session.runTurn("Send another SMS.");
    expect(session.pendingConfirmation).toBeNull();
    expect(reply).toBe("I already sent an SMS on this call.");
  });
});
