import type { FieldDefinition, ToolInputSchema } from "../types.js";

/**
 * A tool's input as a form, from its schema alone: the field name is the label, the
 * schema's description is the help text, and the type picks the control. The Try dialog
 * fills it; nothing here knows any particular tool.
 */

/** How a field is edited: text, an email, a number, a switch, a pill group for a short
 * enum, a select for a long one, or JSON for anything the schema nests (a list, an object). */
export type FieldControl = "text" | "email" | "number" | "switch" | "pills" | "select" | "json";

export type FormField = FieldDefinition & { control: FieldControl };

export type FormValues = Record<string, string | boolean>;

/** Up to this many enum values show as pills; more as a select. */
export const MAX_PILLS = 4;

function enumValues(property: Record<string, unknown>): string[] | undefined {
  const values = property.enum;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values.every((value) => typeof value === "string") ? (values as string[]) : undefined;
}

/** What a nullable field (`type: [X, "null"]`, or `anyOf` the type and `null`) allows besides
 * `null`: it is drawn as that type, and left empty when it should be none. */
function withoutNull(property: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(property.type)) {
    const types = property.type.filter((type) => type !== "null");
    return types.length === 1 ? { ...property, type: types[0] } : property;
  }
  const options = Array.isArray(property.anyOf) ? (property.anyOf as Array<Record<string, unknown>>) : [];
  const others = options.filter((option) => option?.type !== "null");
  return options.length === 2 && others.length === 1 ? others[0]! : property;
}

export function formFields(schema: ToolInputSchema): FormField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, field]) => {
    const base = {
      name,
      description: typeof field.description === "string" ? field.description : undefined,
      required: required.has(name),
    };
    const property = withoutNull(field);
    const values = enumValues(property);
    if (values) {
      return { ...base, type: "string", enum: values, control: values.length <= MAX_PILLS ? "pills" : "select" };
    }
    switch (property.type) {
      case "string":
        return property.format === "email"
          ? { ...base, type: "email", control: "email" }
          : { ...base, type: "string", control: "text" };
      case "number":
      case "integer":
        return { ...base, type: property.type, control: "number" };
      case "boolean":
        return { ...base, type: "boolean", control: "switch" };
      default:
        return { ...base, type: "string", control: "json" };
    }
  });
}

/** The form's starting values: every switch off, everything else empty. */
export function emptyForm(fields: readonly FormField[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.name, field.control === "switch" ? false : ""]));
}

/**
 * The tool input the form says. Empty fields are left out, so a required one left empty
 * reaches the tool missing and the tool's own validation names it, as it would for the
 * model. A number or JSON field that does not parse is the form's own error.
 */
export function inputFromForm(
  fields: readonly FormField[],
  values: FormValues,
): { input: Record<string, unknown> } | { error: string } {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.control === "switch") {
      input[field.name] = value === true;
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") continue;
    if (field.control === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) return { error: `${field.name} must be a number.` };
      input[field.name] = number;
    } else if (field.control === "json") {
      try {
        input[field.name] = JSON.parse(value);
      } catch {
        return { error: `${field.name} is not valid JSON.` };
      }
    } else {
      input[field.name] = value;
    }
  }
  return { input };
}

/** The form for an input: the tool's `tryWith` it opens with, or the agent's call that
 * "Use these" fills in. */
export function formFromInput(fields: readonly FormField[], input: Record<string, unknown>): FormValues {
  const values = emptyForm(fields);
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined || value === null) continue;
    if (field.control === "switch") values[field.name] = value === true;
    else if (field.control === "json" || typeof value === "object") values[field.name] = JSON.stringify(value);
    else values[field.name] = String(value);
  }
  return values;
}
