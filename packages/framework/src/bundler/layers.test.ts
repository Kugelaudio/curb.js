import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BundleFile } from "./bundle-digest.js";
import {
  isAppLayerPath,
  mergeDependencyLayerFiles,
  readDependencyLayerDescriptor,
} from "./layers.js";

/**
 * The pure pieces of the layer split: the L2 app path set, the trace-provenance check that
 * keeps agent code out of the dependency layer, the hit-mode file merge and the descriptor
 * reader. The builds themselves are exercised in layered-build.test.ts.
 */

const home = "node_modules/curb";
const layout = { entryHome: home, projectHome: "" };

describe("the app path set (L2)", () => {
  it("is the manifest, assets/**, mcp.servers.json and the emitted entry", () => {
    for (const path of [
      "curb.bundle.json",
      "assets/context/policy.md",
      "assets/agent-source/agent.tsx",
      "mcp.servers.json",
      `${home}/entry/worker.mjs`,
    ]) {
      expect(isAppLayerPath(path, layout), path).toBe(true);
    }
  });

  it("is nothing else, including look-alikes deeper in the tree", () => {
    for (const path of [
      `${home}/entry/other.mjs`,
      `${home}/package.json`,
      "node_modules/x/curb.bundle.json",
      "node_modules/x/assets/a.md",
      "node_modules/x/mcp.servers.json",
      "entry/worker.mjs",
    ]) {
      expect(isAppLayerPath(path, layout), path).toBe(false);
    }
  });

  it("places mcp.servers.json at the project's own position when the project is not the trace base", () => {
    const workspace = { entryHome: "packages/framework", projectHome: "examples/agent" };
    expect(isAppLayerPath("examples/agent/mcp.servers.json", workspace)).toBe(true);
    expect(isAppLayerPath("mcp.servers.json", workspace)).toBe(false);
  });
});

describe("mergeDependencyLayerFiles", () => {
  const file = (path: string): BundleFile => ({
    path,
    digest: `sha256:${"0".repeat(64)}`,
    size: 1,
    mode: "644",
  });

  it("returns the byte-sorted union of the app tree and the descriptor's files", () => {
    const merged = mergeDependencyLayerFiles(
      [file("assets/a.md"), file("mcp.servers.json"), file(`${home}/entry/worker.mjs`)],
      [file("node_modules/z/index.js"), file("node_modules/a/index.js")],
      layout,
    );
    expect(merged.map((entry) => entry.path)).toEqual([
      "assets/a.md",
      "mcp.servers.json",
      "node_modules/a/index.js",
      `${home}/entry/worker.mjs`,
      "node_modules/z/index.js",
    ]);
  });

  it("refuses a descriptor that claims an app path", () => {
    expect(() =>
      mergeDependencyLayerFiles([file("assets/a.md")], [file(`${home}/entry/worker.mjs`)], layout),
    ).toThrow(/app layer/);
    expect(() => mergeDependencyLayerFiles([], [file("mcp.servers.json")], layout)).toThrow(/app layer/);
  });

  it("refuses duplicate descriptor entries", () => {
    expect(() =>
      mergeDependencyLayerFiles([], [file("node_modules/a/index.js"), file("node_modules/a/index.js")], layout),
    ).toThrow(/twice/);
  });

  it("refuses a hit-mode tree holding a file outside the app path set", () => {
    expect(() => mergeDependencyLayerFiles([file("node_modules/a/index.js")], [], layout)).toThrow(
      /outside the app layer/,
    );
  });
});

describe("readDependencyLayerDescriptor", () => {
  const dir = mkdtempSync(join(tmpdir(), "curb-descriptor-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const valid = () => ({
    format: 1,
    key: "ab",
    files: [{ mode: "644", size: 3, digest: `sha256:${"a".repeat(64)}`, path: "node_modules/a/index.js" }],
    externals: [{ native: true, version: "1.5.2", specifier: "@livekit/agents" }],
    buildInputs: {
      format: 1,
      inputs: ["node_modules/a/index.js"],
      edges: [{ importer: "src/agent/agent.tsx", specifier: "a", kind: "import-statement", resolved: "node_modules/a/index.js" }],
      recordedExternals: ["@livekit/agents"],
    },
  });
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it("reads files and externals in the manifest's own key order, whatever order the writer used", async () => {
    const descriptor = await readDependencyLayerDescriptor(write("ok.json", valid()));
    expect(JSON.stringify(descriptor.files)).toBe(
      `[{"path":"node_modules/a/index.js","digest":"sha256:${"a".repeat(64)}","size":3,"mode":"644"}]`,
    );
    expect(JSON.stringify(descriptor.externals)).toBe(
      '[{"specifier":"@livekit/agents","version":"1.5.2","native":true}]',
    );
    expect(descriptor.buildInputs.recordedExternals).toEqual(["@livekit/agents"]);
  });

  it.each([
    ["an unknown format", (d: ReturnType<typeof valid>) => ({ ...d, format: 2 })],
    ["no externals", (d: ReturnType<typeof valid>) => ({ ...d, externals: undefined })],
    ["a malformed file digest", (d: ReturnType<typeof valid>) => ({ ...d, files: [{ ...d.files[0], digest: "abc" }] })],
    ["a non-boolean native flag", (d: ReturnType<typeof valid>) => ({ ...d, externals: [{ ...d.externals[0], native: "yes" }] })],
    ["build inputs without edges", (d: ReturnType<typeof valid>) => ({ ...d, buildInputs: { ...d.buildInputs, edges: undefined } })],
  ])("rejects a descriptor with %s", async (name, mutate) => {
    const path = write(`${name.replace(/\W+/g, "-")}.json`, mutate(valid()));
    await expect(readDependencyLayerDescriptor(path)).rejects.toThrow(/dependency layer descriptor/);
  });
});
