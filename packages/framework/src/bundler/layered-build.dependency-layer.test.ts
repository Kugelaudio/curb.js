import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANIFEST_FILENAME, treeDigest } from "./bundle-digest.js";
import { DEV_ONLY_PACKAGES } from "./externals.js";
import { runCurbBuild, type BuildResult } from "./index.js";
import {
  AGENT,
  DECLARED,
  buildInputs,
  createLayeredProject,
  declaredIn,
  emitLayers,
  emitManifestPath,
  emitted,
  frameworkRoot,
  isApp,
  layout,
  listFiles,
  manifest,
  outRoot,
  projectRoot,
  removeLayeredProject,
  runCli,
  sha256,
  toPosix,
  writeTree,
  type Manifest,
} from "./layered-build.fixture.js";

/**
 * Layered `curb build`, end to end over a real project, the hit side: `--dependency-layer`
 * rebuilds the app layer from the `--emit-layers` record alone and must write a manifest
 * byte-identical to the full build's -- or refuse with exit 75. The emit side is
 * layered-build.test.ts; this file makes its own project and emit build so the two run in
 * parallel workers.
 *
 * The in-process hit build prunes the project's OWN node_modules to the recorded inputs;
 * one CLI build runs from a separate tree materialized from exactly the recorded inputs.
 */

/**
 * A module-resolution hook that appends every `@vercel/nft` resolution to $CURB_NFT_PROBE.
 * A real process and a real loader, so "never loads the tracer" does not depend on how a
 * test runner caches mocked modules.
 */
const NFT_PROBE_HOOKS = `import { appendFileSync } from "node:fs";
export async function resolve(specifier, context, next) {
  if (specifier === "@vercel/nft" || specifier.startsWith("@vercel/nft/")) {
    appendFileSync(process.env.CURB_NFT_PROBE, specifier + "\\n");
  }
  return next(specifier, context);
}
`;
const NFT_PROBE_REGISTER = `import { register } from "node:module";
register(new URL("./hooks.mjs", import.meta.url));
`;

beforeAll(async () => {
  createLayeredProject();
  await emitLayers();
}, 600_000);

afterAll(removeLayeredProject);

