import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Metafile } from "esbuild";
import { compareBytes, MANIFEST_FILENAME, type BundleFile } from "./bundle-digest.js";
import { readManifest, resolveDependencyDir } from "./dependency-mirror.js";
import type { BundleExternal } from "./externals.js";

/**
 * The layer split of a hosted build (layer contract L1, L2, L3).
 *
 * A hosted artifact is two layers. The APP layer is what the agent's own code reaches:
 * `curb.bundle.json`, `assets/**` and the emitted entry. Everything else -- the
 * externals copied whole, the traced runtime files, the mirrored versions -- is the
 * DEPENDENCY layer, and it is a function of the install alone, not of the agent: the trace
 * is seeded from an isolated copy of the bundle that cannot resolve node_modules, plus the
 * externals from the framework's location (see the trace comments in index.ts).
 *
 * That independence is what lets a builder cache the dependency layer. `--emit-layers`
 * records the split and the set of files esbuild needs to rebuild the app layer (the BUILD
 * INPUTS); `--dependency-layer` rebuilds only the app layer against a node_modules that
 * holds nothing but those inputs, and layer-escape.ts refuses whenever the bundle reaches
 * past the record. Nothing here loads the tracer: a hit-mode build must never pay for it.
 */

/** Version of `dependency-files.json`, `build-inputs.json` and the descriptor read below. */
export const LAYER_FORMAT = 1;
export const DEPENDENCY_FILES_FILENAME = "dependency-files.json";
export const BUILD_INPUTS_FILENAME = "build-inputs.json";

/** A bare import from a project or generated file, as esbuild resolved it. */
export type BuildEdge = {
  /** Project-root-relative POSIX path of the importing file. */
  importer: string;
  /** The specifier as written. */
  specifier: string;
  /** esbuild's import kind: import-statement, require-call, dynamic-import, require-resolve. */
  kind: string;
  /** Project-root-relative path of the resolved file, or the specifier for an external. */
  resolved: string;
};

/** `build-inputs.json` (L1), and `buildInputs` in the descriptor (L3). */
export type BuildInputs = {
  format: typeof LAYER_FORMAT;
  inputs: string[];
  edges: BuildEdge[];
  recordedExternals: string[];
};

/** The parts of descriptor.json (L3) this build reads. The rest is the builder's. */
export type DependencyLayerDescriptor = {
  /** `curb.bundle.json` `files[]` entries of the dependency layer. */
  files: BundleFile[];
  /** `curb.bundle.json` `externals[]`, copied from the full build that produced the layer. */
  externals: BundleExternal[];
  buildInputs: BuildInputs;
};

const toPosix = (path: string): string => path.split(sep).join("/");
const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareBytes);

/** Identity of an edge: all four fields, so a changed resolution is a different edge. */
export const edgeKey = (edge: BuildEdge): string =>
  JSON.stringify([edge.importer, edge.specifier, edge.kind, edge.resolved]);

/**
 * The per-agent MCP server list. The framework reads it from `process.cwd()`
 * (src/mcp/servers-store.ts), so it ships beside the project's position in the bundle. It is
 * agent configuration, so it is app layer: the assets stage copies it and the trace ignores it.
 */
export const MCP_SERVERS_FILENAME = "mcp.servers.json";

/**
 * Where the app layer sits in a bundle. Both are POSIX paths relative to the trace base:
 * `entryHome` is the framework root (`node_modules/curb` in a hosted build) and
 * `projectHome` the project root (`""` in a hosted build).
 */
export type AppLayerLayout = { entryHome: string; projectHome: string };

/** The bundle path of `mcp.servers.json`: `mcp.servers.json` itself in a hosted build. */
export const mcpServersPath = (projectHome: string): string =>
  projectHome === "" ? MCP_SERVERS_FILENAME : `${projectHome}/${MCP_SERVERS_FILENAME}`;

/** Whether a bundle-root-relative path is in the app layer (L2). */
export function isAppLayerPath(path: string, layout: AppLayerLayout): boolean {
  const entryDir = layout.entryHome === "" ? "entry" : `${layout.entryHome}/entry`;
  return (
    path === MANIFEST_FILENAME ||
    path.startsWith("assets/") ||
    path === mcpServersPath(layout.projectHome) ||
    path === `${entryDir}/worker.mjs`
  );
}

