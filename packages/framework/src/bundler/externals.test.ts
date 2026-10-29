import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeExternals, externalPackages, NATIVE_PACKAGES, UNUSED_OPTIONAL_PEERS } from "./externals.js";
import { resolveDependencyDir } from "./dependency-mirror.js";

/**
 * `manifest.externals` is the one place the bundle states which version of an unbundlable
 * package it shipped, and the artifact store refuses a publication whose external has no
 * version -- an unpinned external makes the artifact non-reproducible.
 *
 * The two properties worth a test are the two that were wrong before it existed: the
 * version has to come from the bytes rather than from a declared range, and `native` has
 * to be derived rather than assumed from the hand-maintained list.
 */

let root: string;

/** Write a package into a node_modules tree, with optional extra files. */
const writePackage = (
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "curb-externals-"));

  // A package that carries its own compiled addon.
  writePackage(join(root, "node_modules", "with-addon"), { name: "with-addon", version: "3.1.4" }, {
    "build/Release/binding.node": "not really a binary",
  });

  // The shape that made a per-package scan wrong: the bridge holds no `.node` of its own
  // and reaches its prebuild through an optional, platform-gated sibling.
  writePackage(
    join(root, "node_modules", "bridge"),
    { name: "bridge", version: "0.13.31", optionalDependencies: { "bridge-darwin-arm64": "0.13.31" } },
    { "dist/index.js": "module.exports = require('bridge-darwin-arm64');" },
  );
  writePackage(
    join(root, "node_modules", "bridge-darwin-arm64"),
    { name: "bridge-darwin-arm64", version: "0.13.31", os: ["darwin"], cpu: ["arm64"] },
    { "bridge.darwin-arm64.node": "not really a binary either" },
  );

  // Pure JavaScript, all the way down.
  writePackage(
    join(root, "node_modules", "portable"),
    { name: "portable", version: "12.0.0", dependencies: { bridge: "*" } },
    { "index.js": "module.exports = 1;" },
  );
  // ...except this one depends on the bridge, so its closure IS target-pinned.

  writePackage(
    join(root, "node_modules", "leaf"),
    { name: "leaf", version: "1.2.3" },
    { "index.js": "module.exports = 1;" },
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const describeIn = (names: string[]) =>
  describeExternals(names, {
    resolve: (name) => resolveDependencyDir(root, root, name),
    root,
    describe: "the fixture tree",
  });

describe("NATIVE_PACKAGES", () => {
  it("externalizes only packages whose runtime bytes cannot be bundled", () => {
    expect(NATIVE_PACKAGES).toEqual([
      "onnxruntime-node",
      "sharp",
      "@livekit/rtc-ffi-bindings",
    ]);
  });
});

describe("describeExternals", () => {
  it("reads the version from the resolved package, not from a range", async () => {
    // The dependent declares `bridge: "*"`. A manifest built from ranges would say "*".
    expect(await describeIn(["bridge"])).toEqual([
      { specifier: "bridge", version: "0.13.31", native: true },
    ]);
  });

  it("derives native from a compiled addon in the package's own files", async () => {
    expect(await describeIn(["with-addon"])).toEqual([
      { specifier: "with-addon", version: "3.1.4", native: true },
    ]);
  });

  it("derives native through the closure, not just the package itself", async () => {
    // `portable` ships nothing but JavaScript; it is still target-pinned, because what it
    // resolves is not.
    expect(await describeIn(["portable"])).toEqual([
      { specifier: "portable", version: "12.0.0", native: true },
    ]);
  });

  it("reports a package with no addon anywhere as not native", async () => {
    expect(await describeIn(["leaf"])).toEqual([
      { specifier: "leaf", version: "1.2.3", native: false },
    ]);
  });

  it("throws rather than emitting an external it cannot pin", async () => {
    await expect(describeIn(["never-installed"])).rejects.toThrow(/not resolvable/);
  });
});

describe("UNUSED_OPTIONAL_PEERS", () => {
  // @livekit/agents 1.9.4 imports this optional peer lazily; bundling it failed `curb build`
  // on every fresh install (curb.build run 40091945346, 2026-10-24).
  it("lets a dependency's lazy import of an absent optional peer, subpaths included, build", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      stdin: {
        contents: [
          'export const client = () => import("@modelcontextprotocol/client");',
          'export const stdio = () => import("@modelcontextprotocol/client/stdio");',
        ].join("\n"),
        resolveDir: tmpdir(),
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
      external: externalPackages(),
    });
    const out = result.outputFiles[0]!.text;
    expect(out).toContain('import("@modelcontextprotocol/client")');
    expect(out).toContain('import("@modelcontextprotocol/client/stdio")');
  });

  it("never names them in manifest.externals: the artifact does not resolve them", () => {
    expect(UNUSED_OPTIONAL_PEERS).toEqual(["@modelcontextprotocol/client"]);
    expect(NATIVE_PACKAGES).not.toContain("@modelcontextprotocol/client");
  });
});
