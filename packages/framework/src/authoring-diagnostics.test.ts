import { describe, expect, it } from "vitest";
import { renderErrorOrigin, trimTrailingSlashes } from "./authoring-diagnostics.js";

describe("trimTrailingSlashes", () => {
  it.each([
    ["/a/b///", "/a/b"],
    ["/a/b", "/a/b"],
    ["///", ""],
    ["", ""],
    ["a//b", "a//b"],
  ])("trims %j to %j", (input, output) => {
    expect(trimTrailingSlashes(input)).toBe(output);
  });

  it("stays linear on a long run of slashes that does not end the text", () => {
    const long = `/${"/".repeat(200_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(long)).toBe(long);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("renderErrorOrigin", () => {
  it("places a throw in the project's source under a root with trailing slashes", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at Skill (/work/project/src/agent/skill.tsx:3:9)";
    expect(renderErrorOrigin(error, "/work/project///")).toMatchObject({ file: "src/agent/skill.tsx", line: 3, column: 9 });
  });

  it("answers quickly for a project root of many slashes", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at Skill (/elsewhere/skill.tsx:1:1)";
    const started = performance.now();
    renderErrorOrigin(error, `/${"/".repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
