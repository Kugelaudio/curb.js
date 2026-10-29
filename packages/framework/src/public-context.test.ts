import { describe, expect, it } from "vitest";
import { listPublicMarkdown, resolvePublicMarkdown } from "./public-context.js";

describe("context markdown", () => {
  it("loads markdown by context src path", () => {
    const content = resolvePublicMarkdown("policy/coverage-basics");
    expect(content).toContain("Property damage");
    expect(content).toContain("Liability");
  });

  it("throws for missing markdown files", () => {
    expect(() => resolvePublicMarkdown("missing/file.md")).toThrow(/not found/i);
  });
});
