/**
 * `npm install <package>` and `npm uninstall <package>` in the page, for a project kept in
 * the browser: versions come from the npm registry, which answers browsers (CORS), each
 * tarball is checked against the integrity the registry (or the lockfile) publishes, unpacked,
 * and its code files written into the project's `node_modules/` (`project-compile.ts`
 * resolves imports there).
 *
 * `package.json` and `package-lock.json` change as npm would change them (`lockfile.ts`
 * places every package where npm's resolution puts it), so the project deploys through the
 * ordinary build, whose `npm ci` installs what the page ran.
 *
 * Packages the browser runtime provides itself (`RUNTIME_MODULES`: curb, react, zod) are
 * recorded in the lockfile but never unpacked: the project binds to the runtime's one
 * instance of each. Optional dependencies are recorded too and not unpacked (they are
 * nearly always another platform's binaries); an import of one fails as a missing optional
 * module does under Node.
 */

import semver from "semver";
import {
  dependenciesOf,
  entryFor,
  markRequired,
  nameOf,
  parseLockfile,
  placement,
  prune,
  resolveFrom,
  serializeLockfile,
  type LockEntry,
  type Lockfile,
  type RegistryManifest,
} from "./lockfile.js";
import { RUNTIME_MODULES } from "./runtime-modules.js";

const REGISTRY = "https://registry.npmjs.org";
/** The files compiling needs; types, maps, docs and binaries stay out of the browser. */
const CODE = /\.(m?js|cjs|json)$/;
/** The lockfile key of the package an installed file belongs to: its deepest `node_modules/<name>`. */
const PACKAGE_KEY = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+)\//;

export class NpmInstallError extends Error {
  override readonly name = "NpmInstallError";
}

/** What an install or uninstall changes in the project: files to write and files to delete. */
export type ProjectChange = { writes: Map<string, string>; deletes: string[] };

type Packument = { "dist-tags": Record<string, string>; versions: Record<string, RegistryManifest> };

