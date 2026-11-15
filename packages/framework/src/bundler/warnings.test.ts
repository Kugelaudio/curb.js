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

  it("keeps an unknown missing dependency loud", () => {
    expect(classifyWarning('Failed to resolve dependency "agent-runtime-missing":')).toBe(
      "unclassified",
    );
  });
});
