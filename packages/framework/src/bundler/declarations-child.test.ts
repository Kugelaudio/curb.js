import { describe, expect, it } from "vitest";
import { isBareSpecifier, namedImportsOf } from "./declarations-child.js";

/**
 * What the declarations child stubs, and which names an ES module stub has to export. The
 * child itself runs in a real process: declarations.test.ts and layered-build.test.ts.
 */

describe("isBareSpecifier", () => {
  it("is a package name, scoped or not, with or without a subpath", () => {
    for (const specifier of ["sharp", "@livekit/rtc-ffi-bindings", "onnxruntime-node/dist/index.js", "curb"]) {
      expect(isBareSpecifier(specifier), specifier).toBe(true);
    }
  });

  it("is never a file, a URL, a builtin or a package's own #imports entry", () => {
    for (const specifier of ["./tools.js", "../../index.js", "/abs/agent.tsx", "file:///x.js", "node:fs", "#internal", "data:text/javascript,"]) {
      expect(isBareSpecifier(specifier), specifier).toBe(false);
    }
  });
});

describe("namedImportsOf", () => {
  it("reads the names imported and re-exported from one specifier, in every spelling", () => {
    const source = [
      'import sharp, { Sharp, type SharpOptions, format as imageFormat } from "sharp";',
      "import {FfiClient,FfiHandle}from'@livekit/rtc-ffi-bindings';",
      'import type { Ignored } from "sharp";',
      'export { cache, default as named } from "sharp";',
      "import {",
      "  multiline,",
      '} from "sharp";',
      'import * as everything from "sharp";',
      'import { other } from "sharp-extra";',
    ].join("\n");
    expect(namedImportsOf(source, "sharp")).toEqual(["Ignored", "Sharp", "cache", "format", "multiline"]);
    expect(namedImportsOf(source, "@livekit/rtc-ffi-bindings")).toEqual(["FfiClient", "FfiHandle"]);
    expect(namedImportsOf(source, "not-imported")).toEqual([]);
  });
});
