import { describe, expect, it } from "vitest";
import { continuesHeardLine, joinHeardLine } from "./heard-line.js";

describe("a caller's line, heard in parts", () => {
  it("adds the next words after a space, punctuation without one", () => {
    expect(joinHeardLine("My number is P", "1234")).toBe("My number is P 1234");
    expect(joinHeardLine("My number is P 1234", ".")).toBe("My number is P 1234.");
  });

  it("keeps the line when a part only repeats its end", () => {
    expect(joinHeardLine("My number is P 1234.", "1234.")).toBe("My number is P 1234.");
    expect(joinHeardLine("My number is ten", "en")).toBe("My number is ten en");
  });

  it("takes the grown line when a part is the whole line so far and more, however it is punctuated", () => {
    expect(joinHeardLine("A table for four.", "A table for four at eight")).toBe("A table for four at eight");
    expect(joinHeardLine("No", "Nothing else")).toBe("No Nothing else");
  });

  it("says which parts continue a line however long the pause before them", () => {
    expect(continuesHeardLine("A table for four", "a table for four at")).toBe(true);
    expect(continuesHeardLine("A table for four", "for four")).toBe(true);
    expect(continuesHeardLine("A table for four", "at eight")).toBe(false);
    expect(continuesHeardLine("No", "Nothing else")).toBe(false);
    expect(continuesHeardLine("", "Hello")).toBe(false);
  });
});