/** What one esbuild metafile says about the bundle's relationship to node_modules. */
export type MetafileAnalysis = {
  /** Project-root-relative paths of every input with a node_modules segment. */
  nodeModulesReads: string[];
  /** The subset inside project source, outside the project's own node_modules. */
  sourceNodeModules: string[];
  /** Bare imports from project and generated files. */
  edges: BuildEdge[];
  /** Bare, non-builtin specifiers esbuild left external, from every input. */
  externals: string[];
};

/**
 * A bare specifier: a package name (or `#import`), not a relative or absolute path, not a
 * URL-style scheme such as `node:`, and not a Node builtin. Builtins are excluded because
 * nothing in node_modules can satisfy or change one, so they cannot move either layer.
 */
function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/") || isAbsolute(specifier)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false;
  return !isBuiltin(specifier);
}

/**
 * An input key as an absolute path. Keys are relative to esbuild's working directory; a
 * plugin namespace (`curb-raw:src/agent/agent.tsx`) prefixes the path its plugin returned,
 * which raw-plugin.ts makes relative to that same directory.
 */
function inputLocation(key: string, absWorkingDir: string): string {
  const namespaced = /^[a-z][a-z0-9-]*:(.+)$/.exec(key);
  return resolve(absWorkingDir, namespaced ? namespaced[1] : key);
}

function sortEdges(edges: Iterable<BuildEdge>): BuildEdge[] {
  return [...edges].sort(
    (left, right) =>
      compareBytes(left.importer, right.importer) ||
      compareBytes(left.specifier, right.specifier) ||
      compareBytes(left.kind, right.kind) ||
      compareBytes(left.resolved, right.resolved),
  );
}

/**
 * Classify every input and import of a metafile against the project root.
 *
 * Paths are project-root-relative because that is how a hosted builder lays the inputs
 * back out. In a workspace, hoisted dependencies sit above the project and appear as
 * `../../node_modules/...`; framework source outside both is neither a read nor an edge.
 */
export function analyzeMetafile(
  metafile: Metafile,
  where: { absWorkingDir: string; projectRoot: string },
): MetafileAnalysis {
  const projectRoot = resolve(where.projectRoot);
  const fromProject = (key: string): string =>
    toPosix(relative(projectRoot, inputLocation(key, where.absWorkingDir)));

  const reads = new Set<string>();
  const sourceNodeModules = new Set<string>();
  const externals = new Set<string>();
  const edges = new Map<string, BuildEdge>();

  for (const [key, entry] of Object.entries(metafile.inputs)) {
    const path = fromProject(key);
    const segments = path.split("/");
    const inProject = segments[0] !== ".." && !isAbsolute(path);
    const inNodeModules = segments.includes("node_modules");
    if (inNodeModules) {
      reads.add(path);
      if (inProject && segments[0] !== "node_modules") sourceNodeModules.add(path);
    }

    for (const imported of entry.imports) {
      if (imported.external && isBareSpecifier(imported.path)) externals.add(imported.path);
      if (!inProject || inNodeModules) continue;
      // esbuild reports the specifier as written in `original` only when it resolved it;
      // an external's `path` is already the specifier.
      const specifier = imported.original ?? imported.path;
      if (!isBareSpecifier(specifier)) continue;
      const edge: BuildEdge = {
        importer: path,
        specifier,
        kind: imported.kind,
        resolved: imported.external ? imported.path : fromProject(imported.path),
      };
      edges.set(edgeKey(edge), edge);
    }
  }

  return {
    nodeModulesReads: sortedUnique(reads),
    sourceNodeModules: sortedUnique(sourceNodeModules),
    edges: sortEdges(edges.values()),
    externals: sortedUnique(externals),
  };
}

/**
 * Every `package.json` from a node_modules file's directory up to its package root.
 *
 * esbuild consults these without listing them as inputs: the root's `exports`/`main` to
 * resolve, and the nearest one's `type` and `sideEffects` to compile. A hit-mode install
 * missing one would resolve or tree-shake differently.
 */
