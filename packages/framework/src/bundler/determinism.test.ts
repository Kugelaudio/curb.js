import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCurbBuild } from "./index.js";
import { projectContextFiles } from "./context-registry.js";

/**
 * Reproducibility, as a test: the same revision, framework version, and target produce
 * the same treeDigest.
 *
 * It is the property that degrades silently. Nothing about a bundle that carries a build
 * timestamp or a host path looks wrong; it starts, it serves calls, and it quietly stops
 * being a function of the revision -- so the artifact store cannot deduplicate it, the
 * build module cannot tell whether it already built this revision, and rollback has no
 * stable key for "the artifact that worked". The only way to see it is to build twice and
 * compare, which is what this does.
 *
 * The two builds go to DIFFERENT output directories on purpose: an output path that
 * reached the digest would make artifact identity depend on where the builder happened to
 * put the tree.
 *
 * Trace and verify are skipped. They copy ~600 MB of unchanged third-party bytes and start
 * a worker; what this asserts is the determinism of the bytes THIS builder produces, and
 * those are the emitted entries and the assets tree.
 */

const fixtureProject = resolve(import.meta.dirname, "..", "test-fixtures", "project");

let root: string;
let first: Awaited<ReturnType<typeof runCurbBuild>>;
let second: Awaited<ReturnType<typeof runCurbBuild>>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "curb-determinism-"));
  first = await runCurbBuild({
    projectRoot: fixtureProject,
    outDir: join(root, "a"),
    skipTrace: true,
    skipVerify: true,
  });
  second = await runCurbBuild({
    projectRoot: fixtureProject,
    outDir: join(root, "b"),
    skipTrace: true,
    skipVerify: true,
  });
}, 240_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "curb.bundle.json"), "utf8")) as {
    treeDigest: string;
    reproducible: boolean;
    entrypoint: string;
    files: Array<{ path: string; digest: string; size: number; mode: string }>;
    assets: Array<{ path: string; kind: string }>;
  };

describe("curb build is content-addressed", () => {
  it("produces the same treeDigest from two builds of one revision", () => {
    expect(first.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.treeDigest).toBe(first.treeDigest);
    expect(manifestOf(first.outDir).treeDigest).toBe(first.treeDigest);
  });

  it("produces byte-identical file lists, so a differing digest names its own cause", () => {
    // Compared as a list rather than only through the digest: when this fails, the
    // failing entry IS the nondeterministic file, which is the thing worth knowing.
    expect(manifestOf(second.outDir).files).toEqual(manifestOf(first.outDir).files);
  });

  it("lists every bundle file except the manifest itself", () => {
    const manifest = manifestOf(first.outDir);
    expect(manifest.files.length).toBe(first.manifestFiles);
    expect(manifest.files.some((f) => f.path === "curb.bundle.json")).toBe(false);
    // Sorted, non-empty, root-relative POSIX paths with no "./" prefix.
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const entry of manifest.files) {
      expect(entry.path).not.toMatch(/^[./]|\\|^\/|\/$/);
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.size).toBeGreaterThanOrEqual(0);
    }
    expect([...manifest.files].map((f) => f.path).sort()).toEqual(manifest.files.map((f) => f.path));
  });

  it("names the entrypoint among its own files", () => {
    const manifest = manifestOf(first.outDir);
    expect(manifest.files.some((f) => f.path === manifest.entrypoint)).toBe(true);
  });

  it("stamps no build-machine path into the emitted entries", () => {
    // The reason `reproducible` was false. Asserted on the output as well as inside the
    // build, so a regression fails a test rather than only a build on someone's laptop.
    // The entry directory is a function of the REPOSITORY LAYOUT — `entryHome` in index.ts
    // is the framework root relative to the trace base — so hardcoding it here made this
    // test fail the day the repo was restructured, against a build that was correct. The
    // manifest already names the runnable entry; ask it instead of restating the layout.
    const entryDir = dirname(join(first.outDir, manifestOf(first.outDir).entrypoint));
    for (const name of ["worker.mjs", "hosted.mjs"]) {
      const emitted = readFileSync(join(entryDir, name), "utf8");
      expect(emitted).not.toContain(fixtureProject);
      expect(emitted).not.toContain(resolve(fixtureProject, "..", "..", ".."));
    }
  });
});

describe("the bundle's assets tree", () => {
  it("carries the project's context markdown byte-identically", () => {
    const declared = projectContextFiles(fixtureProject);
    expect(declared.length).toBeGreaterThan(0);
    for (const src of declared) {
      expect(readFileSync(join(first.outDir, "assets", "context", src))).toEqual(
        readFileSync(join(fixtureProject, "context", src)),
      );
    }
  });

  it("carries the agent and every skill as source text", () => {
    const assets = manifestOf(first.outDir).assets.filter((a) => a.kind === "agent-source");
    expect(assets.some((a) => a.path === "assets/agent-source/agent.tsx")).toBe(true);
    expect(assets.length).toBeGreaterThan(1);
    for (const asset of assets) {
      const relativePath = asset.path.slice("assets/agent-source/".length);
      expect(readFileSync(join(first.outDir, asset.path))).toEqual(
        readFileSync(join(fixtureProject, "src", "agent", relativePath)),
      );
    }
  });

  it("lists every asset in files[] too, as the manifest invariant requires", () => {
    const manifest = manifestOf(first.outDir);
    const listed = new Set(manifest.files.map((f) => f.path));
    expect(manifest.assets.length).toBeGreaterThan(0);
    for (const asset of manifest.assets) expect(listed.has(asset.path)).toBe(true);
  });
});
