import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_SCHEMAS,
  protocolJsonSchema,
  renderProtocolJsonSchema,
  type ProtocolTypeName,
} from "./protocol.js";

/**
 * The host protocol as a published contract.
 *
 * `protocol.schema.json` and `protocol-fixtures/` are what implementations in other
 * languages build and test against, so both must agree with the Zod schemas here: the
 * committed schema must be exactly what the schemas emit, and every fixture must parse (or
 * fail) the way its directory says.
 */

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const REGENERATE = "npx tsx src/hosted/emit-protocol-schema.ts";

type Fixture = { file: string; type: ProtocolTypeName; value: unknown };

function fixtures(kind: "valid" | "invalid"): Fixture[] {
  const dir = here(`./protocol-fixtures/${kind}/`);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      // `<Type>.<case>.json`, where <Type> is the `$defs` key.
      const type = file.split(".")[0] as ProtocolTypeName;
      if (!(type in PROTOCOL_SCHEMAS)) {
        throw new Error(`${kind}/${file} names ${type}, which is not a protocol type`);
      }
      return { file, type, value: JSON.parse(readFileSync(`${dir}${file}`, "utf8")) as unknown };
    });
}

describe("protocol.schema.json", () => {
  it("is exactly what the Zod schemas emit", () => {
    const committed = readFileSync(here("./protocol.schema.json"), "utf8");
    const fresh = renderProtocolJsonSchema();
    // The failure message says how to fix it, because the fix is always the same.
    expect(committed === fresh, `protocol.schema.json is stale; run: ${REGENERATE}`).toBe(true);
  });

  it("is one JSON Schema 2020-12 document with every type under $defs", () => {
    const schema = protocolJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    expect(Object.keys(defs)).toEqual(Object.keys(PROTOCOL_SCHEMAS));
    for (const definition of Object.values(defs)) {
      expect(definition.$id).toBeUndefined();
      expect(definition.$schema).toBeUndefined();
    }
  });

  it("resolves every reference inside the document", () => {
    const text = renderProtocolJsonSchema();
    const defs = protocolJsonSchema().$defs as Record<string, unknown>;
    for (const [, ref] of text.matchAll(/"\$ref": "([^"]+)"/g)) {
      expect(ref).toMatch(/^#\/\$defs\//);
      expect(ref!.slice("#/$defs/".length) in defs, `${ref} does not resolve`).toBe(true);
    }
  });

  it("never forbids unknown fields, so readers built from it stay forward compatible", () => {
    expect(renderProtocolJsonSchema()).not.toContain('"additionalProperties": false');
  });
});

describe("protocol fixtures", () => {
  it("has a valid example of every type", () => {
    const covered = new Set(fixtures("valid").map((fixture) => fixture.type));
    const missing = Object.keys(PROTOCOL_SCHEMAS).filter((type) => !covered.has(type as ProtocolTypeName));
    expect(missing).toEqual([]);
  });

  for (const fixture of fixtures("valid")) {
    it(`accepts valid/${fixture.file}`, () => {
      const parsed = PROTOCOL_SCHEMAS[fixture.type].safeParse(fixture.value);
      expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    });
  }

  for (const fixture of fixtures("invalid")) {
    it(`refuses invalid/${fixture.file}`, () => {
      expect(PROTOCOL_SCHEMAS[fixture.type].safeParse(fixture.value).success).toBe(false);
    });
  }
});
