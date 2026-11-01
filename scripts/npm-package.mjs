#!/usr/bin/env node
// Builds the tarballs npm receives from the source at this commit.
//
//   node scripts/npm-package.mjs <version> <out-dir> [--notes <file>]
//
// Each package is packed as it stands, then stamped: the repository holds no release version,
// so the version comes from scripts/release-version.mjs. The framework is `curb` here and
// `curb.js` on npm, because `curb` belongs to someone else there; projects keep
// `import ... from "curb"` through the alias `"curb": "npm:curb.js@<version>"`. Only
// package.json and the release notes may differ from the packed source: every other file is
// compared by hash after packing, and any other difference fails the script. Build output
// under `.curb/` fails it too: `files` ignores .gitignore, so a test run leaves it packable. So
// does a package that would lose its npm page: each package.json holds that page's fields, and
// this script stamps only the name and version.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The order matters: create-curb.js pins curb.js, so curb.js reaches npm first.
export const PACKAGES = ["packages/framework", "packages/create-curb.js"];
const NPM_NAMES = { curb: "curb.js", "create-curb.js": "create-curb.js" };
const MANIFEST = "package.json";
const NOTES = "RELEASE_NOTES.md";
const README = "README.md";
const PAGE_FIELDS = ["description", "author", "license", "homepage", "bugs"];
const KEYWORDS = { min: 10, max: 15 };

/** A package's manifest as npm publishes it. */
export function npmManifest(manifest, version) {
  const name = NPM_NAMES[manifest.name];
  if (!name) throw new Error(`expected a package Curb publishes, found ${manifest.name}`);
  const { private: _private, ...published } = manifest;
  return { ...published, name, version };
}

/** Every link and image in a README, code blocks aside. */
export function readmeLinks(readme) {
  const prose = readme.replace(/^```[\s\S]*?^```$/gm, "");
  return [...prose.matchAll(/\]\(([^)\s]+)\)|\b(?:href|src|srcset)="([^"]+)"/g)].map((match) => match[1] ?? match[2]);
}

/** What a package would lack on its npm page. Links must open for a reader on npm: there, a
 *  relative path resolves to nothing and a GitHub path needs access to the repository. */
export function npmPageProblems(manifest, readme) {
  const problems = PAGE_FIELDS.filter((field) => !manifest[field]).map((field) => `no ${field}`);
  if (!manifest.repository?.url || !manifest.repository.directory) problems.push("no repository with a directory");
  const keywords = manifest.keywords?.length ?? 0;
  if (keywords < KEYWORDS.min || keywords > KEYWORDS.max) {
    problems.push(`${keywords} keywords, expected ${KEYWORDS.min} to ${KEYWORDS.max}`);
  }
  if (!readme?.trim()) return [...problems, `no ${README}`];
  const broken = readmeLinks(readme).filter(
    (link) => !/^(https:\/\/|#)/.test(link) || /raw\.githubusercontent\.com|github\.com\/Kugelaudio/i.test(link),
  );
  return [...problems, ...broken.map((link) => `a ${README} link npm cannot show: ${link}`)];
}

/** Every file under `root` with its sha256, keyed by its path below `root`. */
export function fileHashes(root) {
  const hashes = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    hashes.set(relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return hashes;
}

/** The paths that differ between two trees, package.json and the release notes aside. */
export function unexpectedDifferences(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => path !== MANIFEST && path !== NOTES && before.get(path) !== after.get(path))
    .sort();
}

/** The paths under a `.curb/` directory, which only a build or a test run writes. */
export function buildOutput(paths) {
  return [...paths].filter((path) => path.split(sep).includes(".curb")).sort();
}

function unpack(tarball) {
  const directory = mkdtempSync(join(tmpdir(), "curb-npm-"));
  execFileSync("tar", ["-xzf", tarball, "-C", directory]);
  return join(directory, "package");
}

export function npmPack(cwd) {
  const directory = mkdtempSync(join(tmpdir(), "curb-npm-pack-"));
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", directory], {
    cwd,
    encoding: "utf8",
  }).trim();
  return join(directory, packed);
}

/** Stamps a packed tarball and writes the result to `outDir`; its path. */
export function stampTarball(tarball, outDir, { version, notes }) {
  const source = unpack(resolve(tarball));
  const before = fileHashes(source);

  const manifestPath = join(source, MANIFEST);
  const manifest = npmManifest(JSON.parse(readFileSync(manifestPath, "utf8")), version);
  if (notes) {
    copyFileSync(notes, join(source, NOTES));
    manifest.files = [...manifest.files, NOTES];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Packed aside, so a tarball this script refuses is never left where publish reads it.
  const result = npmPack(source);
  const packed = unpack(result);
  const after = fileHashes(packed);
  const changed = unexpectedDifferences(before, after);
  if (changed.length > 0) throw new Error(`npm pack changed more than package.json: ${changed.join(", ")}`);
  const output = buildOutput(after.keys());
  if (output.length > 0) throw new Error(`${manifest.name} would ship build output: ${output.join(", ")}`);
  const readmePath = join(packed, README);
  const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : undefined;
  const problems = npmPageProblems(manifest, readme);
  if (problems.length > 0) throw new Error(`${manifest.name} would lose its npm page: ${problems.join(", ")}`);
  const destination = join(resolve(outDir), `${manifest.name}-${version}.tgz`);
  copyFileSync(result, destination);
  return destination;
}

function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { notes: { type: "string" } } });
  const [version, outDir] = positionals;
  if (!version || !outDir) throw new Error("usage: npm-package.mjs <version> <out-dir> [--notes <file>]");
  for (const directory of PACKAGES) {
    console.log(stampTarball(npmPack(join(ROOT, directory)), outDir, { version, notes: values.notes }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