function owningPackageManifests(projectRoot: string, read: string): string[] {
  const segments = read.split("/");
  const last = segments.lastIndexOf("node_modules");
  const name = segments[last + 1];
  if (last < 0 || name === undefined) return [];
  const rootLength = last + (name.startsWith("@") ? 3 : 2);
  const found: string[] = [];
  for (let length = segments.length - 1; length >= rootLength; length -= 1) {
    const candidate = [...segments.slice(0, length), "package.json"].join("/");
    if (existsSync(join(projectRoot, candidate))) found.push(candidate);
  }
  return found;
}

/** Every file of a package, without its nested node_modules. */
async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(absolute);
      } else {
        files.push(absolute);
      }
    }
  };
  await walk(root);
  return files;
}

/**
 * The packages `curb build` itself runs on: `tsx` for the bin shim and `esbuild` for the
 * bundler. The esbuild version is part of the output -- its emitted runtime helpers differ
 * between versions -- so it must be the one the framework resolves, not whichever one is
 * hoisted highest.
 */
const BUILD_TOOLCHAIN = ["tsx", "esbuild"];

/**
 * Every file of the toolchain closure, resolved the way Node resolves it from the framework
 * at build time: each package from its dependent's directory upward, with its dependencies
 * and the optional ones this install has (esbuild's platform binary package among them).
 */
async function toolchainFiles(frameworkRoot: string): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];
  const enqueue = (from: string, name: string, optional: boolean): void => {
    const dir = resolveDependencyDir(from, parse(from).root, name);
    if (dir) {
      queue.push(dir);
      return;
    }
    // An optional dependency npm did not install is one this platform does not use.
    if (optional) return;
    throw new Error(
      `curb build --emit-layers: ${name} is not resolvable from ${from}.\n` +
        `  The build inputs must be able to run curb build on their own; recording a set ` +
        `that cannot would only move this failure into the cached build.`,
    );
  };

  for (const name of BUILD_TOOLCHAIN) enqueue(frameworkRoot, name, false);
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (visited.has(dir)) continue;
    visited.add(dir);
    files.push(...(await listPackageFiles(dir)));
    const manifest = readManifest(dir);
    if (!manifest) {
      throw new Error(`curb build --emit-layers: ${join(dir, "package.json")} is not readable JSON.`);
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) enqueue(dir, name, false);
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) enqueue(dir, name, true);
  }
  return files;
}

/**
 * The build-input set (L1): what esbuild read from node_modules, every owning package.json,
 * the whole curb package -- which a hit-mode build runs from, not only bundles -- and the
 * toolchain closure that runs it. Enough, on its own, to run a hit-mode build.
 */
export async function collectBuildInputs(options: {
  metafile: Metafile;
  absWorkingDir: string;
  projectRoot: string;
  frameworkRoot: string;
}): Promise<BuildInputs> {
  const projectRoot = resolve(options.projectRoot);
  const frameworkRoot = resolve(options.frameworkRoot);
  const analysis = analyzeMetafile(options.metafile, options);
  const inputs = new Set(analysis.nodeModulesReads);
  for (const read of analysis.nodeModulesReads) {
    for (const manifest of owningPackageManifests(projectRoot, read)) inputs.add(manifest);
  }
  for (const file of [...(await listPackageFiles(frameworkRoot)), ...(await toolchainFiles(frameworkRoot))]) {
    inputs.add(toPosix(relative(projectRoot, file)));
  }
  return {
    format: LAYER_FORMAT,
    inputs: sortedUnique(inputs),
    edges: analysis.edges,
    recordedExternals: analysis.externals,
  };
}

/** `<dir>/dependency-files.json` and `<dir>/build-inputs.json`, exactly as L1 shapes them. */
export async function writeLayerRecords(
  dir: string,
  records: { dependencyFiles: readonly string[]; buildInputs: BuildInputs },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const dependencyFiles = { format: LAYER_FORMAT, files: records.dependencyFiles };
  await writeFile(join(dir, DEPENDENCY_FILES_FILENAME), `${JSON.stringify(dependencyFiles)}\n`, "utf8");
  await writeFile(join(dir, BUILD_INPUTS_FILENAME), `${JSON.stringify(records.buildInputs)}\n`, "utf8");
}