function registryUrl(name: string): string {
  return `${REGISTRY}/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;
}

/** `name`, `name@range`, `@scope/name@range`. */
export function parseSpec(spec: string): { name: string; range: string } {
  const at = spec.indexOf("@", 1);
  return at === -1 ? { name: spec, range: "latest" } : { name: spec.slice(0, at), range: spec.slice(at + 1) || "latest" };
}

const packuments = new Map<string, Promise<Packument>>();

function packument(name: string): Promise<Packument> {
  let pending = packuments.get(name);
  if (!pending) {
    pending = fetch(registryUrl(name), { headers: { accept: "application/vnd.npm.install-v1+json" } }).then(async (response) => {
      if (response.status === 404) throw new NpmInstallError(`npm has no package named "${name}".`);
      if (!response.ok) throw new NpmInstallError(`The npm registry answered HTTP ${response.status} for "${name}".`);
      return (await response.json()) as Packument;
    });
    // A failed lookup is not remembered: the next install asks again.
    pending.catch(() => packuments.delete(name));
    packuments.set(name, pending);
  }
  return pending;
}

async function resolveManifest(name: string, range: string): Promise<RegistryManifest> {
  const found = await packument(name);
  const version = found["dist-tags"][range] ?? semver.maxSatisfying(Object.keys(found.versions), range);
  const manifest = version ? found.versions[version] : undefined;
  if (!manifest) throw new NpmInstallError(`No version of "${name}" satisfies "${range}".`);
  return manifest;
}

async function verified(what: string, integrity: string | undefined, bytes: ArrayBuffer): Promise<void> {
  const sha512 = integrity?.split(/\s+/).find((entry) => entry.startsWith("sha512-"));
  if (!sha512) throw new NpmInstallError(`${what} has no sha512 integrity to check its tarball against.`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  if (`sha512-${btoa(binary)}` !== sha512) throw new NpmInstallError(`${what}: the tarball does not match its published integrity.`);
}

/** The files of a gzipped tar, by path inside it. */
async function untar(gzipped: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const tar = new Uint8Array(await new Response(new Blob([gzipped]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const text = new TextDecoder();
  const field = (offset: number, length: number) => text.decode(tar.subarray(offset, offset + length)).replace(/\0[\s\S]*$/, "");
  const files = new Map<string, Uint8Array>();
  let longName: string | null = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = field(offset, 100);
    if (!name) break;
    const size = parseInt(field(offset + 124, 12).trim() || "0", 8);
    const type = field(offset + 156, 1) || "0";
    const prefix = field(offset + 345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = /\d+ path=([^\n]*)\n/.exec(text.decode(body))?.[1] ?? null;
    } else if (type === "L") {
      longName = text.decode(body).replace(/\0[\s\S]*$/, "");
    } else {
      if (type === "0" || type === "7") files.set(longName ?? (prefix ? `${prefix}/${name}` : name), body);
      longName = null;
    }
  }
  return files;
}

/** A new lockfile for a project that has none. */
function freshLockfile(packageJson: Record<string, unknown>): Lockfile {
  const root: LockEntry = { name: packageJson.name as string | undefined };
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    if (packageJson[field]) root[field] = { ...(packageJson[field] as Record<string, string>) };
  }
  return { name: packageJson.name as string | undefined, lockfileVersion: 3, requires: true, packages: { "": root } };
}

/** One install or uninstall over the project's files. */
class Session {
  readonly change: ProjectChange = { writes: new Map(), deletes: [] };
  readonly lock: Lockfile;
  readonly packageJson: Record<string, unknown> & { dependencies?: Record<string, string> };

  constructor(
    private readonly files: ReadonlyMap<string, string>,
    private readonly log: (line: string) => void,
  ) {
    this.packageJson = JSON.parse(files.get("package.json") ?? "{}");
    const lockText = files.get("package-lock.json");
    this.lock = lockText ? parseLockfile(lockText) : freshLockfile(this.packageJson);
  }

  /** The page holds this package's files (written now or before). */
  private present(key: string): boolean {
    return this.change.writes.has(`${key}/package.json`) || this.files.has(`${key}/package.json`);
  }

  private async unpack(key: string, what: string, tarball: string, integrity: string | undefined): Promise<void> {
    const response = await fetch(tarball);
    if (!response.ok) throw new NpmInstallError(`Downloading ${what} answered HTTP ${response.status}.`);
    const bytes = await response.arrayBuffer();
    await verified(what, integrity, bytes);
    const decoder = new TextDecoder();
    let count = 0;
    for (const [path, body] of await untar(bytes)) {
      // The package's own root is its first segment ("package/" for nearly every tarball).
      const inside = path.slice(path.indexOf("/") + 1);
      if (!CODE.test(inside)) continue;
      this.change.writes.set(`${key}/${inside}`, decoder.decode(body));
      count += 1;
    }
    this.log(`added ${what} (${count} files)`);
  }

  /** The package at `key` with its dependencies, in the lockfile and (unless skipped) in the page. */
  private async ensure(key: string, optional: boolean, seen: Set<string>): Promise<void> {
    if (seen.has(key)) return;
    seen.add(key);
    const entry = this.lock.packages[key]!;
    const name = nameOf(key);
    // The runtime's own packages and a project's file or linked packages (the vendored curb)
    // are the runtime's in the page, and their subtrees are already in the lockfile.
    if (name in RUNTIME_MODULES || entry.link === true || !entry.resolved?.startsWith("http")) return;
    if (!optional && !this.present(key)) await this.unpack(key, `${name}@${entry.version}`, entry.resolved, entry.integrity);
    for (const dependency of dependenciesOf(entry)) {
      const where = placement(this.lock, key, dependency.name, dependency.range);
      const child = "reuse" in where ? where.reuse : where.place;
      if ("place" in where) {
        const manifest = await resolveManifest(dependency.name, dependency.range);
        this.lock.packages[child] = entryFor(manifest, { optional: optional || dependency.optional });
      } else if (!optional && !dependency.optional) {
        markRequired(this.lock, child);
      }
      await this.ensure(child, optional || dependency.optional, seen);
    }
  }

  async install(spec: string): Promise<void> {
    const { name, range } = parseSpec(spec);
    const manifest = await resolveManifest(name, range);
    const key = `node_modules/${name}`;
    const existing = this.lock.packages[key];
    if (existing?.version !== manifest.version) {
      if (existing) this.keepForDependents(key, manifest.version);
      this.lock.packages[key] = entryFor(manifest);
      // A replaced version's files go; the new ones are unpacked below.
      for (const path of [...this.files.keys(), ...this.change.writes.keys()]) {
        if (path.startsWith(`${key}/`) && !path.startsWith(`${key}/node_modules/`)) {
          this.change.writes.delete(path);
          this.change.deletes.push(path);
        }
      }
    } else {
      markRequired(this.lock, key);
    }
    await this.ensure(key, false, new Set());
    const saved = `^${manifest.version}`;
    this.packageJson.dependencies = { ...this.packageJson.dependencies, [name]: saved };
    const root = (this.lock.packages[""] ??= {});
    root.dependencies = { ...root.dependencies, [name]: saved };
    if (name in RUNTIME_MODULES) this.log(`${name}@${manifest.version} is part of the browser runtime: recorded, not unpacked`);
  }

  /**
   * The root copy of a package is being replaced by `version`: every package that resolved
   * the old copy there and does not accept the new version gets the old one nested.
   */
  private keepForDependents(key: string, version: string): void {
    const name = nameOf(key);
    const old = this.lock.packages[key]!;
    for (const [dependent, entry] of Object.entries(this.lock.packages)) {
      if (dependent === "" || dependent === key || dependent.startsWith(`${key}/`)) continue;
      const range = dependenciesOf(entry).find((dependency) => dependency.name === name)?.range;
      if (range === undefined || resolveFrom(this.lock, dependent, name) !== key) continue;
      if (semver.validRange(range) && semver.satisfies(version, range)) continue;
      this.lock.packages[`${dependent}/node_modules/${name}`] = { ...old };
    }
  }

  uninstall(name: string): void {
    if (!this.packageJson.dependencies?.[name] && !this.lock.packages[""]?.dependencies?.[name]) {
      throw new NpmInstallError(`"${name}" is not a dependency of this project.`);
    }
    const { [name]: _removed, ...rest } = this.packageJson.dependencies ?? {};
    this.packageJson.dependencies = rest;
    const root = this.lock.packages[""]!;
    const { [name]: _gone, ...left } = root.dependencies ?? {};
    root.dependencies = left;
    const removed = prune(this.lock);
    for (const path of this.files.keys()) {
      if (removed.some((key) => path.startsWith(`${key}/`))) this.change.deletes.push(path);
    }
    this.log(`removed ${name} (${removed.length} package${removed.length === 1 ? "" : "s"} no longer needed)`);
  }

  /**
   * `npm ci` for the page: every package the lockfile reaches from package.json's
   * dependencies, unpacked when the page lacks it or holds another version, and the packages
   * nothing reaches any more deleted. The lockfile itself is not changed.
   */
  async restore(): Promise<void> {
    const reached = new Set<string>();
    const visit = async (key: string, from: string): Promise<void> => {
      if (reached.has(key)) return;
      const entry = this.lock.packages[key];
      if (!entry) throw new NpmInstallError(`package-lock.json has no entry for ${key} (needed by ${from || "package.json"}).`);
      reached.add(key);
      const name = nameOf(key);
      if (name in RUNTIME_MODULES || entry.link === true || entry.optional === true || !entry.resolved?.startsWith("http")) return;
      if (this.installedVersion(key) !== entry.version) {
        for (const path of this.files.keys()) {
          if (path.startsWith(`${key}/`) && !path.startsWith(`${key}/node_modules/`)) this.change.deletes.push(path);
        }
        await this.unpack(key, `${name}@${entry.version}`, entry.resolved, entry.integrity);
      }
      for (const dependency of dependenciesOf(entry)) {
        if (dependency.optional) continue;
        const child = resolveFrom(this.lock, key, dependency.name);
        if (child === null) throw new NpmInstallError(`package-lock.json does not place ${dependency.name}, a dependency of ${key}.`);
        await visit(child, key);
      }
    };
    for (const name of Object.keys(this.packageJson.dependencies ?? {})) await visit(`node_modules/${name}`, "");
    for (const path of this.files.keys()) {
      const key = PACKAGE_KEY.exec(path)?.[1];
      if (key !== undefined && !reached.has(key)) this.change.deletes.push(path);
    }
  }

  /** The version of the package the page holds at `key`, if it holds one. */
  private installedVersion(key: string): string | undefined {
    const manifest = this.files.get(`${key}/package.json`);
    if (manifest === undefined) return undefined;
    try {
      return (JSON.parse(manifest) as { version?: string }).version;
    } catch {
      return undefined; // KEEP-JUSTIFIED: an unreadable manifest is a package to unpack again.
    }
  }

  finish(): ProjectChange {
    this.change.writes.set("package.json", `${JSON.stringify(this.packageJson, null, 2)}\n`);
    this.change.writes.set("package-lock.json", serializeLockfile(this.lock));
    return this.change;
  }
}

/** Install `specs` into a project whose files are `files`. */
export async function npmInstall(
  specs: readonly string[],
  files: ReadonlyMap<string, string>,
  log: (line: string) => void,
): Promise<ProjectChange> {
  const session = new Session(files, log);
  for (const spec of specs) await session.install(spec);
  return session.finish();
}

/** The page's `node_modules/` as the project's lockfile says (`Session.restore`). */
export async function npmRestore(files: ReadonlyMap<string, string>, log: (line: string) => void): Promise<ProjectChange> {
  const session = new Session(files, log);
  await session.restore();
  return session.change;
}

/** Uninstall `name`: out of `package.json`, the lockfile, and the page's `node_modules/`. */
export function npmUninstall(name: string, files: ReadonlyMap<string, string>, log: (line: string) => void): ProjectChange {
  const session = new Session(files, log);
  session.uninstall(name);
  return session.finish();
}
