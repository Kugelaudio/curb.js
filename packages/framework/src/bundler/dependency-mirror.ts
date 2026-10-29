import { cp, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BuildTarget } from "./build-target.js";

/**
 * Reproduce the installed dependency TREE in the artifact, not just the traced file set.
 *
 * The artifact's node_modules is assembled two ways, and both lose version information:
 *
 *   - the tracer copies the files it can reach by following STATIC imports. A require
 *     it cannot see -- lazily resolved, behind a runtime branch, in a subpath entry no
 *     traced file imports -- means the nested copy npm installed for that package is
 *     never mirrored;
 *   - externals are copied WHOLE, so every one of their files ships, including the ones
 *     the tracer never read, while only the dependency closure of their main entry is
 *     traced.
 *
 * Either way a package can end up in the artifact next to a version of its dependency
 * that it was never installed with: Node resolves upward, finds whatever some other
 * consumer hoisted to the top, and hands it over. The failure is silent at build time
 * and lands at import: `@livekit/agents` got `commander@7` instead of `@12`
 * (`Option.env is not a function`), and `@opentelemetry/exporter-trace-otlp-proto@0.54`
 * got `otlp-exporter-base@0.208`, whose `OTLPExporterNodeBase` no longer exists
 * (`Class extends value undefined is not a constructor or null`).
 *
 * Both are the same defect, so the repair is one rule rather than a list of packages:
 * for every package in the artifact, every dependency must resolve to the SAME version
 * it resolves to in the source install. Where it does not, the source-resolved package
 * is copied to its source-relative position, which is by construction the position
 * Node's upward walk will find first -- the same walk, over a subset of the same tree.
 *
 * What is deliberately NOT repaired: a dependency that is absent from the artifact
 * entirely, unless its dependent was copied whole. Absence is how the tracer prunes a
 * declared-but-never-required dependency, and filling those back in would undo the
 * pruning the trace exists to do. A whole-copied package has no such evidence -- all of
 * its files shipped, so any of its dependencies can be reached -- and its closure is
 * completed instead.
 */

export type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** A dependency edge whose artifact version does not match the source install. */
export type ParityViolation = {
  /** Artifact-relative directory of the package that owns the dependency. */
  dependent: string;
  dependency: string;
  sourceVersion: string;
  /** undefined when the dependency is absent from the artifact. */
  artifactVersion: string | undefined;
};

export type MirrorReport = {
  /** Dependency edges compared. */
  checked: number;
  /** Packages copied in to restore the installed version. */
  copied: Array<{ name: string; version: string; destination: string; reason: "version-mismatch" | "missing-from-whole-copy" }>;
};

export function readManifest(packageDir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    // A directory without a readable package.json is not a package. Callers treat this
    // as "nothing to check" rather than an error: node_modules holds .bin, .cache and
    // other non-package entries.
    return undefined;
  }
}

/**
 * Resolve `name` the way Node's require would from `fromDir`, but never above `root`.
 *
 * The bound is the whole point. `createRequire` inside an artifact that sits under a
 * real checkout happily resolves into the checkout's node_modules, so a package missing
 * from the artifact appears present and every packaging bug reads as green -- the same
 * false green that makes running an artifact in place worthless.
 */
export function resolveDependencyDir(
  fromDir: string,
  root: string,
  name: string,
): string | undefined {
  let current = resolve(fromDir);
  const stop = resolve(root);
  for (;;) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === stop) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Every package directory inside `root`.
 *
 * Walks ordinary directories, and inside a node_modules descends only into each
 * package's own node_modules -- npm never puts one anywhere else, and walking package
 * contents means walking the whole artifact file by file.
 */
export function listPackageDirs(root: string): string[] {
  const found: string[] = [];

  const readDirectories = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const collectPackages = (nodeModules: string): void => {
    for (const name of readDirectories(nodeModules)) {
      if (name === ".bin" || name === ".cache") continue;
      if (name.startsWith("@")) {
        for (const scoped of readDirectories(join(nodeModules, name))) {
          addPackage(join(nodeModules, name, scoped));
        }
        continue;
      }
      addPackage(join(nodeModules, name));
    }
  };

  const addPackage = (packageDir: string): void => {
    found.push(packageDir);
    const nested = join(packageDir, "node_modules");
    if (existsSync(nested)) collectPackages(nested);
  };

  const walk = (dir: string): void => {
    for (const name of readDirectories(dir)) {
      if (name === ".git") continue;
      if (name === "node_modules") {
        collectPackages(join(dir, name));
        continue;
      }
      walk(join(dir, name));
    }
  };

  walk(root);
  return found;
}