/**
 * Trace files reachable ONLY through the isolated bundle copy.
 *
 * The dependency layer may be reused for different agent code only if agent code cannot
 * add to it. The bundle copy is the one trace seed that carries agent code, so any file
 * the tracer reached from it and from no other seed would be missing from a reused layer.
 * `reasons` is nft's provenance map, keyed like `fileList`.
 */
export function traceFilesOnlyFromBundleCopy(
  reasons: ReadonlyMap<string, { parents: ReadonlySet<string>; type?: readonly string[] }>,
  fileList: Iterable<string>,
  isBundleCopy: (file: string) => boolean,
  isExternalOwned: (file: string) => boolean = () => false,
): string[] {
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [file, reason] of reasons) {
    // nft retains all reasons for a file. An explicit external seed that the bundled app
    // also imports therefore has a parent AND the `initial` reason; parent-count alone
    // misclassifies its complete closure as agent-only (Juno's Silero seed is exactly this).
    if (reason.parents.size === 0 || reason.type?.includes("initial") || isExternalOwned(file)) {
      if (!isBundleCopy(file)) roots.push(file);
    }
    for (const parent of reason.parents) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(file);
      else children.set(parent, [file]);
    }
  }

  const reached = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    for (const child of children.get(queue.pop() as string) ?? []) {
      if (reached.has(child)) continue;
      reached.add(child);
      queue.push(child);
    }
  }
  return [...fileList].filter((file) => !isBundleCopy(file) && !reached.has(file)).sort(compareBytes);
}

/** Lowercase hex SHA-256 of each file, in order. */
export async function digestFiles(paths: readonly string[]): Promise<string[]> {
  return Promise.all(
    paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")),
  );
}

/**
 * Refuse an `--emit-layers` build whose dependency stages wrote into the app path set.
 *
 * By construction the dependency files are every non-app path, so the two sets cannot
 * overlap by NAME. They can overlap by AUTHOR: a traced, copied or mirrored file landing on
 * an entry, under assets/, on mcp.servers.json or on the manifest would be shipped by the
 * reused dependency layer and silently shadowed by the app layer.
 */
export async function assertDependencyStagesSparedAppLayer(options: {
  outDir: string;
  entries: readonly string[];
  entryDigests: readonly string[];
  /** Bundle-relative app paths no dependency stage may create. */
  reserved: readonly string[];
}): Promise<void> {
  const placed = options.reserved.filter((name) => existsSync(join(options.outDir, name)));
  const after = await digestFiles(options.entries);
  const rewritten = options.entries
    .filter((_, index) => after[index] !== options.entryDigests[index])
    .map((entry) => toPosix(relative(options.outDir, entry)));
  const intruders = [...placed, ...rewritten];
  if (intruders.length > 0) {
    throw new Error(
      `curb build --emit-layers: the dependency stages wrote into the app layer: ` +
        `${intruders.join(", ")}.\n` +
        `  The app layer is curb.bundle.json, assets/**, mcp.servers.json and the emitted entry. A ` +
        `dependency file at one of those paths would break the disjoint split, so no layer ` +
        `records were written.`,
    );
  }
}

/** Refuse a layered build whose esbuild run emitted anything but the entry. */
export function assertBundleOutputsAreEntries(outputs: readonly string[], entries: readonly string[]): void {
  const extra = outputs.filter((output) => !entries.includes(output));
  if (extra.length > 0) {
    throw new Error(
      `curb build: esbuild emitted ${extra.join(", ")} besides the entry.\n` +
        `  A layered build ships exactly worker.mjs as its bundle; any other ` +
        `emitted file would belong to neither layer.`,
    );
  }
}

/**
 * The manifest's `files[]` for a hit-mode build: the app tree this build wrote, plus the
 * descriptor's dependency-layer entries, byte-sorted as `collectBundleFiles` sorts them.
 */
