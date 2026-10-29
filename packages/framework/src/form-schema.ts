import { z } from "zod";
import { AgentAuthoringError, AUTHORING_DIAGNOSTIC_CODES } from "./authoring.js";
import { ToolInputError, type FieldDefinition, type JsonSchemaNode } from "./types.js";

export type ZodObjectSchema = z.ZodObject<z.ZodRawShape>;

/** The most problems one refusal lists; the model fixes those and calls again. */
const MAX_REPORTED_ISSUES = 10;

/**
 * A `<Tool schema>`'s fields, each with the JSON Schema the model gets for it: zod's own
 * (`z.toJSONSchema`, input side), so lists, nested objects, nullables, enums, number ranges,
 * string formats and patterns, and every `.describe()` reach the model as written. A
 * `.default()` field may be left out, as zod allows. `type`, `enum` and `description`
 * repeat the flat part for forms.
 */
export function zodSchemaToFields(schema: ZodObjectSchema): FieldDefinition[] {
  const document = inputJsonSchema(schema);
  const required = new Set(document.required ?? []);
  return Object.entries(document.properties ?? {}).map(([name, jsonSchema]) => ({
    name,
    ...flatField(jsonSchema),
    required: required.has(name),
    jsonSchema,
  }));
}

export function validateSchemaInput(
  toolName: string,
  schema: ZodObjectSchema,
  input: Record<string, unknown>,
) {
  const missingFields = zodSchemaToFields(schema)
    .filter((field) => field.required && isMissing(input[field.name], field.jsonSchema))
    .map((field) => field.name);

  if (missingFields.length > 0) {
    throw new ToolInputError(`Missing required fields: ${missingFields.join(", ")}.`);
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ToolInputError(formatZodError(toolName, result.error));
  }

  return result.data;
}

/** Left out, blank, or `null` for a field whose schema has no `null` in it. */
function isMissing(value: unknown, schema: JsonSchemaNode | undefined) {
  if (value === null) return !(schema && acceptsNull(schema));
  return value === undefined || (typeof value === "string" && value.trim().length === 0);
}

/** Whether a node allows `null`. zod writes a bare nullable as `type: [X, "null"]` (from 4.6)
 * and any other one as `anyOf` with a `null` branch. */
function acceptsNull(schema: JsonSchemaNode): boolean {
  const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("null") || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
  return [schema.anyOf, schema.oneOf].some(
    (options) => Array.isArray(options) && options.some((option) => isRecord(option) && acceptsNull(option)),
  );
}

/** The flat type, enum and description a form draws a field with. */
function flatField(schema: JsonSchemaNode): Pick<FieldDefinition, "type" | "description" | "enum"> {
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const values = schema.enum;
  if (Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string")) {
    return { type: "string", enum: values as string[], description };
  }

  switch (schema.type) {
    case "string":
      return { type: schema.format === "email" ? "email" : "string", description };
    case "number":
    case "integer":
    case "boolean":
      return { type: schema.type, description };
    default:
      return { type: "string", description };
  }
}

type InputDocument = {
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  $defs?: Record<string, JsonSchemaNode>;
};

/**
 * The input side of the tool's zod schema as JSON Schema, tidied (`tidyNode`). A recursive
 * schema and a type JSON cannot carry (a `z.date()`, a `z.bigint()`) are authoring errors:
 * the model could never send them.
 */
function inputJsonSchema(schema: ZodObjectSchema): InputDocument {
  let document: InputDocument;
  try {
    document = z.toJSONSchema(schema, { io: "input", cycles: "throw", override: tidyNode }) as InputDocument;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    throw new AgentAuthoringError({
      code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
      severity: "error",
      message: `A <Tool schema> has a field the model cannot be shown: ${reason}`,
      location: { component: "Tool" },
      fix:
        "Use types JSON can carry: z.iso.date() or z.iso.datetime() for a date (add .transform() to get a Date), " +
        "z.number() for a bigint, z.array() for a set, and nesting of a fixed depth instead of a recursive schema.",
    });
  }
  const defs = document.$defs;
  if (!defs) return document;
  return { ...document, properties: inlineDefs(document.properties, defs) as InputDocument["properties"] };
}

