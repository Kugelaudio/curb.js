import { describe, expect, it } from "vitest";
import { inlineParts } from "./inline-code.js";

describe("a diagnostic's sentence in the preview", () => {
  it("sets commands and files apart and drops the backticks around them", () => {
    expect(inlineParts("Run `npx curb login` in the project, then restart `curb dev`.")).toEqual([
      { text: "Run ", code: false },
      { text: "npx curb login", code: true },
      { text: " in the project, then restart ", code: false },
      { text: "curb dev", code: true },
      { text: ".", code: false },
    ]);
  });

  it("sets an environment variable apart, and no other upper-case word", () => {
    expect(inlineParts("Or set KUGELAUDIO_API_KEY (an API key).")).toEqual([
      { text: "Or set ", code: false },
      { text: "KUGELAUDIO_API_KEY", code: true },
      { text: " (an API key).", code: false },
    ]);
    expect(inlineParts("Use FIRST for an EXISTING claim.")).toEqual([
      { text: "Use FIRST for an EXISTING claim.", code: false },
    ]);
  });

  it("leaves plain text, and a backtick with no partner, as written", () => {
    expect(inlineParts("Nothing to mark.")).toEqual([{ text: "Nothing to mark.", code: false }]);
    expect(inlineParts("A lone ` stays.")).toEqual([{ text: "A lone ` stays.", code: false }]);
    expect(inlineParts("")).toEqual([]);
  });
});