export function mergeDependencyLayerFiles(
  appFiles: readonly BundleFile[],
  layerFiles: readonly BundleFile[],
  layout: AppLayerLayout,
): BundleFile[] {
  const stray = appFiles.find((file) => !isAppLayerPath(file.path, layout));
  if (stray) {
    throw new Error(
      `curb build --dependency-layer: ${stray.path} was written outside the app layer.\n` +
        `  A dependency-layer build writes only curb.bundle.json, assets/**, mcp.servers.json ` +
        `and the entry; the dependency files come from the descriptor.`,
    );
  }
  const seen = new Set(appFiles.map((file) => file.path));
  for (const file of layerFiles) {
    if (isAppLayerPath(file.path, layout)) {
      throw new Error(
        `curb build --dependency-layer: the descriptor lists ${file.path}, which belongs to ` +
          `the app layer.\n  The descriptor was not produced from this framework's layer split.`,
      );
    }
    if (seen.has(file.path)) {
      throw new Error(`curb build --dependency-layer: the descriptor lists ${file.path} twice.`);
    }
    seen.add(file.path);
  }
  return [...appFiles, ...layerFiles].sort((left, right) => compareBytes(left.path, right.path));
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Read descriptor.json (L3): the fields a hit-mode build needs, validated and rebuilt in the
 * manifest's own key order, so the manifest's bytes do not depend on how the builder
 * serialized them.
 */
export async function readDependencyLayerDescriptor(path: string): Promise<DependencyLayerDescriptor> {
  const fail: (what: string) => never = (what) => {
    throw new Error(
      `curb build: ${path} is not a dependency layer descriptor this build can use: ${what}.\n` +
        `  The hosted builder writes it from a verified --emit-layers build (format ${LAYER_FORMAT}).`,
    );
  };

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(raw)) return fail("it is not a JSON object");
  if (raw.format !== LAYER_FORMAT) fail(`format is ${JSON.stringify(raw.format)}, want ${LAYER_FORMAT}`);

  if (!Array.isArray(raw.files)) fail("files is not an array");
  const files = (raw.files as unknown[]).map((entry, index): BundleFile => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path === "" ||
      typeof entry.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.digest) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.mode !== "644" && entry.mode !== "755")
    ) {
      return fail(`files[${index}] is not a {path, digest, size, mode} manifest entry`);
    }
    return {
      path: entry.path,
      digest: entry.digest as `sha256:${string}`,
      size: entry.size as number,
      mode: entry.mode,
    };
  });

  if (!Array.isArray(raw.externals)) fail("externals is not an array");
  const externals = (raw.externals as unknown[]).map((entry, index): BundleExternal => {
    if (
      !isRecord(entry) ||
      typeof entry.specifier !== "string" ||
      entry.specifier === "" ||
      typeof entry.version !== "string" ||
      entry.version === "" ||
      typeof entry.native !== "boolean"
    ) {
      return fail(`externals[${index}] is not a {specifier, version, native} manifest entry`);
    }
    return { specifier: entry.specifier, version: entry.version, native: entry.native };
  });

  const inputs = raw.buildInputs;
  if (!isRecord(inputs) || inputs.format !== LAYER_FORMAT) fail(`buildInputs is not format ${LAYER_FORMAT}`);
  const record = inputs as JsonRecord;
  if (!isStringArray(record.inputs)) fail("buildInputs.inputs is not an array of paths");
  if (!isStringArray(record.recordedExternals)) fail("buildInputs.recordedExternals is not an array");
  if (!Array.isArray(record.edges)) fail("buildInputs.edges is not an array");
  const edges = (record.edges as unknown[]).map((edge, index): BuildEdge => {
    if (
      !isRecord(edge) ||
      typeof edge.importer !== "string" ||
      typeof edge.specifier !== "string" ||
      typeof edge.kind !== "string" ||
      typeof edge.resolved !== "string"
    ) {
      return fail(`buildInputs.edges[${index}] is not an {importer, specifier, kind, resolved} edge`);
    }
    return { importer: edge.importer, specifier: edge.specifier, kind: edge.kind, resolved: edge.resolved };
  });

  return {
    files,
    externals,
    buildInputs: {
      format: LAYER_FORMAT,
      inputs: record.inputs as string[],
      edges,
      recordedExternals: record.recordedExternals as string[],
    },
  };
}
