import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ReactElement } from "react";
import { z } from "zod";
import { AgentAuthoringError } from "./authoring.js";
import { compileSite } from "./compiler.js";
import { Agent, Tool, defineTool } from "./components.js";
import { validateSchemaInput, zodSchemaToFields, type ZodObjectSchema } from "./form-schema.js";
import { validateToolInput } from "./form-validation.js";
import { serializeLlmInput } from "./llm/serialize-input.js";
import { formFields, inputFromForm } from "./preview/tool-form.js";
import { createSemanticRoot } from "./reconciler.js";
import { agentAppElement } from "./routing.js";
import { AgentSiteRuntime } from "./runtime.js";
import type { FieldDefinition, ToolResult } from "./types.js";

/** The input schema of a `<Tool>` with this zod schema, exactly as the model receives
 * it: the compiled tool's `inputSchema` in the payload `serializeLlmInput` builds,
 * through JSON. */
function schemaSentToModel(schema: ZodObjectSchema): unknown {
  const findSlot = defineTool({
    name: "find_slot",
    description: "Find a free appointment slot.",
    schema,
    onSubmit: () => ({ ok: true }),
  });
  function Home() {
    return <Tool def={findSlot} />;
  }
  const root = createSemanticRoot();
  root.render(
    agentAppElement(() => <Agent />, {
      path: "/claims",
      loadedPaths: ["/claims"],
      routes: [{ path: "/claims", Component: Home }],
    }),
  );
  const { context } = compileSite(root.container.root, ["/claims"]);
  const input = serializeLlmInput({
    systemPrompt: "",
    skillTitle: "",
    stateSnapshot: [],
    tools: context.tools,
    messages: [],
  });
  return JSON.parse(JSON.stringify(input.tools.find_slot?.inputSchema));
}

describe("a <Tool schema> as the model receives it", () => {
  it("keeps a description written after .optional() or .default(), and a default makes a field optional", () => {
    expect(
      schemaSentToModel(
        z.object({
          date: z.string().optional().describe("Only slots on this day."),
          minutes: z.number().default(30).describe("Length of the meeting in minutes."),
        }),
      ),
    ).toStrictEqual({
      type: "object",
      properties: {
        date: { type: "string", description: "Only slots on this day." },
        minutes: { type: "number", default: 30, description: "Length of the meeting in minutes." },
      },
      additionalProperties: false,
    });
  });

  it("keeps a description written before .optional(), and the outermost one wins", () => {
    expect(
      schemaSentToModel(
        z.object({
          note: z.string().describe("Anything else the caller asked for.").optional(),
          channel: z.string().describe("Replaced by the outer description.").optional().describe("Phone or video."),
        }),
      ),
    ).toStrictEqual({
      type: "object",
      properties: {
        note: { type: "string", description: "Anything else the caller asked for." },
        channel: { type: "string", description: "Phone or video." },
      },
      additionalProperties: false,
    });
  });

  it("sends a z.enum, or a union of string literals, as a string with its allowed values", () => {
    expect(
      schemaSentToModel(
        z.object({
          daypart: z
            .enum(["vormittag", "nachmittag"])
            .optional()
            .describe("Only morning (before 12:00) or afternoon slots, when the caller prefers one."),
          channel: z.union([z.literal("phone"), z.literal("video")]).describe("How the meeting takes place."),
        }),
      ),
    ).toStrictEqual({
      type: "object",
      properties: {
        daypart: {
          type: "string",
          description: "Only morning (before 12:00) or afternoon slots, when the caller prefers one.",
          enum: ["vormittag", "nachmittag"],
        },
        channel: {
          type: "string",
          description: "How the meeting takes place.",
          enum: ["phone", "video"],
        },
      },
      required: ["channel"],
      additionalProperties: false,
    });
  });

  it("puts an enum's values on the field definition, so a form can offer them", () => {
    const [daypart, level] = zodSchemaToFields(
      z.object({
        daypart: z.enum(["vormittag", "nachmittag"]).optional(),
        level: z.enum({ Low: 1, High: 2 }),
      }),
    );

    expect(daypart).toEqual({
      name: "daypart",
      type: "string",
      enum: ["vormittag", "nachmittag"],
      required: false,
      jsonSchema: { type: "string", enum: ["vormittag", "nachmittag"] },
    });
    // Only string values are offered: a number enum is no list of strings to choose from.
    expect(level).not.toHaveProperty("enum");
  });

  it("sends a .regex() as the field's pattern, and a format's own regex not at all", () => {
    expect(
      schemaSentToModel(
        z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "Ask for the day as YYYY-MM-DD.")
            .optional()
            .describe("Only slots on this day, when the caller wants a specific day."),
          day: z.iso.date().describe("The day of the meeting."),
        }),
      ),
    ).toStrictEqual({
      type: "object",
      properties: {
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Only slots on this day, when the caller wants a specific day.",
        },
        day: { type: "string", format: "date", description: "The day of the meeting." },
      },
      required: ["day"],
      additionalProperties: false,
    });
  });

  it("keeps required, email, number and boolean fields, with their limits", () => {
    expect(
      schemaSentToModel(
        z.object({
          name: z.string().min(1).describe("The caller's name."),
          email: z
            .string()
            .email("Email address is invalid. Ask the user for a corrected email address.")
            .describe("Where the confirmation goes."),
          guests: z.number().describe("How many people come."),
          nights: z.int().describe("How many nights they stay."),
          recurring: z.boolean().optional(),
        }),
      ),
    ).toStrictEqual({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "The caller's name." },
        email: { type: "string", description: "Where the confirmation goes.", format: "email" },
        guests: { type: "number", description: "How many people come." },
        // `.int()` alone carries no limits: zod's safe-integer bounds are left out.
        nights: { type: "integer", description: "How many nights they stay." },
        recurring: { type: "boolean" },
      },
      required: ["name", "email", "guests", "nights"],
      additionalProperties: false,
    });
  });
});

