import { describe, expect, it } from "vitest";
import type { ToolInputSchema } from "../types.js";
import { emptyForm, formFields, formFromInput, inputFromForm } from "./tool-form.js";

const schema: ToolInputSchema = {
  type: "object",
  properties: {
    date: { type: "string", description: "One day." },
    daypart: { type: "string", enum: ["morning", "afternoon"] },
    room: { type: "string", enum: ["a", "b", "c", "d", "e"] },
    email: { type: "string", format: "email" },
    guests: { type: "integer" },
    remind: { type: "boolean" },
    attendees: { type: "array", items: { type: "string" } },
  },
  required: ["date"],
};

describe("a tool's form", () => {
  it("picks each field's control from its schema type, generic for any tool", () => {
    expect(formFields(schema).map((field) => [field.name, field.control, field.required])).toEqual([
      ["date", "text", true],
      ["daypart", "pills", false],
      ["room", "select", false],
      ["email", "email", false],
      ["guests", "number", false],
      ["remind", "switch", false],
      ["attendees", "json", false],
    ]);
    expect(formFields(schema)[0].description).toBe("One day.");
  });

  it("sends typed values and leaves empty fields out for the tool to validate", () => {
    const fields = formFields(schema);
    const values = { ...emptyForm(fields), daypart: "morning", guests: "3", remind: true, attendees: '["Ada"]' };

    expect(inputFromForm(fields, values)).toEqual({
      input: { daypart: "morning", guests: 3, remind: true, attendees: ["Ada"] },
    });
  });

  it("says which field does not parse instead of sending it", () => {
    const fields = formFields(schema);

    expect(inputFromForm(fields, { ...emptyForm(fields), guests: "three" })).toEqual({
      error: "guests must be a number.",
    });
    expect(inputFromForm(fields, { ...emptyForm(fields), attendees: "[Ada" })).toEqual({
      error: "attendees is not valid JSON.",
    });
  });

  it("draws a nullable field as the type it allows besides null", () => {
    const nullable: ToolInputSchema = {
      type: "object",
      properties: {
        // zod 4.6 writes a bare nullable as a type array, a constrained one as `anyOf`.
        tip: { type: ["number", "null"], description: "Tip in euros." },
        daypart: { anyOf: [{ type: "string", enum: ["morning", "afternoon"] }, { type: "null" }] },
        items: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
      },
      required: ["tip"],
    };

    expect(formFields(nullable).map((field) => [field.name, field.control, field.description])).toEqual([
      ["tip", "number", "Tip in euros."],
      ["daypart", "pills", undefined],
      ["items", "json", undefined],
    ]);
  });

  it("fills the form with the arguments the agent sent", () => {
    const fields = formFields(schema);

    expect(formFromInput(fields, { date: "2026-10-27", guests: 2, remind: true, attendees: ["Ada"] })).toMatchObject({
      date: "2026-10-27",
      guests: "2",
      remind: true,
      attendees: '["Ada"]',
      daypart: "",
    });
  });
});
