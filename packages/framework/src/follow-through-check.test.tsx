import { describe, expect, it } from "vitest";
import { AgentSession, type AgentLlmClient } from "./agent-session.js";
import { zodSchemaToFields } from "./form-schema.js";
import { Agent, AgentSiteRuntime, SystemPrompt, Tool, z } from "./index.js";
import { inventedNumber } from "./llm/follow-through.js";
import { END_CALL_TOOL_NAME } from "./types.js";

type Reply = Awaited<ReturnType<AgentLlmClient>>;

function runtimeWith(tools: React.ReactNode) {
  return new AgentSiteRuntime(
    <Agent>
      <SystemPrompt>You help callers.</SystemPrompt>
      {tools}
    </Agent>,
  );
}

function scripted(replies: Reply[]): AgentLlmClient {
  let step = 0;
  return async () => replies[step++] ?? { text: "", toolCalls: [] };
}

describe("follow-through check in a spoken turn", () => {
  it("speaks an end_call goodbye given on a step after the check ran a tool", async () => {
    const runtime = runtimeWith(
      <Tool
        name="lookup_order"
        description="Look up an order."
        schema={z.object({ orderId: z.string() })}
        onSubmit={() => ({ ok: true, message: "Order 123456 ships tomorrow." })}
      />,
    );
    let ended = false;
    runtime.setEndCallRequest(() => {
      ended = true;
    });
    const llm = scripted([
      { text: "Let me check your order.", toolCalls: [] },
      { text: "", toolCalls: [{ id: "tc1", name: "lookup_order", input: { orderId: "123456" } }] },
      {
        text: "",
        toolCalls: [{ id: "tc2", name: END_CALL_TOOL_NAME, input: { goodbye: "Your order ships tomorrow. Goodbye." } }],
      },
    ]);
    const session = new AgentSession(runtime, llm, { checkFollowThrough: true });

    const reply = await session.runTurn("Where is my order 123456?", { spoken: true });

    expect(ended).toBe(true);
    expect(reply).toContain("Your order ships tomorrow. Goodbye.");
  });

  it("skips a non-ending check when only one model step remains", async () => {
    let bookings = 0;
    const runtime = runtimeWith(
      <Tool
        name="book_slot"
        description="Book a slot."
        schema={z.object({ day: z.string() })}
        onSubmit={() => {
          bookings += 1;
          return { ok: true, message: "Booked." };
        }}
      />,
    );
    const llm = scripted([
      { text: "I will book Monday for you now.", toolCalls: [] },
      { text: "", toolCalls: [{ id: "tc1", name: "book_slot", input: { day: "Monday" } }] },
      { text: "All booked for Monday.", toolCalls: [] },
    ]);
    const session = new AgentSession(runtime, llm, { maxSteps: 2, checkFollowThrough: true });

    const errors: unknown[] = [];
    for await (const event of session.runTurnStream("Book Monday please.", { spoken: true })) {
      if (event.type === "error") errors.push(event);
    }

    expect(errors).toEqual([]);
    expect(bookings).toBe(0);
  });

  it.each([false, true])("only offers end_call in the final step after an action (extra call: %s)", async (extraCall) => {
    let unrelatedCalls = 0;
    const runtime = runtimeWith(
      <>
        <Tool name="book_slot" description="Book a slot." onSubmit={() => ({ ok: true, message: "Booked." })} />
        <Tool
          name="send_reminder"
          description="Send a reminder."
          onSubmit={() => {
            unrelatedCalls += 1;
            return { ok: true };
          }}
        />
      </>,
    );
    let hangups = 0;
    runtime.setEndCallRequest(() => {
      hangups += 1;
    });
    const respond = scripted([
      { text: "", toolCalls: [{ name: "book_slot", input: {} }] },
      { text: "You are booked. Goodbye.", toolCalls: [] },
      {
        text: "",
        toolCalls: [
          ...(extraCall ? [{ name: "send_reminder", input: {} }] : []),
          { name: END_CALL_TOOL_NAME, input: { goodbye: "Bye." } },
        ],
      },
    ]);
    const requests: Parameters<AgentLlmClient>[0][] = [];
    const session = new AgentSession(runtime, (request) => {
      requests.push(request);
      return respond(request);
    }, { maxSteps: 3, checkFollowThrough: true });

    const errors: unknown[] = [];
    for await (const event of session.runTurnStream("Book a slot, please. Goodbye.", { spoken: true })) {
      if (event.type === "error") errors.push(event);
    }

    expect(errors).toEqual([]);
    expect(hangups).toBe(extraCall ? 0 : 1);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.tools.map((tool) => tool.name)).toEqual([END_CALL_TOOL_NAME]);
    expect(unrelatedCalls).toBe(0);
  });
});

describe("inventedNumber: phone numbers in follow-through calls", () => {
  it("accepts a number the caller gave with a (0) trunk prefix, in international or national form", () => {
    const heard = ["My phone number is +49 (0) 30 1234567."];
    expect(inventedNumber({ phone: "+49 30 1234567" }, heard)).toBeUndefined();
    expect(inventedNumber({ phone: "030 1234567" }, heard)).toBeUndefined();
    expect(inventedNumber({ orderId: "+49 30 1234567" }, ["My order number is +49 (0) 30 1234567."]))
      .toBe("+49 30 1234567");
  });

  it("treats a nullable string field with format tel as a phone field", () => {
    const [field] = zodSchemaToFields(z.object({ contact: z.string().meta({ format: "tel" }).nullable() }));
    const schema = { type: "object", properties: { contact: field!.jsonSchema } };
    expect(inventedNumber({ contact: "12345678" }, ["My order number is 12345678."], schema)).toBe("12345678");
    expect(inventedNumber({ contact: "12345678" }, ["My phone number is 12345678."], schema)).toBeUndefined();
    expect(inventedNumber({ contact: null }, [], schema)).toBeUndefined();
  });

  it("allows an identifier in a non-phone branch of a mixed schema", () => {
    const [field] = zodSchemaToFields(z.object({
      contact: z.union([z.string().meta({ format: "tel" }), z.number().int()]),
    }));
    const schema = { type: "object", properties: { contact: field!.jsonSchema } };
    expect(inventedNumber({ contact: 12345678 }, ["My order number is 12345678."], schema)).toBeUndefined();
  });
});
