/**
 * A browser project's `package-lock.json` (lockfile v3), kept the way npm would keep it, so
 * the project deploys through the ordinary build (`npm ci` against this lockfile) exactly as
 * it ran in the page. A package is placed where npm's resolution finds it: a dependency
 * resolves at the nearest `node_modules/<name>` walking up from its dependent; a version
 * that satisfies is reused, one that does not is nested under the dependent, and a name
 * nobody has yet goes to the root.
 *
 * Pure: no fetching. `npm-install.ts` asks it where each package goes and records what it
 * installed.
 */

import semver from "semver";

/** One `packages` entry, as npm writes it (only the fields this module reads or writes). */
export type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  [field: string]: unknown;
};

export type Lockfile = {
  name?: string;
  version?: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, LockEntry>;
};

/** A lockfile key's package name: `node_modules/a/node_modules/@s/b` is `@s/b`. */
export function nameOf(path: string): string {
  const at = path.lastIndexOf("node_modules/");
  return path.slice(at + "node_modules/".length);
}

/** The lockfile key of the package `path` lives in (`""` for the root). */
function parentOf(path: string): string {
  if (path === "") return "";
  const at = path.lastIndexOf("/node_modules/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Where `name` resolves from the package at `from`: the nearest key that holds it, or null. */
export function resolveFrom(lock: Lockfile, from: string, name: string): string | null {
  for (let directory = from; ; directory = parentOf(directory)) {
    const key = directory === "" ? `node_modules/${name}` : `${directory}/node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (directory === "") return null;
  }
}

export type Placement =
  /** A package already there satisfies the range: reuse it. */
  | { reuse: string }
  /** Install the package at this key. */
  | { place: string };

/** Where `name@range`, a dependency of the package at `from`, goes. */
export function placement(lock: Lockfile, from: string, name: string, range: string): Placement {
  const found = resolveFrom(lock, from, name);
  if (found) {
    const version = lock.packages[found]!.version;
    if (version && (range === "*" || range === "" || satisfiesRange(version, range))) return { reuse: found };
    // A conflicting version nearer the root: this dependent gets its own copy.
    return { place: from === "" ? `node_modules/${name}` : `${from}/node_modules/${name}` };
  }
  return { place: `node_modules/${name}` };
}

function satisfiesRange(version: string, range: string): boolean {
  // A dist-tag or URL range cannot be checked against a version: treat it as not satisfied,
  // so the dependent gets exactly what it asked for.
  return semver.validRange(range) !== null && semver.satisfies(version, range, { includePrerelease: true });
}

/** The fields of a registry manifest a lockfile entry keeps. */
export type RegistryManifest = {
  name: string;
  version: string;
  dist: { tarball: string; integrity?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: unknown;
  engines?: unknown;
  os?: unknown;
  cpu?: unknown;
  hasInstallScript?: boolean;
  license?: string;
};

/** The entry npm writes for a registry package. */
export function entryFor(manifest: RegistryManifest, flags: { optional?: boolean } = {}): LockEntry {
  const entry: LockEntry = { version: manifest.version, resolved: manifest.dist.tarball, integrity: manifest.dist.integrity };
  for (const field of [
    "license",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "engines",
    "os",
    "cpu",
    "hasInstallScript",
  ] as const) {
    const value = manifest[field];
    if (value !== undefined && !(typeof value === "object" && value !== null && Object.keys(value).length === 0)) {
      (entry as Record<string, unknown>)[field] = value;
    }
  }
  if (flags.optional) entry.optional = true;
  return entry;
}

/** The dependencies npm installs for an entry: regular, optional, and peers that are not optional. */
export function dependenciesOf(entry: LockEntry): Array<{ name: string; range: string; optional: boolean }> {
  const out: Array<{ name: string; range: string; optional: boolean }> = [];
  for (const [name, range] of Object.entries(entry.dependencies ?? {})) out.push({ name, range, optional: false });
  for (const [name, range] of Object.entries(entry.optionalDependencies ?? {})) out.push({ name, range, optional: true });
  for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
    if (!entry.peerDependenciesMeta?.[name]?.optional) out.push({ name, range, optional: false });
  }
  return out;
}

/**
 * The package at `key` is now needed by the project's production dependencies: clear the
 * flags that would let `npm ci --omit=dev` (or `--omit=optional`) skip it, along with
 * everything it depends on.
 */
export function markRequired(lock: Lockfile, key: string): void {
  const seen = new Set<string>();
  const visit = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    const entry = lock.packages[at];
    if (!entry) return;
    if (!(entry.dev || entry.optional || entry.devOptional || entry.peer)) return;
    delete entry.dev;
    delete entry.optional;
    delete entry.devOptional;
    delete entry.peer;
    for (const dependency of dependenciesOf(entry)) {
      if (dependency.optional) continue;
      const found = resolveFrom(lock, at, dependency.name);
      if (found) visit(found);
    }
  };
  visit(key);
}

/** The keys reachable from the root's dependencies; a lockfile keeps only these. */
export function reachable(lock: Lockfile): Set<string> {
  const root = lock.packages[""] ?? {};
  const seen = new Set<string>();
  const stack: Array<{ from: string; name: string }> = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const name of Object.keys(root[field] ?? {})) stack.push({ from: "", name });
  }
  while (stack.length > 0) {
    const { from, name } = stack.pop()!;
    const key = resolveFrom(lock, from, name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = lock.packages[key]!;
    for (const dependency of dependenciesOf(entry)) stack.push({ from: key, name: dependency.name });
    // A link's target is a package of its own (a workspace member), reached through it.
    if (entry.link && typeof entry.resolved === "string") seen.add(entry.resolved);
  }
  return seen;
}

/** Drop every package no root dependency reaches; the keys removed. */
export function prune(lock: Lockfile): string[] {
  const keep = reachable(lock);
  const removed = Object.keys(lock.packages).filter((key) => key !== "" && !keep.has(key));
  for (const key of removed) delete lock.packages[key];
  return removed;
}

export function parseLockfile(text: string): Lockfile {
  const lock = JSON.parse(text) as Lockfile;
  if (lock.lockfileVersion < 2 || typeof lock.packages !== "object") {
    throw new Error(`package-lock.json is lockfile version ${lock.lockfileVersion}; the browser keeps version 2 or 3`);
  }
  return lock;
}

export function serializeLockfile(lock: Lockfile): string {
  const packages = Object.fromEntries(Object.entries(lock.packages).sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : 1)));
  return `${JSON.stringify({ ...lock, packages }, null, 2)}\n`;
}