const orderSchema = z.object({
  room: z.string().describe("The guest's room number."),
  items: z
    .array(
      z
        .object({
          name: z.string().describe("A dish or drink from the menu."),
          quantity: z.int().min(1).max(20).describe("How many."),
          note: z.string().optional().describe("A wish for the kitchen."),
        })
        .describe("One line of the order."),
    )
    .min(1)
    .describe("Everything the guest ordered."),
});

function orderRuntime(onSubmit: (order: z.infer<typeof orderSchema>) => ToolResult) {
  return new AgentSiteRuntime(
    <Agent>
      <Tool name="order_room_service" description="Order to a room." schema={orderSchema} onSubmit={onSubmit} />
    </Agent>,
  );
}

const ORDER = {
  room: "204",
  items: [
    { name: "Club sandwich", quantity: 2 },
    { name: "Sparkling water", quantity: 1, note: "Cold." },
  ],
};

describe("a <Tool schema> with lists, nested objects and nullables", () => {
  it("shows the model a list of objects, with every description, limit and required field", () => {
    expect(schemaSentToModel(orderSchema)).toStrictEqual({
      type: "object",
      properties: {
        room: { type: "string", description: "The guest's room number." },
        items: {
          type: "array",
          minItems: 1,
          description: "Everything the guest ordered.",
          items: {
            type: "object",
            description: "One line of the order.",
            properties: {
              name: { type: "string", description: "A dish or drink from the menu." },
              quantity: { type: "integer", minimum: 1, maximum: 20, description: "How many." },
              note: { type: "string", description: "A wish for the kitchen." },
            },
            required: ["name", "quantity"],
          },
        },
      },
      required: ["room", "items"],
      additionalProperties: false,
    });
  });

  it("hands a valid order to onSubmit parsed and typed", async () => {
    const onSubmit = vi.fn((order: z.infer<typeof orderSchema>): ToolResult => {
      expectTypeOf(order.items[0]!.quantity).toEqualTypeOf<number>();
      return { ok: true, data: order.items.reduce((total, item) => total + item.quantity, 0) };
    });

    const { result } = await orderRuntime(onSubmit).callTool("order_room_service", ORDER);

    expect(result).toEqual({ ok: true, data: 3 });
    expect(onSubmit).toHaveBeenCalledWith(ORDER);
  });

  it("refuses an invalid order and names the path of every problem", async () => {
    const onSubmit = vi.fn((): ToolResult => ({ ok: true }));

    const { result } = await orderRuntime(onSubmit).callTool("order_room_service", {
      room: "204",
      items: [{ name: "Club sandwich", quantity: 0 }, { quantity: 2 }],
    });

    expect(result.ok).toBe(false);
    const lines = result.message?.split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^items\.0\.quantity: .*>=1/);
    expect(lines[1]).toMatch(/^items\.1\.name: /);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a list the model sent as one string", async () => {
    const { result } = await orderRuntime(() => ({ ok: true })).callTool("order_room_service", {
      room: "204",
      items: "2 club sandwiches, 1 water",
    });

    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/expected array/) });
  });

  it("names each top-level field when several are wrong, and keeps a lone field's own message", () => {
    const schema = z.object({
      guests: z.number(),
      email: z.email("Ask for the email again."),
    });

    expect(() => validate(schema, { guests: "two", email: "x" })).toThrow(
      /^guests: .*expected number.*\nemail: Ask for the email again\.$/,
    );
    expect(() => validate(schema, { guests: 2, email: "x" })).toThrow(/^Ask for the email again\.$/);
  });

  it("takes null for a nullable field and still counts null as missing elsewhere", () => {
    const schema = z.object({
      tip: z.number().nullable().describe("Tip in euros, or null for none."),
      floor: z.number().int().min(1).nullable(),
      note: z.string().nullish(),
      room: z.string(),
    });

    // zod (4.6) writes a bare nullable as a type array and a constrained one as `anyOf`.
    expect(schemaSentToModel(schema)).toStrictEqual({
      type: "object",
      properties: {
        tip: { type: ["number", "null"], description: "Tip in euros, or null for none." },
        floor: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        note: { type: ["string", "null"] },
        room: { type: "string" },
      },
      required: ["tip", "floor", "room"],
      additionalProperties: false,
    });
    expect(validate(schema, { tip: null, floor: null, room: "204" })).toEqual({ tip: null, floor: null, room: "204" });
    expect(validate(schema, { tip: 5, floor: 2, note: null, room: "204" })).toEqual({ tip: 5, floor: 2, note: null, room: "204" });
    expect(() => validate(schema, { room: "204" })).toThrow("Missing required fields: tip, floor.");
    expect(() => validate(schema, { tip: null, floor: null, room: null })).toThrow("Missing required fields: room.");
  });

  it("writes a schema registered with an id in place", () => {
    const item = z.object({ name: z.string().describe("The dish.") }).meta({ id: "OrderItem" });

    expect(schemaSentToModel(z.object({ first: item.describe("The starter."), rest: z.array(item) }))).toStrictEqual({
      type: "object",
      properties: {
        first: {
          type: "object",
          properties: { name: { type: "string", description: "The dish." } },
          required: ["name"],
          description: "The starter.",
        },
        rest: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string", description: "The dish." } },
            required: ["name"],
          },
        },
      },
      required: ["first", "rest"],
      additionalProperties: false,
    });
  });

  it("refuses a recursive schema or a type JSON cannot carry as an authoring error", () => {
    const category: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(category);
      },
    });

    expect(() => zodSchemaToFields(z.object({ when: z.date() }))).toThrow(AgentAuthoringError);
    expect(() => zodSchemaToFields(z.object({ when: z.date() }))).toThrow(/Date cannot be represented/);
    expect(() => zodSchemaToFields(z.object({ tree: category }))).toThrow(/Cycle detected/);
  });

  it("gives a list a JSON input in the Try form, which the tool then accepts", async () => {
    const onSubmit = vi.fn((): ToolResult => ({ ok: true }));
    const runtime = orderRuntime(onSubmit);
    const tool = runtime.snapshot().context.tools.find((entry) => entry.name === "order_room_service");
    const fields = formFields(tool!.inputSchema);

    expect(fields.map((field) => [field.name, field.control])).toEqual([
      ["room", "text"],
      ["items", "json"],
    ]);
    expect(inputFromForm(fields, { room: "204", items: "[{name: Tea}]" })).toEqual({
      error: "items is not valid JSON.",
    });
    const form = inputFromForm(fields, { room: "204", items: JSON.stringify(ORDER.items) });
    expect(form).toEqual({ input: ORDER });

    const { result } = await runtime.callTool("order_room_service", "input" in form ? form.input : {});
    expect(result.ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith(ORDER);
  });
});

