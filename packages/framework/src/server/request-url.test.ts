import { describe, expect, it } from "vitest";
import { parseUrlOrNull } from "./request-url.js";

describe("parseUrlOrNull", () => {
  it("parses an ordinary target", () => {
    const url = parseUrlOrNull("/v1/runner?from=3", "http://curb.local");
    expect(url?.pathname).toBe("/v1/runner");
    expect(url?.searchParams.get("from")).toBe("3");
  });

  it("treats an absent target as the base's root", () => {
    expect(parseUrlOrNull(undefined, "http://curb.local")?.pathname).toBe("/");
  });

  it("answers null for a target new URL refuses", () => {
    expect(parseUrlOrNull("http://[", "http://curb.local")).toBeNull();
  });

  it("answers null when the base itself is broken", () => {
    expect(parseUrlOrNull("/", "http://[")).toBeNull();
  });
});
