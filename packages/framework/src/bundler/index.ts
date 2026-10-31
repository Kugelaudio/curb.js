import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { generateAgentModulesCode } from "./agent-modules.js";
import { curbVersion } from "../version.js";
import { describeExternals, externalPackages, NATIVE_PACKAGES, RUNTIME_REQUIRED_PACKAGES } from "./externals.js";
import {
  copyPackageForTarget,
  mirrorInstalledDependencies,
  resolveDependencyDir,
} from "./dependency-mirror.js";
import {
  bundleAgentDeclarations,
  bundleRequiredSecrets,
  deriveRequiredCapabilities,
  hostNodeMajor,
  RUNTIME_PROTOCOL_VERSION,
} from "./declarations.js";
import { mergeFramesPlugin } from "./merge-frames-plugin.js";
import { rawLoaderPlugin } from "./raw-plugin.js";
import { generateContextRegistryCode, projectContextFiles } from "./context-registry.js";
import { hostBuildTarget } from "./build-target.js";
import { libraryEntrySource, workerEntrySource } from "./generated-entries.js";
import { readProjectPackageName } from "../server/voice/worker-name.js";
import {
  verificationIsolationRoot,
  verifyArtifactStarts,
  type VerifyResult,
} from "./verify.js";
import { writeBundleAssets } from "./assets.js";
import { treeDigest, collectBundleFiles, MANIFEST_FILENAME } from "./bundle-digest.js";
import { assertNoBuildPathsLeaked } from "./reproducibility.js";
import { formatBuildTimings, startBuildTimer, type StageTiming } from "./timings.js";
import {
  analyzeMetafile,
  assertBundleOutputsAreEntries,
  assertDependencyStagesSparedAppLayer,
  BUILD_INPUTS_FILENAME,
  collectBuildInputs,
  DEPENDENCY_FILES_FILENAME,
  digestFiles,
  isAppLayerPath,
  MCP_SERVERS_FILENAME,
  mcpServersPath,
  mergeDependencyLayerFiles,
  type AppLayerLayout,
  readDependencyLayerDescriptor,
  traceFilesOnlyFromBundleCopy,
  writeLayerRecords,
} from "./layers.js";
import { findLayerEscape, unresolvedImportEscape } from "./layer-escape.js";

/** What `curb build` produces. */
export type BuildResult = {
  outDir: string;
  entry: string;
  bundleBytes: number;
  tracedFiles: number;
  tracedBytes: number;
  /** Packages copied in to restore the version the project installed. */
  mirroredPackages: number;
  /**
   * Content address of the whole TREE, over the canonical index stream defined in
   * `bundle-digest.ts`.
   *
   * Deliberately NOT called `bundleDigest`, and deliberately not the same number.
   * A host's archive digest is the digest of the transferred ARCHIVE, checked before
   * the manifest is even parsed. The two answer different questions: this one identifies
   * the files, that one identifies the bytes that were fetched.
   *
   * They were briefly the same name, and the artifact store nearly compared one against
   * the other, which would have refused every real bundle as corrupt.
   */
  treeDigest: `sha256:${string}`;
  /** How many files `manifest.files` describes: every bundle file but the manifest. */
  manifestFiles: number;
  /** Proof the artifact starts, or undefined when the check was skipped. */
  verification?: VerifyResult;
  /**
   * Where this build's wall clock went, stage by stage, in the order the stages ran.
   *
   * Reported as data as well as printed, so a caller that already formats a build
   * summary can present it rather than parse it back out of the log. See timings.ts.
   */
  timings: StageTiming[];
  warnings: string[];
  /**
   * Set by a layered build: `emit` for `--emit-layers`, `hit` for `--dependency-layer`.
   * Counts only; the records themselves are files. See layers.ts.
   */
  layers?: { mode: "emit" | "hit"; dependencyFiles: number; buildInputs: number };
};

export type BuildOptions = {
  projectRoot: string;
  outDir?: string;
  /** Skip tracing and copying runtime files. Useful to inspect the bundle alone. */
  skipTrace?: boolean;
  /** Skip starting the finished artifact. The build then only claims it compiled. */
  skipVerify?: boolean;
  /**
   * `--emit-layers <dir>`: build exactly as usual, then also write `dependency-files.json`
   * and `build-inputs.json` to this directory (layer contract L1). See layers.ts.
   */
  emitLayers?: string;
  /**
   * `--dependency-layer <descriptor.json>`: build only the app layer, against a node_modules
   * holding only the descriptor's recorded build inputs. Throws a LayerEscapeError, having
   * written nothing, when the bundle reaches past that record. See layer-escape.ts.
   */
  dependencyLayer?: string;
};

const GENERATED_DIR = ".curb/build";

/**
 * Default output root, mirroring Next's `.next/standalone`.
 *
 * A dot-directory rather than dist/, because this is build output that tooling should
 * ignore by default and because dist/ carries the wrong implication for a package that
 * deliberately publishes no dist.
 */
const DEFAULT_OUT = ".curb/standalone";