describe("a <Field> tool", () => {
  it("is refused like a <Tool schema>", () => {
    const fields: FieldDefinition[] = [
      { name: "order", type: "string", required: true },
      { name: "guests", type: "number", required: true },
      { name: "email", type: "email" },
    ];

    expect(validateToolInput("track_order", fields, { order: "A-1", guests: "3" })).toEqual({
      order: "A-1",
      guests: 3,
    });
    expect(() => validateToolInput("track_order", fields, { order: " ", guests: null })).toThrow(
      "Missing required fields: order, guests.",
    );
    expect(() => validateToolInput("track_order", fields, { order: "A-1", guests: 1, email: "x" })).toThrow(
      "Email address is invalid. Ask the user for a corrected email address.",
    );
  });
});

describe("a <Tool tryWith>", () => {
  const verifySchema = z.object({
    customerNumber: z.string().describe("Customer number in the form K-123456."),
    birthYear: z.number().int().describe("Year of birth, four digits."),
  });
  const onSubmit = (): ToolResult => ({ ok: true });

  function compiledTools(tool: ReactElement) {
    const root = createSemanticRoot();
    root.render(
      agentAppElement(() => <Agent />, {
        path: "/account",
        loadedPaths: ["/account"],
        routes: [{ path: "/account", Component: () => tool }],
      }),
    );
    return compileSite(root.container.root, ["/account"]).context.tools;
  }

  it("gives the preview's Try form its input, and the model nothing of it", () => {
    const tools = compiledTools(
      <Tool
        name="verify_customer"
        description="Verify a customer."
        schema={verifySchema}
        tryWith={{ customerNumber: "K-482913", birthYear: 1985 }}
        onSubmit={onSubmit}
      />,
    );
    expect(tools[0]?.tryWith).toEqual({ customerNumber: "K-482913", birthYear: 1985 });

    const sent = JSON.stringify(
      serializeLlmInput({ systemPrompt: "", skillTitle: "", stateSnapshot: [], tools, messages: [] }),
    );
    expect(sent).toContain("verify_customer");
    expect(sent).not.toContain("K-482913");
  });

  it("refuses a tryWith that is not an object", () => {
    expect(() =>
      compiledTools(
        <Tool name="verify_customer" description="Verify a customer." schema={verifySchema} tryWith={"K-482913" as never} onSubmit={onSubmit} />,
      ),
    ).toThrow(AgentAuthoringError);
  });

  it("takes some or all of the schema's fields, typed as the schema reads them", () => {
    const some = <Tool name="v" description="v" schema={verifySchema} tryWith={{ birthYear: 1985 }} onSubmit={onSubmit} />;
    // @ts-expect-error customerId is not a field of the schema
    const unknown = <Tool name="v" description="v" schema={verifySchema} tryWith={{ customerId: "K-482913" }} onSubmit={onSubmit} />;
    // @ts-expect-error birthYear is a number
    const mistyped = <Tool name="v" description="v" schema={verifySchema} tryWith={{ birthYear: "1985" }} onSubmit={onSubmit} />;
    expect([some, unknown, mistyped]).toHaveLength(3);
  });
});

function validate(schema: ZodObjectSchema, input: Record<string, unknown>) {
  return validateSchemaInput("book_table", schema, input);
}
