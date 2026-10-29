import { describe, expect, it } from "vitest";
import { classifyWarning } from "./warnings.js";

describe("classifyWarning", () => {
  it.each([
    '@img/sharp-libvips-dev/include',
    '@img/sharp-libvips-dev/cplusplus',
    '@img/sharp-libvips-\u001a/package',
  ])("recognizes sharp's build-only dynamic path %j", (dependency) => {
    expect(classifyWarning(`Failed to resolve dependency "${dependency}":`)).toBe(
      "sharp-build-probe",
    );
  });

  it.each([
    "@img/sharp-linuxmusl-arm64/sharp.node",
    "@img/sharp-linuxmusl-x64/sharp.node",
  ])("recognizes sharp's non-host musl binding %s", (dependency) => {
    expect(classifyWarning(`Failed to resolve dependency "${dependency}":`)).toBe(
      "platform-variant",
    );
  });

  it.each(["onnxruntime-node", "undici"])(
    "counts %s, which the build seeds from the framework, as a declared external",
    (dependency) => {
      expect(classifyWarning(`Failed to resolve dependency "${dependency}":`)).toBe(
        "declared-external",
      );
    },
  );

  // The three a fresh scaffold's `curb build` printed as UNRECOGNISED (onboarding sweep,
  // 2026-10-25): @livekit/agents' lazy MCP-client imports, external and never called.
  it.each([
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/client/validators/ajv",
    "@modelcontextprotocol/client/stdio",
  ])("counts %s, an optional peer Curb never loads, as benign", (dependency) => {
    expect(classifyWarning(`Failed to resolve dependency "${dependency}":`)).toBe(
      "unused-optional-peer",
    );
  });

  it("does not take a package that only shares the peer's name prefix for it", () => {
    expect(classifyWarning('Failed to resolve dependency "@modelcontextprotocol/client-extra":')).toBe(
      "unclassified",
    );
  });

  it("keeps an unknown missing dependency loud", () => {
    expect(classifyWarning('Failed to resolve dependency "agent-runtime-missing":')).toBe(
      "unclassified",
    );
  });
});
