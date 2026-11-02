#!/usr/bin/env node
// Proves the tarballs about to be published work the way a user meets them.
//
//   node scripts/release-install-test.mjs <tarball-dir>
//
// A local registry serves the tarballs and sends every other package on to npm, so the real
// `npm create curb.js` runs in an empty folder before anything is published, and `npm create curb`
// and `npm create kugelaudio` beside it must write the same files. The project it creates must depend on
// `"curb": "npm:curb.js@<version>"`, and `curb check`, `curb build` (verification on) and `curb upgrade --check` must all work through that alias. The command
// must also start outside a project, where it has no generated tsconfig to read.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fileHashes } from "./npm-package.mjs";

const UPSTREAM = "https://registry.npmjs.org";
const RELEASE_TARBALL = /^(curb\.js|create-curb\.js|create-curb|create-kugelaudio)-(.+)\.tgz$/;
// Only installing writes these, and the second project skips it.
const INSTALLED = /^(node_modules|package-lock\.json)(\/|$)/;

/** The channel a version is published on, as its npm dist-tag. */
export function channelOf(version) {
  return /-preview\.\d+$/.test(version) ? "preview" : "latest";
}

/** A one-version npm packument for a packed tarball. */
export function packument(manifest, tarball, tarballUrl) {
  const bytes = readFileSync(tarball);
  const hash = (algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
  const dist = {
    tarball: tarballUrl,
    shasum: hash("sha1", "hex"),
    integrity: `sha512-${hash("sha512", "base64")}`,
  };
  return {
    name: manifest.name,
    "dist-tags": { latest: manifest.version, [channelOf(manifest.version)]: manifest.version },
    versions: { [manifest.version]: { ...manifest, dist } },
  };
}

export function readTarballs(directory) {
  const found = readdirSync(directory).flatMap((file) => {
    const match = RELEASE_TARBALL.exec(file);
    if (!match) return [];
    const path = join(directory, file);
    const text = execFileSync("tar", ["-xzOf", path, "package/package.json"], { encoding: "utf8" });
    return [{ file, path, manifest: JSON.parse(text) }];
  });
  const version = found[0]?.manifest.version;
  const names = found.map(({ manifest }) => manifest.name).sort();
  if (names.join() !== "create-curb,create-curb.js,create-kugelaudio,curb.js" || found.some(({ manifest }) => manifest.version !== version)) {
    throw new Error(`${directory} must hold curb.js, create-curb.js, create-curb and create-kugelaudio at one version, found ${found.map(({ file }) => file)}`);
  }
  return { tarballs: found, version };
}

/** Serves the tarballs and redirects everything else upstream. Resolves its base URL. */
export async function startRegistry(tarballs) {
  const packages = new Map(tarballs.map((entry) => [entry.manifest.name, entry]));
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://registry").pathname);
    const json = (body) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    const base = `http://127.0.0.1:${server.address().port}`;
    const local = packages.get(path.slice(1));
    const tags = /^\/-\/package\/(.+)\/dist-tags$/.exec(path);
    const file = tarballs.find((entry) => path === `/tarballs/${entry.file}`);
    if (local) json(packument(local.manifest, local.path, `${base}/tarballs/${local.file}`));
    else if (tags && packages.has(tags[1])) {
      const { manifest } = packages.get(tags[1]);
      json({ latest: manifest.version, [channelOf(manifest.version)]: manifest.version });
    } else if (file) response.writeHead(200).end(readFileSync(file.path));
    else response.writeHead(307, { location: `${UPSTREAM}${request.url}` }).end();
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Runs a command, printing its output; resolves that output, and rejects on a non-zero exit. */
export function run(command, args, options) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  return new Promise((done, failed) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on("error", failed);
    child.on("close", (code) => {
      if (code === 0) done(stdout);
      else failed(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

export function expect(condition, message) {
  if (!condition) throw new Error(`release install test: ${message}`);
}

/** The paths that differ between two scaffolded projects, what installing writes aside. */
export function projectDifferences(first, second) {
  const scaffolded = (path) => !INSTALLED.test(path);
  const [a, b] = [fileHashes(first, scaffolded), fileHashes(second, scaffolded)];
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}

/** Creates a project in a folder named like `project` and fails unless it matches `project`. */
export async function expectSameProject(project, spec, base, { env }) {
  const twin = join(base, "twin", basename(project));
  rmSync(twin, { recursive: true, force: true });
  mkdirSync(twin, { recursive: true });
  await run("npm", ["create", "--yes", spec, ".", "--", "--skip-git", "--skip-install"], { cwd: twin, env });
  const different = projectDifferences(project, twin);
  expect(different.length === 0, `npm create ${spec} wrote a different project: ${different.join(", ")}`);
}

async function main([directory]) {
  if (!directory) throw new Error("usage: release-install-test.mjs <tarball-dir>");
  const { tarballs, version } = readTarballs(resolve(directory));
  const channel = channelOf(version);
  const { server, url } = await startRegistry(tarballs);
  const work = mkdtempSync(join(tmpdir(), "curb-release-install-"));
  const project = join(work, "release-check");
  mkdirSync(project);

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(LIVEKIT_|CURB_)/.test(key)),
  );
  const env = {
    ...environment,
    npm_config_registry: url,
    npm_config_cache: join(work, "npm-cache"),
    CURB_NPM_REGISTRY: url,
  };
  try {
    const spec = channel === "preview" ? "curb.js@preview" : "curb.js";
    await run("npm", ["create", "--yes", spec, ".", "--", "--skip-git"], { cwd: project, env });
    for (const name of ["curb", "kugelaudio"]) {
      await expectSameProject(project, channel === "preview" ? `${name}@preview` : name, work, { env });
    }

    const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const expected = `npm:curb.js@${version}`;
    expect(manifest.dependencies.curb === expected, `the project depends on ${manifest.dependencies.curb}, expected ${expected}`);
    const installed = JSON.parse(readFileSync(join(project, "node_modules/curb/package.json"), "utf8"));
    expect(installed.name === "curb.js" && installed.version === version, `installed ${installed.name}@${installed.version}`);
    expect(existsSync(join(project, "node_modules/.bin/curb")), "the alias installed no curb command");

    const curb = join(project, "node_modules/.bin/curb");
    for (const cwd of [work, join(project, "src")]) {
      const printed = await run(curb, ["--version"], { cwd, env });
      expect(printed.includes(version), `\`curb --version\` in ${cwd} printed ${printed}`);
      await run(curb, ["info"], { cwd, env });
    }

    await run("npx", ["curb", "check"], { cwd: project, env });
    await run("npx", ["curb", "build", "--out", join(work, "dist")], { cwd: project, env });
    const upToDate = `curb v${version} is up to date.`;
    const check = await run("npx", ["curb", "upgrade", "--check"], { cwd: project, env });
    expect(check.includes(upToDate), "`curb upgrade --check` did not read npm");
    if (channel === "preview") {
      const preview = await run("npx", ["curb", "upgrade", "--check", "--preview"], { cwd: project, env });
      expect(preview.includes(upToDate), "`curb upgrade --check --preview` did not read npm");
    }
    console.log(`\n${spec} ${version} installs, checks and builds from its tarballs.`);
  } finally {
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
