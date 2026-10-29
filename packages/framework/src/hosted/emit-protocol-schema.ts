import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderProtocolJsonSchema } from "./protocol.js";

/**
 * Regenerates `protocol.schema.json` from the Zod schemas in `protocol.ts`.
 *
 *   npx tsx src/hosted/emit-protocol-schema.ts
 *
 * The protocol test fails while the committed file differs from what this writes.
 */
const target = fileURLToPath(new URL("./protocol.schema.json", import.meta.url));
writeFileSync(target, renderProtocolJsonSchema());
console.log(`wrote ${target}`);
