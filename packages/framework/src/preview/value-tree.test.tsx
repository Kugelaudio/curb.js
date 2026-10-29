import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { argumentEntries, resultValue, treeRows, ValueTree } from "./value-tree.js";

describe("a value as a key/value tree", () => {
  it("indents nested values under their key and numbers list items from 1", () => {
    expect(treeRows({ slots: ["10:00", "14:30"], date: "2026-10-27" })).toEqual([
      { depth: 0, key: "slots", value: "" },
      { depth: 1, key: "1", value: "10:00" },
      { depth: 1, key: "2", value: "14:30" },
      { depth: 0, key: "date", value: "2026-10-27" },
    ]);
  });

  it("shows a scalar as one row and says when a branch is empty", () => {
    expect(treeRows("Booked.")).toEqual([{ depth: 0, value: "Booked." }]);
    expect(treeRows({ items: [], filters: {} })).toEqual([
      { depth: 0, key: "items", value: "none" },
      { depth: 0, key: "filters", value: "empty" },
    ]);
  });

  it("summarises a huge result instead of rendering every row", () => {
    const rows = treeRows(Array.from({ length: 400 }, (_, index) => index));
    expect(rows).toHaveLength(301);
    expect(rows.at(-1)).toEqual({ depth: 0, value: "and 100 more" });
  });

  it("shows a result's data and message, never its ok flag", () => {
    expect(resultValue({ ok: true, data: { id: 7 } })).toEqual({ id: 7 });
    expect(resultValue({ ok: true, message: "Booked." })).toBe("Booked.");
    expect(resultValue({ ok: true, message: "Booked.", data: { id: 7 } })).toEqual({ message: "Booked.", data: { id: 7 } });
  });

  it("puts a call's first arguments beside its name, as text", () => {
    expect(argumentEntries({ date: "2026-10-27", count: 3, extra: true })).toEqual([
      ["date", "2026-10-27"],
      ["count", "3"],
    ]);
  });

  it("renders keys and values without a monospace font", () => {
    const html = renderToStaticMarkup(<ValueTree value={{ id: "abc-123" }} />);
    expect(html).toContain("abc-123");
    expect(html).not.toMatch(/mono|<code/);
  });
});
