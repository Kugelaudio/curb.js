import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { experimentDeclarations, type AgentExperiment } from "./experiments.js";
import { assignExperiments, assignVariant, drawnVariant, forcedVariant } from "./experiments.node.js";

/**
 * The assignment rule, against the golden vectors the hosting platform's Go implementation tests
 * too. A vector that changes here changes which variant every hosted call gets.
 */

/** One experiment as the manifest carries it (variants sorted by name). */
const declared = (name: string, experiment: AgentExperiment) => experimentDeclarations({ [name]: experiment })[0]!;

const greeting = declared("greeting", { variants: { formal: 1, casual: 1 }, fromClient: "greeting" });

describe("the golden vectors", () => {
  it("reads h as the first 8 bytes of SHA-256(<sessionId>:<experiment>), big-endian", () => {
    const h = createHash("sha256").update("sess_golden:greeting").digest().readBigUInt64BE(0);
    expect(h).toBe(12342085365064989228n);
  });

  it("sess_golden, greeting, casual:1 formal:1 -> casual", () => {
    expect(assignVariant("sess_golden", greeting)).toBe("casual");
  });

  it("sess_golden, greeting, a:1 b:2 c:7 -> c", () => {
    expect(assignVariant("sess_golden", declared("greeting", { variants: { a: 1, b: 2, c: 7 } }))).toBe("c");
  });

  it("sess_other, greeting, casual:1 formal:1 -> formal", () => {
    expect(assignVariant("sess_other", greeting)).toBe("formal");
  });

  it("forced: client context { greeting: formal } with fromClient greeting on sess_golden -> formal", () => {
    expect(assignVariant("sess_golden", greeting, { greeting: "formal" })).toBe("formal");
  });

  it("a client value naming no variant ({ greeting: loud }) falls back to the hash rule", () => {
    expect(assignVariant("sess_golden", greeting, { greeting: "loud" })).toBe("casual");
  });
});

describe("assignVariant", () => {
  it("walks the variants in manifest order, whatever order the agent wrote them in", () => {
    const written = declared("greeting", { variants: { c: 7, a: 1, b: 2 } });
    expect(written.variants.map((variant) => variant.name)).toEqual(["a", "b", "c"]);
    expect(drawnVariant("sess_golden", written)).toBe("c");
  });

  it("forces only through the experiment's own fromClient key", () => {
    const unforced = declared("greeting", { variants: { formal: 1, casual: 1 } });
    expect(forcedVariant(unforced, { greeting: "formal" })).toBeUndefined();
    expect(forcedVariant(greeting, { other: "formal" })).toBeUndefined();
    expect(forcedVariant(greeting, { greeting: undefined })).toBeUndefined();
    expect(forcedVariant(declared("x", { variants: { a: 1, b: 1 }, fromClient: "constructor" }), {})).toBeUndefined();
  });

  it("draws every variant in proportion to its weight", () => {
    const experiment = declared("split", { variants: { rare: 1, common: 3 } });
    const counts = { rare: 0, common: 0 };
    for (let index = 0; index < 4000; index += 1) {
      counts[drawnVariant(`sess_${index}`, experiment) as keyof typeof counts] += 1;
    }
    // 1000 expected for rare; four standard deviations is about 110.
    expect(counts.rare).toBeGreaterThan(890);
    expect(counts.rare).toBeLessThan(1110);
    expect(counts.rare + counts.common).toBe(4000);
  });

  it("is the same for the same session and independent across experiments", () => {
    const pacing = declared("pacing", { variants: { slow: 1, fast: 1 } });
    expect(assignExperiments([greeting, pacing], "sess_golden")).toEqual({
      greeting: "casual",
      pacing: drawnVariant("sess_golden", pacing),
    });
    expect(assignExperiments([greeting, pacing], "sess_golden", { greeting: "formal" })).toMatchObject({
      greeting: "formal",
    });
    expect(assignExperiments([], "sess_golden")).toEqual({});
  });
});
