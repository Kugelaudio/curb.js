import { describe, expect, it } from "vitest";
import { entryFor, markRequired, parseLockfile, placement, prune, resolveFrom, serializeLockfile, type Lockfile } from "./lockfile.js";

function lock(packages: Lockfile["packages"]): Lockfile {
  return { name: "p", lockfileVersion: 3, requires: true, packages: { "": { name: "p", dependencies: { a: "^1.0.0" } }, ...packages } };
}

describe("lockfile placement, as npm resolves", () => {
  const tree = lock({
    "node_modules/a": { version: "1.2.0", dependencies: { ms: "^2.0.0" } },
    "node_modules/ms": { version: "2.1.3" },
    "node_modules/a/node_modules/debug": { version: "2.6.9" },
    "node_modules/debug": { version: "4.4.3" },
  });

  it("resolves at the nearest node_modules walking up from the dependent", () => {
    expect(resolveFrom(tree, "node_modules/a", "debug")).toBe("node_modules/a/node_modules/debug");
    expect(resolveFrom(tree, "", "debug")).toBe("node_modules/debug");
    expect(resolveFrom(tree, "node_modules/a", "ms")).toBe("node_modules/ms");
    expect(resolveFrom(tree, "node_modules/a", "zod")).toBeNull();
  });

  it("reuses a satisfying copy, nests a conflicting one under the dependent, and roots a new name", () => {
    expect(placement(tree, "node_modules/a", "ms", "^2.1.0")).toEqual({ reuse: "node_modules/ms" });
    expect(placement(tree, "node_modules/a", "debug", "^4.0.0")).toEqual({ place: "node_modules/a/node_modules/debug" });
    expect(placement(tree, "node_modules/x", "debug", "^2.6.0")).toEqual({ place: "node_modules/x/node_modules/debug" });
    expect(placement(tree, "node_modules/x", "zod", "^4.0.0")).toEqual({ place: "node_modules/zod" });
  });

  it("does not take a dist-tag range as satisfied by a version", () => {
    expect(placement(tree, "", "ms", "latest")).toEqual({ place: "node_modules/ms" });
  });
});

describe("lockfile flags and pruning", () => {
  it("clears dev and optional on a package production code now needs, and on what it depends on", () => {
    const tree = lock({
      "node_modules/a": { version: "1.0.0" },
      "node_modules/tool": { version: "1.0.0", dev: true, dependencies: { helper: "^1.0.0" } },
      "node_modules/helper": { version: "1.0.0", dev: true },
    });
    markRequired(tree, "node_modules/tool");
    expect(tree.packages["node_modules/tool"]!.dev).toBeUndefined();
    expect(tree.packages["node_modules/helper"]!.dev).toBeUndefined();
  });

  it("drops what no root dependency reaches, keeping dev, peer and nested dependencies", () => {
    const tree = lock({
      "node_modules/a": { version: "1.0.0", dependencies: { b: "^1.0.0" }, peerDependencies: { c: "^1.0.0" } },
      "node_modules/a/node_modules/b": { version: "1.0.0" },
      "node_modules/c": { version: "1.0.0" },
      "node_modules/gone": { version: "1.0.0", dependencies: { "gone-dep": "^1.0.0" } },
      "node_modules/gone-dep": { version: "1.0.0" },
    });
    expect(prune(tree).sort()).toEqual(["node_modules/gone", "node_modules/gone-dep"]);
    expect(Object.keys(tree.packages)).toContain("node_modules/a/node_modules/b");
  });
});

describe("lockfile entries and text", () => {
  it("keeps the manifest fields npm writes and drops empty ones", () => {
    const entry = entryFor({
      name: "x",
      version: "1.0.0",
      dist: { tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz", integrity: "sha512-abc" },
      dependencies: { y: "^1.0.0" },
      optionalDependencies: {},
      engines: { node: ">=18" },
    });
    expect(entry).toEqual({
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
      integrity: "sha512-abc",
      dependencies: { y: "^1.0.0" },
      engines: { node: ">=18" },
    });
  });

  it("round-trips with the root first and refuses a version 1 lockfile", () => {
    const text = serializeLockfile(lock({ "node_modules/z": { version: "1.0.0" }, "node_modules/a": { version: "1.0.0" } }));
    expect(Object.keys(parseLockfile(text).packages)).toEqual(["", "node_modules/a", "node_modules/z"]);
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow(/version 1/);
  });
});
