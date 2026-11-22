import { describe, expect, it } from "vitest";
import { onOneLine } from "./results.js";

describe("onOneLine", () => {
  it("turns each line break, with the spaces around it, into one space", () => {
    const before = (text: string) => text.replace(/\s*\n\s*/g, " ");
    for (const text of ["one line", "a\nb", "a \n b", "a\n\n\nb", "a \n \n b", "\na", " \n a", "a\n", "a \n ", "\n", "a\tb\n\tc", "", "  keep  inner  spaces  "]) {
      expect(onOneLine(text)).toBe(before(text));
    }
  });

  it("stays quick on text that holds very many spaces in a row", () => {
    const text = `${" ".repeat(200_000)}x\n${" ".repeat(200_000)}`;
    const started = performance.now();
    expect(onOneLine(text)).toBe(`${" ".repeat(200_000)}x `);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
