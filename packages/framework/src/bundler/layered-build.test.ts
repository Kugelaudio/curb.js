import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MANIFEST_FILENAME } from "./bundle-digest.js";
import { runCurbBuild } from "./index.js";
import {
  AGENT,
  MCP_SERVERS,
  buildInputs,
  byBytes,
  createLayeredProject,
  emitLayers,
  emitManifestPath,
  emitted,
  frameworkRoot,
  isApp,
  layout,
  manifest,
  outRoot,
  projectRoot,
  removeLayeredProject,
  sha256,
  toPosix,
} from "./layered-build.fixture.js";

/**
 * Layered `curb build`, end to end over a real project, the emit side: `--emit-layers`
 * records the split and the build inputs and writes the same artifact as a plain build.
 * The `--dependency-layer` side is layered-build.dependency-layer.test.ts, its own file so
 * vitest runs it in a second worker. Both full builds trace and copy the runtime tree and
 * skip verify.
 */

const spy = vi.hoisted(() => ({ reads: [] as string[] }));

// Records every async readFile, to prove the copy stage stopped re-reading traced files.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const original = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  const readFile = ((...args: unknown[]) => {
    spy.reads.push(String(args[0]));
    return original(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

let plainManifest: Buffer;
let plainTraced: { files: number; bytes: number };
let emitReads: string[];

beforeAll(async () => {
  createLayeredProject();
  const plain = await runCurbBuild({ projectRoot, outDir: join(outRoot, "plain"), skipVerify: true });
  plainManifest = readFileSync(join(plain.outDir, MANIFEST_FILENAME));
  plainTraced = { files: plain.tracedFiles, bytes: plain.tracedBytes };
  rmSync(plain.outDir, { recursive: true, force: true });

  spy.reads.length = 0;
  await emitLayers();
  emitReads = [...spy.reads];
}, 600_000);

afterAll(removeLayeredProject);

describe("curb build --emit-layers", () => {
  it("writes today's artifact byte for byte", () => {
    expect(readFileSync(emitManifestPath()).equals(plainManifest)).toBe(true);
    expect({ files: emitted.tracedFiles, bytes: emitted.tracedBytes }).toEqual(plainTraced);
  });

  it("records every non-app file as the dependency layer, disjoint from the app set", () => {
    const record = JSON.parse(
      readFileSync(join(outRoot, "layers", "dependency-files.json"), "utf8"),
    ) as { format: number; files: string[] };
    expect(Object.keys(record).sort()).toEqual(["files", "format"]);
    expect(record.format).toBe(1);

    const paths = manifest().files.map((file) => file.path);
    const app = paths.filter(isApp);
    expect(record.files).toEqual(paths.filter((path) => !isApp(path)));
    expect(record.files.length).toBeGreaterThan(100);
    expect(record.files.filter((path) => app.includes(path))).toEqual([]);
    expect(app).toContain(manifest().entrypoint);
    expect(app.some((path) => path.startsWith("assets/"))).toBe(true);
  });

  it("ships mcp.servers.json as app content, at the project's position", () => {
    const entry = manifest().files.find((file) => file.path === layout().mcpServers);
    expect(entry).toMatchObject({ digest: sha256(Buffer.from(MCP_SERVERS)), size: MCP_SERVERS.length });
    const dependencyFiles = readFileSync(join(outRoot, "layers", "dependency-files.json"), "utf8");
    expect(dependencyFiles).not.toContain("mcp.servers.json");
  });

  it("ships Silero's model beside the bundled entry in the dependency layer", () => {
    const modelPath = `${layout().entryHome}/entry/silero_vad.onnx`;
    const source = readFileSync(
      join(frameworkRoot, "node_modules/@livekit/agents-plugin-silero/dist/silero_vad.onnx"),
    );
    expect(manifest().files.find((file) => file.path === modelPath)).toMatchObject({
      digest: sha256(source),
      size: source.byteLength,
    });

    const dependencyFiles = JSON.parse(
      readFileSync(join(outRoot, "layers", "dependency-files.json"), "utf8"),
    ) as { files: string[] };
    expect(dependencyFiles.files).toContain(modelPath);
  });

  it("ships undici, which the bundled AI SDK requires by name at runtime, in the dependency layer", () => {
    // The AI SDK loads undici through a runtime createRequire esbuild cannot bundle. Only an
    // external seed puts it in the dependency layer: the isolated bundle copy cannot resolve
    // it, and where it can (a builder TMPDIR inside the workspace) the layer check refuses.
    const dependencyFiles = JSON.parse(
      readFileSync(join(outRoot, "layers", "dependency-files.json"), "utf8"),
    ) as { files: string[] };
    // Restated rather than imported, so the test cannot agree with a list that lost an entry.
    const fromFramework = createRequire(join(frameworkRoot, "index.js"));
    const main = relative(realpathSync(layout().traceBase), realpathSync(fromFramework.resolve("undici")));
    expect(dependencyFiles.files).toContain(toPosix(main));
  });

  it("warms the real managed voice runner before announcing ready", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SystemRoot: process.env.SystemRoot,
      APPDATA: process.env.APPDATA,
      CURB_MANAGEMENT_ADDR: "127.0.0.1:0",
      CURB_MANAGEMENT_TOKEN: "layered-build-test-token",
      // A runner refuses to start without the key its agent's LLM needs. Warming never
      // calls the model, so a placeholder is enough here.
      KUGELAUDIO_API_KEY: "placeholder-for-warmup",
    };
    const child = spawn(process.execPath, [join(emitted.outDir, manifest().entrypoint)], {
      cwd: emitted.outDir,
      env,
    });
    let output = "";
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error(`managed runner did not become ready:\n${output}`)),
          10_000,
        );
        const collect = (chunk: Buffer): void => {
          output += chunk.toString();
          if (!output.includes('curb-hosted {"event":"ready"')) return;
          clearTimeout(timeout);
          resolveReady();
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          rejectReady(new Error(`managed runner exited ${code ?? signal} before ready:\n${output}`));
        });
      });
      expect(output).toContain('curb-hosted {"event":"ready"');
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
        await exited;
        clearTimeout(forceKill);
      }
    }
  }, 15_000);

  it("records esbuild's node_modules reads, their package.json files, the curb package and the bare edges", () => {
    const record = buildInputs();
    expect(Object.keys(record).sort()).toEqual(["edges", "format", "inputs", "recordedExternals"]);
    expect(record.format).toBe(1);
    expect(record.inputs).toEqual([...new Set(record.inputs)].sort(byBytes));

    for (const path of [
      "node_modules/layer-foo/index.js",
      "node_modules/layer-foo/package.json",
      "node_modules/layer-bar/index.js",
      "node_modules/layer-bar/package.json",
      "node_modules/layer-bar/node_modules/layer-foo/index.js",
      "node_modules/layer-bar/node_modules/layer-foo/package.json",
    ]) {
      expect(record.inputs, path).toContain(path);
    }
    expect(record.inputs).not.toContain("node_modules/layer-foo/README.md");
    expect(record.inputs).not.toContain("node_modules/layer-unused/index.js");

    const inFramework = (path: string) => toPosix(relative(projectRoot, join(frameworkRoot, path)));
    expect(record.inputs).toContain(inFramework("package.json"));
    expect(record.inputs).toContain(inFramework("src/bundler/index.ts"));
    // Portable LiveKit JavaScript is an input because esbuild owns it. Only the compiled
    // binding packages remain external and are copied into the dependency layer.
    // Nested under the framework or hoisted, depending on what the rest of the install wants.
    let agentsDir = frameworkRoot;
    while (!existsSync(join(agentsDir, "node_modules/@livekit/agents/package.json"))) agentsDir = dirname(agentsDir);
    const agentsManifest = join(agentsDir, "node_modules/@livekit/agents/package.json");
    expect(record.inputs.filter((path) => path.endsWith("/@livekit/agents/package.json"))).toEqual([
      toPosix(relative(projectRoot, agentsManifest)),
    ]);

    expect(record.edges).toContainEqual({
      importer: AGENT,
      specifier: "layer-foo",
      kind: "import-statement",
      resolved: "node_modules/layer-foo/index.js",
    });
    expect(record.edges.some((edge) => edge.importer.startsWith("node_modules/"))).toBe(false);
    expect(record.recordedExternals).not.toContain("@livekit/agents");
  });

  it("records the toolchain closure that runs curb build, at the framework's own resolution", () => {
    const record = buildInputs();
    const fromProject = (path: string) => toPosix(relative(projectRoot, path));
    for (const name of ["tsx", "esbuild"]) {
      let dir = frameworkRoot;
      while (!existsSync(join(dir, "node_modules", name, "package.json"))) dir = dirname(dir);
      const packageDir = join(dir, "node_modules", name);
      expect(record.inputs, name).toContain(`${fromProject(packageDir)}/package.json`);
    }
    expect(record.inputs.some((path) => /\/@esbuild\/[^/]+\/package\.json$/.test(path))).toBe(true);
  });

  it("counts traced bytes without re-reading every traced file", () => {
    const { traceBase } = layout();
    const reread = emitReads.filter(
      (path) =>
        path.startsWith(traceBase + sep) &&
        path.split(sep).includes("node_modules") &&
        !path.startsWith(projectRoot + sep) &&
        // Read once at compile time by the merge-frames plugin, which rewrites it.
        !/[\\/]@livekit[\\/]agents[\\/]dist[\\/]utils\.c?js$/.test(path),
    );
    expect(reread.length, reread.slice(0, 3).join("\n")).toBe(0);
    expect(emitted.tracedBytes).toBeGreaterThan(0);
  });
});