type Candidate = {
  /** Package directory inside the artifact. */
  artifactDir: string;
  /** The directory it was copied from, in the source install. */
  sourceDir: string;
  /** Whole-copied packages ship files the tracer never read, so their closure is completed. */
  whole: boolean;
};

export type MirrorOptions = {
  /** Artifact root. */
  outDir: string;
  /** Source install root the artifact mirrors (the tracer's base). */
  base: string;
  /** Artifact directories that were copied whole, not traced. */
  wholeCopied: string[];
  /** Native package payloads are restricted to this immutable artifact target. */
  target: BuildTarget;
};

export type PackageCopyOptions = {
  name: string;
  source: string;
  destination: string;
  target: BuildTarget;
};

/**
 * Copy a package whole while excluding native payloads for other targets.
 *
 * onnxruntime-node is unusual among the native dependencies: one npm package carries
 * CPU bindings for every supported OS and architecture. Shipping all of them contradicts
 * the target recorded in curb.bundle.json and can more than double a hosted artifact.
 */
export async function copyPackageForTarget(options: PackageCopyOptions): Promise<void> {
  const source = resolve(options.source);
  await cp(source, options.destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (candidate) => {
      const segments = relative(source, candidate).split(sep);
      let binIndex = -1;
      if (
        options.name === "onnxruntime-node" &&
        segments[0] === "bin" &&
        /^napi-v\d+$/.test(segments[1] ?? "")
      ) {
        binIndex = 0;
      } else {
        for (let index = 0; index + 3 < segments.length; index += 1) {
          if (
            segments[index] === "node_modules" &&
            segments[index + 1] === "onnxruntime-node" &&
            segments[index + 2] === "bin" &&
            /^napi-v\d+$/.test(segments[index + 3] ?? "")
          ) {
            binIndex = index + 2;
            break;
          }
        }
      }
      if (binIndex < 0 || segments.length <= binIndex + 2) return true;
      if (segments[binIndex + 2] !== options.target.os) return false;
      if (segments.length <= binIndex + 3) return true;
      return segments[binIndex + 3] === options.target.architecture;
    },
  });
}

/**
 * How many times the repair may sweep the artifact.
 *
 * A repair can turn another package's ABSENT dependency into a WRONG one: filling in a
 * whole-copied package's dependency at its hoisted position puts a package on a walk
 * that previously ran off the end. The next sweep sees a version mismatch and nests the
 * right copy, so the tree converges -- every copy is made at the path the source install
 * already has it, which can only move resolution toward the source. The bound is here so
 * a mistake in that reasoning ends as a build error rather than an infinite loop.
 */
const MAX_SWEEPS = 8;

/**
 * Compare every dependency edge in the artifact against the source install and copy in
 * what is missing or wrong. Throws if any edge still disagrees afterwards.
 */
export async function mirrorInstalledDependencies(options: MirrorOptions): Promise<MirrorReport> {
  const outDir = resolve(options.outDir);
  const base = resolve(options.base);
  const wholeCopied = options.wholeCopied.map((dir) => resolve(dir));
  const report: MirrorReport = { checked: 0, copied: [] };

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    const copiedBefore = report.copied.length;
    await repairSweep({ outDir, base, wholeCopied, target: options.target }, report);
    if (report.copied.length === copiedBefore) break;
  }

  const violations = findParityViolations({ outDir, base, wholeCopied });
  if (violations.length > 0) {
    throw new Error(
      `curb build: the artifact resolves dependencies to versions the project never ` +
        `installed, so it would fail at import:\n` +
        violations
          .map(
            (violation) =>
              `  - ${violation.dependent} requires ${violation.dependency}: installed ` +
              `${violation.sourceVersion}, artifact ` +
              `${violation.artifactVersion ?? "missing"}`,
          )
          .join("\n"),
    );
  }

  return report;
}

/**
 * One sweep: check every package now in the artifact, copying in replacements as it
 * goes. Copies are appended to `report` and their destinations join `wholeCopied`, so a
 * later sweep treats them the way it treats an external -- their files all shipped.
 */
