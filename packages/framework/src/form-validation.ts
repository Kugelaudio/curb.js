import { z } from "zod";
import { validateSchemaInput } from "./form-schema.js";
import type { FieldDefinition } from "./types.js";

/** A `<Field>` tool's input, refused exactly like a `<Tool schema>`'s: its fields make the
 * zod schema. */
export function validateToolInput(
  toolName: string,
  fields: FieldDefinition[],
  input: Record<string, unknown>,
) {
  return validateSchemaInput(toolName, fieldsToZodObject(fields), input);
}

function fieldsToZodObject(fields: FieldDefinition[]) {
  return z.object(
    Object.fromEntries(fields.map((field) => [field.name, fieldToZodSchema(field)])),
  );
}

function fieldToZodSchema(field: FieldDefinition) {
  let schema: z.ZodType;

  switch (field.type) {
    case "email":
      schema = z.string().email("Email address is invalid. Ask the user for a corrected email address.");
      break;
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.coerce.number();
      break;
    case "integer":
      schema = z.coerce.number().int();
      break;
    case "boolean":
      schema = z.coerce.boolean();
      break;
  }

  return field.required ? schema : schema.optional();
}