/** zod's noise for the model removed, and a choice of strings written as one `enum`, the way a
 * `z.enum` is. zod calls it for every node, children before their parents. */
const tidyNode: NonNullable<z.core.ToJSONSchemaParams["override"]> = ({ zodSchema, jsonSchema: node }) => {
  // A format's own regex (`z.email()`, `z.iso.date()`) only repeats what `format` says.
  if (node.format && node.pattern && formatPatterns(zodSchema).has(node.pattern)) delete node.pattern;
  // `.int()` adds JavaScript's safe-integer limits, which say nothing about the tool.
  if (node.minimum === Number.MIN_SAFE_INTEGER) delete node.minimum;
  if (node.maximum === Number.MAX_SAFE_INTEGER) delete node.maximum;

  if (node.type === "string" && typeof node.const === "string") {
    node.enum = [node.const];
    delete node.const;
  }
  const choices = node.anyOf?.map(stringChoices);
  if (choices?.every((values): values is string[] => values !== undefined)) {
    delete node.anyOf;
    node.type = "string";
    node.enum = choices.flat();
  }
};

/** The strings a node allows when it is a plain `{ type: "string", enum }` and nothing else. */
function stringChoices(node: z.core.JSONSchema.JSONSchema): string[] | undefined {
  const { type, enum: values, ...rest } = node;
  if (type !== "string" || Object.keys(rest).length > 0 || !values) return undefined;
  return values.every((value) => typeof value === "string") ? (values as string[]) : undefined;
}

/** The regexes a string format brings (`z.email()`, `.email()`, `z.iso.date()`), as zod
 * writes them. An author's `.regex()` is not one of them and stays. */
function formatPatterns(schema: z.core.$ZodType): Set<string> {
  const checks = (schema._zod.def as { checks?: z.core.$ZodCheck[] }).checks ?? [];
  const defs = [schema._zod.def, ...checks.map((check) => check._zod.def)] as Array<{
    format?: string;
    pattern?: RegExp;
  }>;
  return new Set(
    defs.flatMap(({ format, pattern }) => (format && format !== "regex" && pattern ? [pattern.source] : [])),
  );
}

const DEFS_PREFIX = "#/$defs/";

/** zod moves a schema with an id (`.meta({ id })`) into `$defs` and points at it. Every field
 * goes to the model on its own, so each pointer is replaced by its definition. */
function inlineDefs(node: unknown, defs: Record<string, JsonSchemaNode>): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineDefs(item, defs));
  if (!isRecord(node)) return node;
  const ref =
    typeof node.$ref === "string" && node.$ref.startsWith(DEFS_PREFIX) ? node.$ref.slice(DEFS_PREFIX.length) : undefined;
  const own = Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => ref === undefined || key !== "$ref")
      .map(([key, value]) => [key, inlineDefs(value, defs)]),
  );
  return ref === undefined ? own : { ...(inlineDefs(defs[ref], defs) as JsonSchemaNode), ...own };
}

/**
 * Every problem (at most `MAX_REPORTED_ISSUES`), one per line, so the model fixes them in one
 * call. A problem inside a list or an object names its path (`items.0.quantity: ...`); a lone
 * problem of a top-level field reads as its message, which authors write for the model.
 */
function formatZodError(toolName: string, error: z.ZodError) {
  if (error.issues.length === 0) return `Input for ${toolName} is invalid.`;

  const named = error.issues.length > 1;
  const lines = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path && (named || issue.path.length > 1) ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - lines.length;
  return [...lines, ...(more > 0 ? [`(and ${more} more)`] : [])].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