async function repairSweep(
  options: { outDir: string; base: string; wholeCopied: string[]; target: BuildTarget },
  report: MirrorReport,
): Promise<void> {
  const { outDir, base, wholeCopied, target } = options;

  const isWholeCopied = (dir: string): boolean =>
    wholeCopied.some((root) => dir === root || dir.startsWith(root + sep));

  const queue: Candidate[] = listPackageDirs(outDir).map((artifactDir) => ({
    artifactDir,
    sourceDir: join(base, relative(outDir, artifactDir)),
    whole: isWholeCopied(artifactDir),
  }));

  const seen = new Set(queue.map((candidate) => candidate.artifactDir));

  while (queue.length > 0) {
    const candidate = queue.shift() as Candidate;
    const manifest = readManifest(candidate.artifactDir);
    if (!manifest) continue;
    // A package the artifact holds but the source install does not is not something we
    // can check against anything; it has no installed versions to reproduce.
    if (!existsSync(join(candidate.sourceDir, "package.json"))) continue;

    const required = Object.keys(manifest.dependencies ?? {});
    const optional = Object.keys(manifest.optionalDependencies ?? {});

    for (const name of [...required, ...optional]) {
      const sourceResolved = resolveDependencyDir(candidate.sourceDir, base, name);
      if (!sourceResolved) continue; // not installed here either; nothing to reproduce
      const sourceVersion = readManifest(sourceResolved)?.version;
      if (!sourceVersion) continue;

      const artifactResolved = resolveDependencyDir(candidate.artifactDir, outDir, name);
      const artifactVersion = artifactResolved ? readManifest(artifactResolved)?.version : undefined;
      report.checked += 1;
      if (artifactVersion === sourceVersion) continue;

      // Absent is the tracer having pruned a dependency nothing requires -- except from
      // a whole-copied package, whose unread files can require anything it declares.
      // An absent OPTIONAL dependency is never filled in: optional means the dependent
      // handles absence, which is exactly what the trace observed.
      const missing = artifactVersion === undefined;
      if (missing && (!candidate.whole || optional.includes(name))) continue;

      const destination = mirrorDestination({
        outDir,
        base,
        sourceResolved,
        dependentDir: candidate.artifactDir,
        name,
      });
      await mkdir(dirname(destination), { recursive: true });
      await copyPackageForTarget({ name, source: sourceResolved, destination, target });
      report.copied.push({
        name,
        version: sourceVersion,
        destination: relative(outDir, destination),
        reason: missing ? "missing-from-whole-copy" : "version-mismatch",
      });

      // The copy shipped whole, so its own closure has to be completed too -- this is
      // where `@livekit/agents` -> `@opentelemetry/core` -> its dependencies comes from.
      wholeCopied.push(destination);
      if (!seen.has(destination)) {
        seen.add(destination);
        queue.push({ artifactDir: destination, sourceDir: sourceResolved, whole: true });
      }
    }
  }
}

/**
 * Where a replacement package goes.
 *
 * Its source-relative position, so the artifact stays a subset of the source tree and
 * Node's upward walk reproduces the source's resolution. A source that resolves outside
 * the mirrored tree cannot be placed that way, so it is nested directly under the
 * dependent, which wins resolution unconditionally.
 */
function mirrorDestination(options: {
  outDir: string;
  base: string;
  sourceResolved: string;
  dependentDir: string;
  name: string;
}): string {
  const fromBase = relative(options.base, options.sourceResolved);
  if (fromBase.startsWith("..")) return join(options.dependentDir, "node_modules", options.name);
  return join(options.outDir, fromBase);
}

/** Every dependency edge whose artifact version disagrees with the source install. */
export function findParityViolations(options: Omit<MirrorOptions, "target">): ParityViolation[] {
  const outDir = resolve(options.outDir);
  const base = resolve(options.base);
  const wholeCopied = options.wholeCopied.map((dir) => resolve(dir));
  const violations: ParityViolation[] = [];

  for (const artifactDir of listPackageDirs(outDir)) {
    const manifest = readManifest(artifactDir);
    if (!manifest) continue;
    const sourceDir = join(base, relative(outDir, artifactDir));
    const whole = wholeCopied.some((root) => artifactDir === root || artifactDir.startsWith(root + sep));
    if (!existsSync(join(sourceDir, "package.json"))) continue;

    const optional = Object.keys(manifest.optionalDependencies ?? {});
    for (const name of [...Object.keys(manifest.dependencies ?? {}), ...optional]) {
      const sourceResolved = resolveDependencyDir(sourceDir, base, name);
      if (!sourceResolved) continue;
      const sourceVersion = readManifest(sourceResolved)?.version;
      if (!sourceVersion) continue;
      const artifactResolved = resolveDependencyDir(artifactDir, outDir, name);
      const artifactVersion = artifactResolved ? readManifest(artifactResolved)?.version : undefined;
      if (artifactVersion === sourceVersion) continue;
      if (artifactVersion === undefined && (!whole || optional.includes(name))) continue;
      violations.push({
        dependent: relative(outDir, artifactDir),
        dependency: name,
        sourceVersion,
        artifactVersion,
      });
    }
  }

  return violations;
}
