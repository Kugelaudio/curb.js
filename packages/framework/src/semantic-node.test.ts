import { describe, expect, it } from "vitest";
import { dedentProse } from "./semantic-node.js";

describe("dedentProse", () => {
  it("keeps paragraphs, headings and lists of an indented template literal", () => {
    const prose = `
      Model X7 is a modular outdoor sensor system.

      ## Rules
      - one
        - nested under one
      - two
    `;

    expect(dedentProse(prose)).toBe(
      [
        "Model X7 is a modular outdoor sensor system.",
        "",
        "## Rules",
        "- one",
        "  - nested under one",
        "- two",
      ].join("\n"),
    );
  });

  it("does not count the first line, which starts right after the backtick", () => {
    const prose = `Answer in German.
      ## Tone
      Friendly, short.
    `;

    expect(dedentProse(prose)).toBe("Answer in German.\n## Tone\nFriendly, short.");
  });

  it("empties whitespace-only lines and drops trailing spaces", () => {
    expect(dedentProse("\n    first  \n        \n    second\n  ")).toBe("first\n\nsecond");
  });

  it("removes only the indentation every line shares, tabs included", () => {
    expect(dedentProse("\n\t\tparent\n\t\t\tchild\n\t")).toBe("parent\n\tchild");
  });

  it("leaves an unindented multi-line string as it is", () => {
    const rules = ["Rule one.", "Rule two.", "", "Rule three."].join("\n");
    expect(dedentProse(rules)).toBe(rules);
  });

  it("only trims a one-line string, exactly as before", () => {
    expect(dedentProse("  Help the user.  ")).toBe("Help the user.");
    expect(dedentProse("   ")).toBe("");
  });
});