describe("curb build --dependency-layer", () => {
  let descriptorPath: string;
  let hitOut: string;
  let hit: BuildResult;

  /** Apply an edit to the project, returning the function that undoes it. */
  const edit = (path: string, next: (current: string) => string): (() => void) => {
    const absolute = join(projectRoot, path);
    const before = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, next(before ?? ""));
    return () => (before === undefined ? rmSync(absolute) : writeFileSync(absolute, before));
  };

  it("runs against a project node_modules pruned to the recorded build inputs", () => {
    const descriptor = {
      format: 1,
      files: manifest().files.filter((file) => !isApp(file.path)),
      externals: manifest().externals,
      buildInputs: buildInputs(),
    };
    descriptorPath = join(outRoot, "descriptor.json");
    writeFileSync(descriptorPath, JSON.stringify(descriptor));

    const keep = new Set(descriptor.buildInputs.inputs);
    for (const file of listFiles(join(projectRoot, "node_modules"))) {
      if (!keep.has(toPosix(relative(projectRoot, file)))) rmSync(file);
    }
    expect(existsSync(join(projectRoot, "node_modules/layer-unused/index.js"))).toBe(false);
    expect(existsSync(join(projectRoot, "node_modules/layer-foo/README.md"))).toBe(false);
    expect(existsSync(join(projectRoot, "node_modules/layer-foo/index.js"))).toBe(true);
  });

  it("writes only app-layer files", async () => {
    hitOut = join(outRoot, "hit");
    hit = await runCurbBuild({ projectRoot, outDir: hitOut, dependencyLayer: descriptorPath });
    const written = listFiles(hitOut).map((file) => toPosix(relative(hitOut, file)));
    expect(written).toContain(MANIFEST_FILENAME);
    expect(written).toContain(layout().mcpServers);
    expect(written.filter((path) => !isApp(path))).toEqual([]);
    expect(hit.layers).toEqual({
      mode: "hit",
      dependencyFiles: manifest().files.filter((file) => !isApp(file.path)).length,
      buildInputs: buildInputs().inputs.length,
    });
  }, 180_000);

  it("writes a curb.bundle.json byte-identical to the --emit-layers one", () => {
    expect(readFileSync(join(hitOut, MANIFEST_FILENAME), "utf8")).toBe(readFileSync(emitManifestPath(), "utf8"));
    expect(hit.treeDigest).toBe(emitted.treeDigest);
    // Both carry what the agent declares.
    expect(declaredIn(emitManifestPath())).toEqual(DECLARED);
  });

  it("builds from a tree materialized from EXACTLY the recorded inputs", () => {
    const { traceBase } = layout();
    const inputs = buildInputs().inputs;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "curb-inputs-")));
    const mirror = (absolute: string) => join(root, relative(traceBase, absolute));
    const materializedProject = mirror(projectRoot);
    try {
      for (const input of inputs) {
        const target = resolve(materializedProject, input);
        expect(target.startsWith(root + sep), input).toBe(true);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(resolve(projectRoot, input), target, { dereference: true });
      }
      // The project's own source, which a builder has from the revision, not from the inputs.
      cpSync(projectRoot, materializedProject, {
        recursive: true,
        filter: (source) => {
          const first = relative(projectRoot, source).split(sep)[0];
          return first !== "node_modules" && first !== ".curb";
        },
      });
      // The trace base is the outermost directory that HAS a node_modules. In this workspace
      // that one holds nothing any build reads, so no input creates it; the empty directory
      // is layout, not content, and a hosted build (trace base = project) never needs it.
      if (existsSync(join(traceBase, "node_modules"))) mkdirSync(join(root, "node_modules"), { recursive: true });

      const recorded = new Set(inputs.map((input) => resolve(materializedProject, input)));
      const unrecorded = listFiles(root).filter(
        (file) => file.split(sep).includes("node_modules") && !recorded.has(file),
      );
      expect(unrecorded).toEqual([]);
      // The natives the agent imports are externals, so no recorded input holds them: reading
      // the agent's declarations has to do without them, as a hosted cache hit does.
      const natives = listFiles(root).filter((file) =>
        /[\\/]node_modules[\\/](sharp|@livekit[\\/]rtc-ffi-bindings[^\\/]*)[\\/]/.test(file),
      );
      expect(natives).toEqual([]);

      const outDir = join(outRoot, "materialized-hit");
      const child = runCli(["build", "--dependency-layer", descriptorPath, "--out", outDir], {
        cwd: materializedProject,
        bin: mirror(join(frameworkRoot, "bin", "curb.js")),
      });
      // 0, not 75: the declarations were read without a fallback to a full install.
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      const built = readFileSync(join(outDir, MANIFEST_FILENAME), "utf8");
      expect(built).toBe(readFileSync(emitManifestPath(), "utf8"));
      expect(declaredIn(join(outDir, MANIFEST_FILENAME))).toEqual(DECLARED);
      expect((JSON.parse(built) as Manifest).entryDigest).toBe(manifest().entryDigest);

      // A name the stand-in for sharp cannot export (a string-named import its pattern cannot
      // see): the agent fails to link against the stand-in, which is an escape, not a failure.
      const materializedAgent = join(materializedProject, AGENT);
      writeFileSync(
        materializedAgent,
        `import { "weird-name" as weird } from "sharp";\nexport const weirdProbe = weird;\n${readFileSync(materializedAgent, "utf8")}`,
      );
      const escapedOut = join(outRoot, "materialized-stand-in-escape");
      const escaped = runCli(["build", "--dependency-layer", descriptorPath, "--out", escapedOut], {
        cwd: materializedProject,
        bin: mirror(join(frameworkRoot, "bin", "curb.js")),
      });
      expect(escaped.status, `${escaped.stdout}\n${escaped.stderr}`).toBe(75);
      const lines = escaped.stderr.split("\n").filter((line) => line.startsWith("{"));
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        { code: "layer_escape", reason: "unresolved_import", path: "sharp" },
      ]);
      expect(existsSync(escapedOut)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  it("never loads @vercel/nft, observed by a module-resolution probe in a real CLI run", () => {
    const probe = join(outRoot, "probe");
    writeTree(probe, { "hooks.mjs": NFT_PROBE_HOOKS, "register.mjs": NFT_PROBE_REGISTER });
    const register = pathToFileURL(join(probe, "register.mjs")).href;

    // The probe sees a real load, so its silence below means something.
    const control = join(probe, "control.txt");
    const loaded = spawnSync(process.execPath, ["--import", register, "-e", 'await import("@vercel/nft")'], {
      cwd: frameworkRoot,
      env: { ...process.env, CURB_NFT_PROBE: control },
      encoding: "utf8",
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(readFileSync(control, "utf8")).toContain("@vercel/nft");

    const loads = join(probe, "hit.txt");
    const outDir = join(outRoot, "cli-hit");
    const child = runCli(["build", "--dependency-layer", descriptorPath, "--out", outDir], {
      nodeArgs: ["--import", register],
      env: { CURB_NFT_PROBE: loads },
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(existsSync(loads) ? readFileSync(loads, "utf8") : "").toBe("");
    expect(readFileSync(join(outDir, MANIFEST_FILENAME), "utf8")).toBe(readFileSync(emitManifestPath(), "utf8"));
  }, 180_000);

  it("finishes from the CLI when the agent module leaves a timer running at import", () => {
    const undo = edit(AGENT, (text) => `${text}\nsetInterval(() => {}, 60_000);\n`);
    const outDir = join(outRoot, "cli-interval");
    try {
      const started = Date.now();
      const child = runCli(["build", "--dependency-layer", descriptorPath, "--out", outDir]);
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(declaredIn(join(outDir, MANIFEST_FILENAME))).toEqual(DECLARED);
    } finally {
      undo();
    }
  }, 180_000);

  it("treats a changed mcp.servers.json as app content, not an escape", async () => {
    const changed = '{"servers":[{"id":"changed","url":"https://example.invalid/mcp"}]}\n';
    const undo = edit("mcp.servers.json", () => changed);
    try {
      const outDir = join(outRoot, "hit-mcp");
      await runCurbBuild({ projectRoot, outDir, dependencyLayer: descriptorPath });

      // The emitted manifest with only that entry, and therefore treeDigest, changed.
      const expected = JSON.parse(readFileSync(emitManifestPath(), "utf8")) as Manifest;
      const entry = expected.files.find((file) => file.path === layout().mcpServers);
      expect(entry).toBeDefined();
      entry!.digest = sha256(Buffer.from(changed));
      entry!.size = Buffer.byteLength(changed);
      expected.treeDigest = treeDigest(expected.files);

      const built = readFileSync(join(outDir, MANIFEST_FILENAME), "utf8");
      expect(built).toBe(`${JSON.stringify(expected, null, 2)}\n`);
      expect((JSON.parse(built) as Manifest).entryDigest).toBe(manifest().entryDigest);
    } finally {
      undo();
    }
  }, 120_000);

  async function expectEscape(apply: () => () => void, reason: string, path: string): Promise<void> {
    const undo = apply();
    const outDir = join(outRoot, `escape-${reason}-${Date.now()}`);
    try {
      await expect(runCurbBuild({ projectRoot, outDir, dependencyLayer: descriptorPath })).rejects.toMatchObject({
        code: "layer_escape",
        reason,
        path,
      });
      expect(existsSync(outDir)).toBe(false);
    } finally {
      undo();
    }
  }

  it("escapes on a new bare edge to an already-recorded package", async () => {
    await expectEscape(
      () => {
        const extra = edit("src/agent/layer-extra.ts", () => 'import "layer-foo";\nexport const layerExtra = 1;\n');
        const agent = edit(AGENT, (text) => `import "./layer-extra";\n${text}`);
        return () => {
          agent();
          extra();
        };
      },
      "unrecorded_edge",
      "layer-foo",
    );
  }, 120_000);

  it("escapes when a recorded import resolves to a nested version instead", async () => {
    await expectEscape(
      () =>
        edit("tsconfig.json", () =>
          JSON.stringify({
            compilerOptions: {
              paths: { "layer-foo": ["./node_modules/layer-bar/node_modules/layer-foo/index.js"] },
            },
          }),
        ),
      "unrecorded_edge",
      "layer-foo",
    );
  }, 120_000);

  it("escapes on a node_modules directory in project source", async () => {
    await expectEscape(
      () => {
        writeTree(projectRoot, {
          "src/agent/node_modules/layer-foo/package.json": '{"name":"layer-foo","version":"3.0.0","main":"index.js"}',
          "src/agent/node_modules/layer-foo/index.js": "module.exports = 3;\n",
        });
        return () => rmSync(join(projectRoot, "src/agent/node_modules"), { recursive: true, force: true });
      },
      "node_modules_in_source",
      "src/agent/node_modules/layer-foo/index.js",
    );
  }, 120_000);

  it("escapes on an external the layer never recorded", async () => {
    const external = DEV_ONLY_PACKAGES.find((name) => !buildInputs().recordedExternals.includes(name));
    expect(external).toBeDefined();
    await expectEscape(() => edit(AGENT, (text) => `import "${external}";\n${text}`), "unrecorded_external", external!);
  }, 120_000);

  it("escapes on a package outside the recorded inputs", async () => {
    await expectEscape(
      () => edit(AGENT, (text) => `import "layer-unused";\n${text}`),
      "unresolved_import",
      "layer-unused",
    );
  }, 120_000);

  it("exits 75 from the CLI with one stderr JSON line and leaves --out untouched", () => {
    const undo = edit(AGENT, (text) => `import "layer-unused";\n${text}`);
    const outDir = join(outRoot, "cli-out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "sentinel"), "left alone\n");
    try {
      const child = runCli(["build", "--dependency-layer", descriptorPath, "--out", outDir]);
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(75);
      const lines = child.stderr.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        code: "layer_escape",
        reason: "unresolved_import",
        path: "layer-unused",
      });
      expect(readdirSync(outDir)).toEqual(["sentinel"]);
    } finally {
      undo();
    }
  }, 180_000);
});
