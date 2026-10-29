// A minimal JSON Schema 2020-12 validator, for exactly the keywords
// `packages/framework/src/hosted/protocol.schema.json` uses.
//
// It exists so the self-host smoke validates a runner's answers against the PUBLISHED
// schema, the file a host in another language builds from, without adding a dependency.
// A keyword it does not implement THROWS instead of passing: if the emitted schema grows a
// new constraint, this check must fail loudly rather than silently accept everything.

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description", "default", "examples"]);

const IMPLEMENTED = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "items",
  "oneOf",
  "anyOf",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeOf(value) === type;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A validator over one schema document. `validate(name, value)` checks `value` against
 * `$defs[name]` and returns the list of violations, empty when the value is valid.
 */
export function schemaValidator(document) {
  const defs = document.$defs ?? {};

  function resolve(ref) {
    const prefix = "#/$defs/";
    if (!ref.startsWith(prefix)) throw new Error(`json-schema-lite: unsupported $ref ${ref}`);
    const target = defs[ref.slice(prefix.length)];
    if (target === undefined) throw new Error(`json-schema-lite: ${ref} does not resolve`);
    return target;
  }

  function check(schema, value, path, errors) {
    if (schema === true || (typeof schema === "object" && Object.keys(schema).length === 0)) return;
    if (schema === false) {
      errors.push(`${path}: no value is allowed here`);
      return;
    }
    for (const keyword of Object.keys(schema)) {
      if (!IMPLEMENTED.has(keyword) && !ANNOTATIONS.has(keyword)) {
        throw new Error(`json-schema-lite: keyword "${keyword}" at ${path} is not implemented`);
      }
    }

    if (schema.$ref !== undefined) check(resolve(schema.$ref), value, path, errors);

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((type) => matchesType(value, type))) {
        errors.push(`${path}: expected ${types.join(" | ")}, got ${typeOf(value)}`);
        return;
      }
    }
    if ("const" in schema && !deepEqual(value, schema.const)) {
      errors.push(`${path}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    }
    if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(option, value))) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }

    if (typeof value === "string") {
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength) {
        errors.push(`${path}: shorter than ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        errors.push(`${path}: longer than ${schema.maxLength}`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
        errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
      }
    }

    if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
        errors.push(`${path}: must be above ${schema.exclusiveMinimum}`);
      }
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
        errors.push(`${path}: must be below ${schema.exclusiveMaximum}`);
      }
    }

    if (Array.isArray(value) && schema.items !== undefined) {
      value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
    }

    if (typeOf(value) === "object") {
      const properties = schema.properties ?? {};
      for (const name of schema.required ?? []) {
        if (!(name in value)) errors.push(`${path}: missing required "${name}"`);
      }
      for (const [name, item] of Object.entries(value)) {
        if (name in properties) check(properties[name], item, `${path}.${name}`, errors);
        else if (schema.additionalProperties !== undefined) {
          check(schema.additionalProperties, item, `${path}.${name}`, errors);
        }
        if (schema.propertyNames !== undefined) check(schema.propertyNames, name, `${path} key ${name}`, errors);
      }
    }

    if (schema.oneOf !== undefined) {
      const passing = schema.oneOf.filter((option) => {
        const optionErrors = [];
        check(option, value, path, optionErrors);
        return optionErrors.length === 0;
      }).length;
      if (passing !== 1) errors.push(`${path}: matches ${passing} of the oneOf options, expected exactly 1`);
    }
    if (schema.anyOf !== undefined) {
      const any = schema.anyOf.some((option) => {
        const optionErrors = [];
        check(option, value, path, optionErrors);
        return optionErrors.length === 0;
      });
      if (!any) errors.push(`${path}: matches none of the anyOf options`);
    }
  }

  return {
    validate(name, value) {
      if (!(name in defs)) throw new Error(`json-schema-lite: no $defs entry named ${name}`);
      const errors = [];
      check(defs[name], value, name, errors);
      return errors;
    },
  };
}