/**
 * Build a project into a self-contained directory that starts with no `npm install`
 * and no TypeScript compilation.
 *
 * The pipeline order is not arbitrary and is the one non-obvious thing here:
 *
 *   1. generate a STATIC agent registry
 *   2. esbuild TypeScript -> one JavaScript file
 *   3. trace THAT JavaScript to find the runtime files, including native binaries
 *   4. copy them, write a manifest
 *
 * Step 1 exists because agent discovery is `readdirSync` plus a computed `import()`
 * (`agent.node.ts`, `routing.node.ts`). A bundler follows static imports; it sees a
 * variable and bundles none of the project, producing an artifact that imports nothing
 * and crashes at its first directory read.
 *
 * Step 3 comes AFTER step 2 because the tracer parses JavaScript, not TypeScript.
 * Pointed at curb's TypeScript source it returns two files and a parse warning — which
 * looks like a working trace of a tiny dependency graph rather than a failure.
 */
/**
 * Walk up from `start` and return the highest directory that has a node_modules.
 *
 * npm hoists shared packages to the workspace root, so a project inside a workspace
 * resolves most of its dependencies from above itself. The tracer needs a base that
 * contains them; given the project directory it finds almost nothing and says so only
 * as a warning.
 */
function outermostDependencyRoot(start: string): string {
  let current = start;
  let outermost = start;
  for (;;) {
    if (existsSync(join(current, "node_modules"))) outermost = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return outermost;
}

/**
 * Resolve a package's main entry file, searching from `from` upward.
 *
 * createRequire rather than import.meta.resolve because these packages are CommonJS
 * with native bindings, and require resolution is what Node will actually use for them
 * at runtime. Returns undefined rather than throwing so the caller can collect every
 * unresolvable name and report them together.
 */
function resolvePackageRoot(name: string, from: string): string | undefined {
  const require = createRequire(join(from, "index.js"));
  // Resolve package.json rather than the main entry: modern packages gate their main
  // behind an "exports" map that require.resolve cannot always see, and the directory
  // holding package.json is what we actually want to copy.
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    try {
      // Some packages do not export their package.json. Fall back to the main entry
      // and walk up until a package.json appears.
      let dir = dirname(require.resolve(name));
      for (;;) {
        if (existsSync(join(dir, "package.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    } catch {
      return undefined;
    }
  }
}

export async function runCurbBuild(options: BuildOptions): Promise<BuildResult> {
  // Started before anything is read from disk, so the total below is the build's own
  // wall clock and not the sum of the parts somebody remembered to instrument.
  const timer = startBuildTimer();
  const projectRoot = resolve(options.projectRoot);
  const outDir = resolve(options.outDir ?? join(projectRoot, DEFAULT_OUT));
  const buildTarget = hostBuildTarget();

  const agentDir = join(projectRoot, "src", "agent");
  if (!existsSync(agentDir)) {
    throw new Error(
      `curb build: ${projectRoot} has no src/agent directory.\n` +
        `  A curb project keeps its agent and skills there. Run this from a project root.`,
    );
  }

  const emitLayersDir = options.emitLayers === undefined ? undefined : resolve(options.emitLayers);
  if (emitLayersDir !== undefined) {
    if (options.dependencyLayer !== undefined) {
      throw new Error("curb build: --emit-layers and --dependency-layer are two different builds; pass one.");
    }
    if (options.skipTrace) {
      throw new Error("curb build: --emit-layers splits off the traced dependency tree, so it cannot run with --no-trace.");
    }
    if (emitLayersDir === outDir || emitLayersDir.startsWith(outDir + sep)) {
      throw new Error(
        `curb build: --emit-layers ${emitLayersDir} is inside --out ${outDir}.\n` +
          `  The records would be archived as part of the artifact; write them elsewhere.`,
      );
    }
    // A failed build must not leave a previous build's records looking current.
    await rm(join(emitLayersDir, DEPENDENCY_FILES_FILENAME), { force: true });
    await rm(join(emitLayersDir, BUILD_INPUTS_FILENAME), { force: true });
  }
  // Read before anything is written: a descriptor this build cannot use leaves --out alone.
  const descriptor =
    options.dependencyLayer === undefined
      ? undefined
      : await readDependencyLayerDescriptor(resolve(options.dependencyLayer));

  // A dependency-layer build replaces --out only after its escape checks pass, because an
  // escape must write nothing there (L1). It cleans after esbuild instead.
  if (!descriptor) {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    // Its own stage, because it is not free and it is not the same on every run: a rebuild
    // over a previous artifact deletes a few hundred megabytes here, and a first build
    // deletes nothing. A breakdown that hid this would look nondeterministic instead.
    timer.mark("clean", "remove any previous artifact at the output path");
  }

  const generatedDir = join(projectRoot, GENERATED_DIR);
  await mkdir(generatedDir, { recursive: true });

  // 1. The static registry: the agent and its skills as static imports esbuild can follow
  //    (agent-modules.ts).
  const registryPath = join(generatedDir, "agent-registry.mjs");
  const registryCode = generateAgentModulesCode(projectRoot);
  await writeFile(registryPath, registryCode, "utf8");

  // 2. The hosted entries, a library surface and a runnable worker. See
  //    generated-entries.ts.
  // Locate the framework by asking this module where it is, rather than resolving
  // "curb/orchestration" from the project. A workspace-linked project has no local
  // node_modules/curb (npm hoists it), and a CDN-installed one does — resolution would
  // have to handle both, while this file always knows its own path.
  const frameworkSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const orchestration = join(frameworkSrc, "orchestration.ts");
  if (!existsSync(orchestration)) {
    throw new Error(
      `curb build: cannot find the framework's orchestration entry at ${orchestration}.\n` +
        `  This means the framework layout moved; the build cannot continue without it.`,
    );
  }

  // 1b. The project's context/ markdown, inlined. Tracing cannot find it: nft follows
  //     JavaScript imports and these files are read by PATH at runtime, against a
  //     project root the artifact does not have. See context-registry.ts.
  const contextRegistryPath = join(generatedDir, "context-registry.mjs");
  await writeFile(
    contextRegistryPath,
    generateContextRegistryCode(projectRoot, join(frameworkSrc, "public-context.ts")),
    "utf8",
  );

  const entrySource = libraryEntrySource({ contextRegistryPath, registryPath, orchestration });
  const entryPath = join(generatedDir, "hosted-entry.mjs");
  await writeFile(entryPath, `${entrySource}\n`, "utf8");

  // Resolve from the framework, not from the generated file in the project. Workspace
  // installs can legitimately hold a different hoisted version beside the project and
  // the version selected for `curb` in its own node_modules; the hosted bundle must use
  // the latter, just like imports from the framework's source do.
  const livekitAgentsEntry = createRequire(join(frameworkSrc, "index.js")).resolve(
    "@livekit/agents",
  );
  const workerSource = workerEntrySource({
    contextRegistryPath,
    registryPath,
    frameworkSrc,
    livekitAgentsEntry,
    // Baked in: the artifact has no package.json of the project's to read at run time, and
    // its worker mode must register under the name `curb start` uses.
    projectName: readProjectPackageName(projectRoot),
  });
  const workerEntryPath = join(generatedDir, "hosted-worker.mjs");
  await writeFile(workerEntryPath, `${workerSource}\n`, "utf8");
  timer.mark("generate", "the static registry, the context registry and both entries");

  // 3. Bundle.
  // The entry sits at its PROJECT-RELATIVE position inside the standalone root, the
  // way Next places server.js. That is what makes Node's ordinary upward resolution
  // reproduce the source tree's resolution: from
  // <out>/examples/insurance-agent/entry/hosted.mjs it walks the same node_modules
  // chain it would have walked in the real checkout.
  //
  // It is placed relative to the FRAMEWORK, not the project. The bundle is mostly
  // inlined framework code, and its externals are the framework's declared
  // dependencies -- which npm may install into packages/framework/node_modules rather
  // than hoisting. Sitting at the project's path would give the bundle the project's
  // resolution scope, which never passes through the framework's node_modules, and
  // silero would be unresolvable however faithfully the tree was mirrored.
  //
  // From <out>/packages/framework/entry/hosted.mjs, Node walks
  // packages/framework/node_modules -> packages/node_modules -> node_modules: the
  // framework's own deps AND everything hoisted to the root.
  const traceBase = outermostDependencyRoot(projectRoot);
  const frameworkRoot = resolvePackageRoot("curb", frameworkSrc) ?? dirname(frameworkSrc);
  const entryHome = relative(traceBase, frameworkRoot);
  // Where the app layer sits in the tree (layer contract L2).
  const layout: AppLayerLayout = {
    entryHome: entryHome.split(sep).join("/"),
    projectHome: relative(traceBase, projectRoot).split(sep).join("/"),
  };
  const outFile = join(outDir, entryHome, "entry", "hosted.mjs");
  if (!descriptor) await mkdir(dirname(outFile), { recursive: true });

  const workerOutFile = join(dirname(outFile), "worker.mjs");
  const entryFiles = [outFile, workerOutFile];

  const bundle = await esbuild.build({
    // Every path esbuild PRINTS -- the `// <module path>` comment it writes above each
    // bundled module -- is relative to this directory. Left at process.cwd() the emitted
    // comments are relative to wherever `curb build` was invoked from, so the same
    // revision built from the project directory and from the workspace root produced two
    // different files. Pinning it to the dependency root makes them a function of the
    // repository layout instead, which is part of the revision. Everything this build
    // hands esbuild is an absolute path, so nothing else moves with it.
    absWorkingDir: traceBase,
    entryPoints: { hosted: entryPath, worker: workerEntryPath },
    entryNames: "[name]",
    // .mjs so Node treats the output as ESM regardless of the nearest package.json
    // "type" field, which in a mirrored tree is whatever happened to be copied.
    outExtension: { ".js": ".mjs" },
    outdir: dirname(outFile),
    outbase: generatedDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: externalPackages(),
    plugins: [rawLoaderPlugin(traceBase), mergeFramesPlugin()],
    logLevel: "silent",
    metafile: true,
    // A dependency-layer build keeps the output in memory until its escape checks pass.
    write: !descriptor,
    // JSX: the agent tree is React. Without this the .tsx files fail to parse and the
    // error points at the file rather than at the missing configuration.
    jsx: "automatic",
    // Keep names: the framework reads component displayName in authoring diagnostics,
    // and minification would turn every diagnostic into a single letter.
    keepNames: true,
    banner: {
      // ESM output has no `require`, `__filename` or `__dirname`, but bundled
      // CommonJS dependencies still call them at runtime -- @vercel/oidc does
      // `require("path")` on import. esbuild emits a shim that throws "Dynamic require
      // of X is not supported" unless a real `require` exists in scope.
      //
      // createRequire bound to this module's URL gives them one that resolves relative
      // to the artifact, which is what makes the mirrored node_modules tree reachable
      // from bundled CJS as well as from the externals.
      js: [
        `import { createRequire as __curbCreateRequire } from "node:module";`,
        `import { fileURLToPath as __curbFileURLToPath } from "node:url";`,
        `import { dirname as __curbDirname } from "node:path";`,
        `const require = __curbCreateRequire(import.meta.url);`,
        `const __filename = __curbFileURLToPath(import.meta.url);`,
        `const __dirname = __curbDirname(__filename);`,
      ].join("\n"),
    },
  }).catch((error: unknown) => {
    // A dependency-layer build resolves against the recorded inputs only, so an import it
    // cannot resolve is an escape the builder falls back from, not the project's error.
    throw (descriptor && unresolvedImportEscape(error)) || error;
  });
  timer.mark("esbuild", "compile the project and the framework into one bundle");

  const warnings = bundle.warnings.map((w) => w.text);
  if (descriptor || emitLayersDir) {
    const outputs = Object.keys(bundle.metafile.outputs).map((output) => resolve(traceBase, output));
    assertBundleOutputsAreEntries(outputs, entryFiles);
  }
  if (descriptor) {
    const escape = findLayerEscape(
      analyzeMetafile(bundle.metafile, { absWorkingDir: traceBase, projectRoot }),
      descriptor.buildInputs,
    );
    if (escape) throw escape;
    timer.mark("escape", "prove the bundle read only the recorded build inputs");
  }

  // 3b. The agent's goals, experiments and hooks, for the manifest (declarations.ts). After the
  //     escape checks, so a dependency-layer build that reaches past its inputs reports esbuild's
  //     reason; before that build writes --out, so an escape here leaves --out alone too.
  const agentDeclarations = await bundleAgentDeclarations({ projectRoot, dependencyLayer: descriptor !== undefined });
  timer.mark("declarations", "import the agent to read its goals and experiments");

  if (descriptor) {
    await rm(outDir, { recursive: true, force: true });
    for (const output of bundle.outputFiles ?? []) {
      await mkdir(dirname(output.path), { recursive: true });
      await writeFile(output.path, output.contents);
    }
    timer.mark("clean", "replace the output path with the two entries esbuild just compiled");
  }
  const bundleBytes = (await readFile(outFile)).byteLength;
  // Taken before the dependency stages, to prove afterwards that none of them wrote an entry.
  const entryDigests = emitLayersDir ? await digestFiles(entryFiles) : [];

  let tracedFiles = 0;
  let tracedBytes = 0;
  let mirroredPackages = 0;

  // A dependency-layer build has its dependency tree already: the descriptor names it.
  if (!options.skipTrace && !descriptor) {
    // 4. Trace the BUNDLED JavaScript, not the source.
    //
    // `base` must contain the dependencies, not just the project. npm hoists shared
    // packages to the workspace root, so a project inside a workspace has few or no
    // local node_modules and tracing from the project directory silently resolves
    // almost nothing — it reports one file and a resolve warning rather than failing,
    // which reads like a small dependency graph instead of a broken trace.
    const base = traceBase;

    // Externals are copied WHOLE, not left to the tracer.
    //
    // The tracer follows reachable files, which for these packages copied dist/*.cjs
    // but not package.json -- leaving Node with no exports map, falling back to a
    // legacy index.js that does not exist. Partial packages are a recurring failure
    // shape here, and the fix is not more tracing: these are the native packages, and
    // we want all of them anyway.
    //
    // They are resolved from the FRAMEWORK's location because npm does not hoist them
    // uniformly -- in this workspace @livekit/agents and agents-plugin-silero install
    // into packages/framework/node_modules, which is not on the resolution path upward
    // from the artifact.
    const unresolvable: string[] = [];
    const wholeCopied: string[] = [];
    for (const name of NATIVE_PACKAGES) {
      const packageRoot = resolvePackageRoot(name, frameworkSrc);
      if (!packageRoot) {
        unresolvable.push(name);
        continue;
      }
      // To its original relative location, not a flattened one: two packages may
      // legitimately have different nested versions, and flattening silently keeps one.
      const destination = join(outDir, relative(base, packageRoot));
      await mkdir(dirname(destination), { recursive: true });
      await copyPackageForTarget({ name, source: packageRoot, destination, target: buildTarget });
      wholeCopied.push(destination);
    }

    // The Silero package's JavaScript bundles cleanly, but it resolves this model relative
    // to `import.meta.url`. Once bundled that URL names the generated entry, so preserve
    // the package's runtime contract by putting the model beside both generated entries.
    // Keeping the whole plugin external instead would pull its peer dependency closure
    // back into the artifact and restore thousands of files on every sandbox start.
    const sileroRoot = resolvePackageRoot("@livekit/agents-plugin-silero", frameworkSrc);
    if (!sileroRoot) {
      throw new Error(
        "curb build: @livekit/agents-plugin-silero is not resolvable, so its VAD model " +
          "cannot be included in the hosted artifact.",
      );
    }
    await cp(
      join(sileroRoot, "dist", "silero_vad.onnx"),
      join(dirname(outFile), "silero_vad.onnx"),
    );
    if (unresolvable.length > 0) {
      // Declared but unresolvable means the artifact cannot start. Fail at build time
      // rather than letting it surface as MODULE_NOT_FOUND inside a live call.
      throw new Error(
        `curb build: these declared dependencies could not be resolved, so the artifact ` +
          `would fail at runtime:\n` +
          unresolvable.map((m) => `  - ${m}`).join("\n") +
          `\n  Run npm install, then build again.`,
      );
    }
    timer.mark("externals", "copy the declared native packages for the target");

    // Copying an external whole gets its own files but NOT its dependencies, so it is
    // ALSO seeded into the trace. @livekit/agents needs commander@^12 from
    // packages/framework/node_modules; without seeding, only the root's commander@7
    // was mirrored and the agents CLI died on `Option.env is not a function`.
    //
    // Whole-copy and trace are complementary here, not alternatives: the copy
    // guarantees a complete package (the tracer skipped package.json), the trace
    // guarantees its dependency closure.
    // The bundle is traced from an ISOLATED COPY, not where it was written.
    //
    // The tracer resolves a seed's imports by walking UP from it, so a bundle written
    // inside a checkout resolves that checkout's node_modules and drags packages into the
    // artifact that the same bundle written to /tmp never sees -- an in-place build of the
    // insurance example shipped the repository root's commander@7, which is precisely the
    // version dependency-mirror.ts exists to keep away from @livekit/agents. Two builds of
    // one revision differing only in --out then produced different trees and different
    // treeDigests, and artifact identity stopped being a function of the revision.
    //
    // The same isolation argument verify.ts makes about STARTING an artifact inside the
    // repository applies to tracing one. The bundle's own externals are seeded below from
    // the framework's location, deliberately, so nothing is lost by denying the seed an
    // ancestry it must not have had.
    const traceHome = await mkdtemp(join(tmpdir(), "curb-trace-"));
    const traceSeed = join(traceHome, "hosted.mjs");
    await cp(outFile, traceSeed);
    // Resolved, because the OS temp directory is a symlink on macOS and the tracer
    // reports real paths: comparing against the unresolved name would fail to recognise
    // the seed's own files and copy the bundle into itself under a /private/... path.
    const traceHomeReal = await realpath(traceHome);

    const seeds = [traceSeed];
    const externalOwnedRoots: string[] = [];
    for (const name of NATIVE_PACKAGES) {
      const packageRoot = resolvePackageRoot(name, frameworkSrc);
      if (!packageRoot) continue;
      externalOwnedRoots.push(relative(base, packageRoot).split(sep).join("/"));
      const require = createRequire(join(frameworkSrc, "index.js"));
      try {
        seeds.push(require.resolve(name));
      } catch {
        // No resolvable main; the whole-copy already placed its files, and its
        // dependencies are reached through whatever else imports them.
        seeds.push(join(packageRoot, "package.json"));
      }
    }
    for (const name of RUNTIME_REQUIRED_PACKAGES) {
      const packageRoot = resolvePackageRoot(name, frameworkSrc);
      if (!packageRoot) {
        throw new Error(
          `curb build: ${name}, which the bundled framework loads by name at runtime, is not ` +
            `resolvable from the framework, so the artifact would fail where it is required.\n` +
            `  Run npm install, then build again.`,
        );
      }
      externalOwnedRoots.push(relative(base, packageRoot).split(sep).join("/"));
      seeds.push(createRequire(join(frameworkSrc, "index.js")).resolve(name));
    }
    // Loaded here, not at the top of the module: a --dependency-layer build never traces and
    // must not pay to load the tracer either (layer contract L1).
    const { nodeFileTrace } = await import("@vercel/nft");
    let traced;
    try {
      // mcp.servers.json is the agent's configuration, not a runtime dependency. The tracer
      // reached it through the framework's `join(process.cwd(), "mcp.servers.json")`, which
      // put agent content in the dependency layer; the assets stage below copies it instead.
      const mcpServersTraceKey = relative(base, join(projectRoot, MCP_SERVERS_FILENAME));
      traced = await nodeFileTrace(seeds, { base, ignore: (path) => path === mcpServersTraceKey });
    } finally {
      await rm(traceHome, { recursive: true, force: true });
    }
    timer.mark("trace", "@vercel/nft over the bundle and the external seeds");

    if (emitLayersDir) {
      // The bundle copy is the one seed that carries agent code. A file only it reaches
      // would make the dependency layer a function of the agent, and a reused layer would
      // be missing it. Checked before the copy, so the refusal costs nothing more.
      const isBundleCopy = (file: string): boolean => {
        const absolute = join(base, file);
        return absolute.startsWith(traceHome + sep) || absolute.startsWith(traceHomeReal + sep);
      };
      // nft may merge an explicit seed's reason with the bundle's import reason and retain
      // only the latter. Keep the caller-owned seed set explicit instead of trying to
      // reconstruct it from that lossy provenance map.
      const externalSeeds = new Set(
        seeds.slice(1).map((file) => relative(base, file).split(sep).join("/")),
      );
      const isExternalOwned = (file: string): boolean => {
        if (externalSeeds.has(file)) return true;
        for (const root of externalOwnedRoots) {
          if (!file.startsWith(root + "/")) continue;
          const withinPackage = file.slice(root.length + 1);
          if (!withinPackage.split("/").includes("node_modules")) return true;
        }
        return false;
      };
      const fromBundle = traceFilesOnlyFromBundleCopy(
        traced.reasons,
        traced.fileList,
        isBundleCopy,
        isExternalOwned,
      );
      if (fromBundle.length > 0) {
        throw new Error(
          `curb build --emit-layers: the isolated bundle copy contributed ${fromBundle.length} ` +
            `trace file(s) no external seed reaches: ${fromBundle.slice(0, 5).join(", ")}.\n` +
            `  The dependency layer must not depend on agent code, so no layer records were written.`,
        );
      }
    }

    // Traced files land at the artifact ROOT, preserving their node_modules/... path,
    // so Node's ordinary upward resolution from entry/hosted.mjs finds them at
    // <outDir>/node_modules. Nesting them under runtime/ would leave the bundle
    // resolving against whatever node_modules happens to sit above the artifact --
    // which on a dev machine is the real install, making any smoke test a false green.
    const runtimeDir = outDir;
    for (const file of traced.fileList) {
      // Traced paths are relative to `base`, not to the project.
      const absolute = join(base, file);
      // The bundle traces itself, through the isolated copy above; it is already in place.
      if (
        absolute === outFile ||
        absolute.startsWith(traceHome + sep) ||
        absolute.startsWith(traceHomeReal + sep)
      ) {
        continue;
      }
      // Anything already inside the artifact is a file this build just placed there:
      // the externals are copied whole BEFORE the trace, and the tracer resolves the
      // bundle's imports against them rather than against their source location. Copying
      // those hits would nest a second copy of the artifact inside itself -- 94 MB of
      // duplicate packages that no resolution path ever reaches.
      if (absolute === outDir || absolute.startsWith(outDir + sep)) continue;

      // Mirror the source tree exactly. Re-rooting everything at a single top-level
      // node_modules looks tidier and is wrong: two packages can legitimately resolve
      // different nested versions of one dependency, and collapsing them ships one and
      // breaks whichever needed the other. That failure is silent at build time and
      // surfaces as "Class extends value undefined" at import.
      const destination = join(runtimeDir, file);
      await mkdir(dirname(destination), { recursive: true });
      try {
        await cp(absolute, destination, { recursive: true, dereference: true });
        tracedFiles += 1;
        // The size from stat rather than a second full read of a file cp just copied. A
        // directory counts 0 bytes, exactly as the failed read that used to measure it did.
        tracedBytes += await stat(absolute).then((info) => (info.isFile() ? info.size : 0));
      } catch {
        // A traced path that cannot be copied is reported, never skipped silently:
        // a file missing from the artifact is a runtime MODULE_NOT_FOUND later, and
        // "later" means inside a live call.
        warnings.push(`could not copy traced file: ${file}`);
      }
    }

    for (const warning of traced.warnings) {
      warnings.push(String((warning as Error).message ?? warning).split("\n")[0]);
    }
    timer.mark("copy", "place every traced file in the artifact");

    // 4b. Reproduce the installed dependency TREE, not just the traced file set.
    //
    // Copying whole and tracing both lose version information -- see the module comment
    // in dependency-mirror.ts. This pass compares every dependency edge in the artifact
    // against the source install, copies in what the tracer could not see, and THROWS if
    // any edge still resolves to a version the project never installed. It is the last
    // step before the manifest because it needs the finished tree.
    const mirror = await mirrorInstalledDependencies({ outDir, base, wholeCopied, target: buildTarget });
    mirroredPackages = mirror.copied.length;
    timer.mark("mirror", "restore the dependency versions the trace could not reach");

    if (emitLayersDir) {
      await assertDependencyStagesSparedAppLayer({
        outDir,
        entries: entryFiles,
        entryDigests,
        reserved: [MANIFEST_FILENAME, "assets", mcpServersPath(layout.projectHome)],
      });
    }
  }

  // 4c. The revision's own text, as FILES.
  //
  // The project's context/ markdown and its agent sources both reach the runtime inlined
  // in the module graph, where nothing can read them back. An authoring surface asked to
  // show a running agent's source has the artifact and not the checkout, so the bundle
  // carries them a second time under assets/ -- byte-identical to the revision, which is
  // what makes them comparable against it. See assets.ts.
  const assets = await writeBundleAssets({ projectRoot, outDir, registryCode });

  // The agent's MCP server list, when it has one: app layer (L2) in every mode. It is read
  // from process.cwd() at runtime (src/mcp/servers-store.ts), so it goes where the trace used
  // to put it -- the project's own position, `mcp.servers.json` in a hosted build.
  const mcpServersSource = join(projectRoot, MCP_SERVERS_FILENAME);
  if (existsSync(mcpServersSource)) {
    const destination = join(outDir, ...mcpServersPath(layout.projectHome).split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(mcpServersSource, destination, { dereference: true });
  }
  timer.mark("assets", "the revision's context markdown, agent source and MCP server list, as files");

  // 5. The manifest.
  //
  // `entrypoint` names the RUNNABLE entry. It named the library entry until an artifact
  // was actually run by the hosted executor: that file exits 0 having started nothing, so
  // the platform recorded a clean run for a call that never happened. An entrypoint a
  // runner cannot start is not an entrypoint.
  //
  // `entryDigest` is kept alongside `treeDigest` because they answer different
  // questions: "is the file the runner is about to execute the one that was built" and
  // "is this tree the artifact the deployment references". The first is checkable without
  // reading 600 MB.
  const entrypoint = relative(outDir, workerOutFile).split(sep).join("/");

  // Reproducibility is asserted before it is claimed. The flag was false because the
  // ?raw loader stamped this machine's absolute paths into both entries; a constant
  // `true` here would be a claim no code checks. See reproducibility.ts.
  await assertNoBuildPathsLeaked({
    outDir,
    generated: [entrypoint, relative(outDir, outFile).split(sep).join("/")],
    roots: [projectRoot, traceBase, frameworkSrc, frameworkRoot],
  });
  timer.mark("reproducible", "prove the emitted entries carry no build-machine path");

  // `files[]` and `treeDigest`, so a host can verify the tree and two builds of one
  // revision agree. The digest is taken over a canonical stream that carries every file's
  // path, mode, size and content hash and NO timestamp, host path or mtime -- see
  // bundle-digest.ts, which spells the format out because a runner written in another
  // language has to reproduce it byte for byte.
  //
  // Computed here, after every step that writes into the tree and before the manifest is
  // written, because the manifest is the one file the digest excludes.
  //
  // A dependency-layer build holds only the app layer on disk, but its manifest still
  // describes the whole artifact: files[] and treeDigest take the descriptor's entries too.
  const treeFiles = await collectBundleFiles(outDir);
  const files = descriptor
    ? mergeDependencyLayerFiles(treeFiles, descriptor.files, layout)
    : treeFiles;
  const digest = treeDigest(files);
  timer.mark("digest", "hash every file in the finished tree");

  // `externals[]`, with the version that is actually in the tree above.
  //
  // Resolved from the artifact's own entry directory, bounded by the artifact root, which
  // is the walk Node performs at runtime -- so the version recorded is the one the runner
  // will load, not the one the project's package.json asks for. `--no-trace` leaves the
  // artifact without a dependency tree at all, so there is nothing there to read and the
  // only remaining truth is the install the tree WOULD have been mirrored from. That
  // artifact cannot start either way; the fallback is named rather than silent.
  //
  // A dependency-layer build has no tree to read versions from. The full build that produced
  // the layer read them, and the builder copied that answer into the descriptor (L3), so the
  // manifest repeats it rather than recomputing it.
  const externals = descriptor
    ? descriptor.externals
    : await describeExternals(
    NATIVE_PACKAGES,
    options.skipTrace
      ? {
          resolve: (name) => resolvePackageRoot(name, frameworkSrc),
          root: traceBase,
          describe: "the project's install (this build ran with --no-trace, so the " +
            "artifact carries no dependency tree to read)",
        }
      : {
          resolve: (name) => resolveDependencyDir(dirname(outFile), outDir, name),
          root: outDir,
          describe: "the artifact",
        },
  );

  const requiredCapabilities = await deriveRequiredCapabilities({ outDir, assets });
  const requiredSecrets = await bundleRequiredSecrets(projectRoot);

  const manifest = {
    schemaVersion: 1,
    frameworkVersion: curbVersion(),
    // The runner-to-bundle interface this bundle targets, and the Node major its vendored
    // native prebuilds are bound to. Both are compared before customer code is imported.
    // See declarations.ts, which states what each one does and does not claim.
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtime: { node: hostNodeMajor() },
    entrypoint,
    entryDigest: `sha256:${createHash("sha256").update(await readFile(workerOutFile)).digest("hex")}`,
    /** Artifact identity: SHA-256 over the canonical stream defined in bundle-digest.ts. */
    treeDigest: digest,
    externals,
    // Secret names come from the project's explicit package.json declaration; the
    // capability set is derived from the entry and shipped agent source.
    requiredSecrets,
    requiredCapabilities,
    // What the agent declares it measures (`defineAgent({ goals, experiments })`), sorted by
    // name, `[]` when none: a host reports goals per call and assigns each call its variants.
    goals: agentDeclarations.goals,
    experiments: agentDeclarations.experiments,
    // The hooks this build can run after a call (`defineAgent({ afterCall, afterEvaluation })`),
    // sorted, `[]` when none: a host starts a hook runner only for a hook named here.
    hooks: agentDeclarations.hooks,
    // What this artifact can run on. The vendored tree carries platform-specific
    // native prebuilds, so a bundle built here is not portable to another target --
    // a darwin-arm64 artifact inside a linux image dies on a missing binding with a
    // vendor stack trace, which reads as a framework bug rather than a packaging one.
    // A host that knows the pair can refuse before exec and say which two differ.
    target: buildTarget,
    // Claimed because the check above passed, not because it is written here.
    reproducible: true,
    assets,
    // Last, because it is by far the longest key and a human opening this file is
    // looking for one of the ones above.
    files: files.map(({ path, digest: fileDigest, size, mode }) => ({
      path,
      digest: fileDigest,
      size,
      // Additive to the specified shape. The digest above covers the owner-execute bit,
      // because a vendored native prebuild that loses it is broken and a digest that
      // could not see the difference would call the broken tree identical; recording it
      // here lets a verifier see what was hashed without re-stat-ing the tree.
      mode,
    })),
  };
  await writeFile(join(outDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  timer.mark("manifest", "resolve the externals, derive capabilities, write curb.bundle.json");

  // 6. Start it. A build that produces an unrunnable artifact must FAIL, not report a
  //    size and a file count -- both packaging bugs this step exists for shipped out of
  //    builds that reported success and were caught days later by a human. See
  //    verify.ts for why builds leave dependency ancestry and why the entrypoint comes
  //    from the manifest. Hosted builds isolate beside the attempt's dependency root,
  //    because their TMPDIR deliberately lives inside that root.
  //
  //    Skipped with the trace, because a bundle without its runtime tree cannot start
  //    and failing it would only report the missing tree the caller asked to skip.
  //
  //    A dependency-layer build is not started here either: it holds only the app layer.
  //    The deployment's readiness probe starts the assembled artifact instead.
  let verification: VerifyResult | undefined;
  if (!options.skipVerify && !options.skipTrace && !descriptor) {
    verification = await verifyArtifactStarts({
      outDir,
      isolationRoot: verificationIsolationRoot(process.env.CURB_PROFILE, traceBase),
      // What the project holds, so the artifact has to report the same set back. The
      // build cannot ask "did it render enough"; it can ask "did it render what I
      // packaged", which is the question the missing-markdown bug failed.
      expectedContextFiles: projectContextFiles(projectRoot),
    });
    // Four rows rather than one "verify". The starts are the interesting pair -- the
    // suspicion this instrumentation exists to test is that a runner cold start, paid
    // twice, dominates the build -- and the copy either side of them is file IO that
    // would otherwise be attributed to the runtime.
    const phases = verification.timings;
    timer.record(
      "isolate",
      phases.isolateMs,
      "ensure the artifact has no dependency-install ancestor",
    );
    timer.record("start", phases.startMs, "FIRST start: boot the artifact to the worker's start marker");
    timer.record("render", phases.renderMs, "SECOND start: the same entrypoint under curb-render-check");
    timer.record("cleanup", phases.cleanupMs, "remove the isolated copy");
  }

  // The layer records, last, so a build that failed verification leaves none behind.
  let layers: BuildResult["layers"];
  if (emitLayersDir) {
    const buildInputs = await collectBuildInputs({
      metafile: bundle.metafile,
      absWorkingDir: traceBase,
      projectRoot,
      frameworkRoot,
    });
    const dependencyFiles = files
      .map((file) => file.path)
      .filter((path) => !isAppLayerPath(path, layout));
    await writeLayerRecords(emitLayersDir, { dependencyFiles, buildInputs });
    timer.mark("layers", "record the dependency layer split and the build inputs");
    layers = { mode: "emit", dependencyFiles: dependencyFiles.length, buildInputs: buildInputs.inputs.length };
  } else if (descriptor) {
    layers = {
      mode: "hit",
      dependencyFiles: descriptor.files.length,
      buildInputs: descriptor.buildInputs.inputs.length,
    };
  }

  // Printed by every build, and printed here rather than returned only, because a
  // measurement that has to be asked for is one nobody has when they need it. It is the
  // last thing this function does: nothing above it is affected by it, and nothing it
  // reports reaches the artifact -- the tree is already written, hashed and manifested.
  const timings = timer.finish();
  console.log(formatBuildTimings(timings));

  return {
    outDir,
    entry: outFile,
    bundleBytes,
    tracedFiles,
    tracedBytes,
    mirroredPackages,
    treeDigest: digest,
    manifestFiles: files.length,
    verification,
    timings,
    warnings,
    layers,
  };
}
