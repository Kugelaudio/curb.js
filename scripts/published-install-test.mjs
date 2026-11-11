#!/usr/bin/env node
// Proves a version npm now holds installs from the public registry the way a user meets it.
//
//   node scripts/published-install-test.mjs <version>
//
// release-install-test.mjs tried the tarballs before they went out, through a local registry.
// This runs after the publish, with nothing of this repository in the path: the real
// `npm create curb.js@<version>` in an empty folder, `npm create curb@<version>` beside it to
// compare, then `curb --version`, `curb check`, `curb build` (verification on) and
// `curb upgrade --check`. published.yml runs it every day against `latest` and `preview`, since a
// published version also breaks when a dependency it allows by range ships a new release. npm can take minutes to serve a publication, so it waits the way
// publish.yml's read-back does, and a registry that lags past `npm view` gets another try.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { channelOf, expect, expectSameProject, run } from "./release-install-test.mjs";

export const PACKAGES = ["curb.js", "create-curb.js", "create-curb", "create-kugelaudio"];

/** What this run published: create-kugelaudio only when plan gave it a dist-tag. */
export function publishedNames(kugelaudioTag) {
  return kugelaudioTag ? PACKAGES : PACKAGES.filter((name) => name !== "create-kugelaudio");
}

/** Resolves once `read()` answers `version`; throws after `attempts` tries. */
export async function waitForVersion(spec, version, read, { attempts = 60, wait = () => delay(10_000) } = {}) {
  let found = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    found = await read().catch(() => "");
    if (found === version) return;
    if (attempt < attempts) await wait();
  }
  throw new Error(`npm serves ${found || "nothing"} for ${spec} after ${attempts} tries`);
}

/** The result of `task`, tried up to `attempts` times; the last failure is thrown. */
export async function withRetries(task, { attempts = 3, wait = () => delay(30_000) } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`\nattempt ${attempt} failed: ${error.message}`);
      await wait();
    }
  }
}

function npmView(spec, env) {
  return new Promise((done, failed) => {
    execFile("npm", ["view", spec, "version"], { env }, (error, stdout) => (error ? failed(error) : done(stdout.trim())));
  });
}

async function main([version]) {
  if (!version) throw new Error("usage: published-install-test.mjs <version>");
  const work = mkdtempSync(join(tmpdir(), "curb-published-install-"));
  const project = join(work, "published-check");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(LIVEKIT_|CURB_)/.test(key)),
  );
  // A cache of its own, always revalidated: the registry's answer is what is under test.
  const env = { ...environment, npm_config_cache: join(work, "npm-cache"), npm_config_prefer_online: "true" };
  try {
    const names = publishedNames(process.env.KUGELAUDIO_TAG);
    for (const name of names) {
      const spec = `${name}@${version}`;
      await waitForVersion(spec, version, () => npmView(spec, env));
      console.log(`${spec} is on npm`);
    }

    await withRetries(async () => {
      rmSync(project, { recursive: true, force: true });
      mkdirSync(project);
      await run("npm", ["create", "--yes", `curb.js@${version}`, ".", "--", "--skip-git"], { cwd: project, env });
    });
    await expectSameProject(project, `curb@${version}`, work, { env });
    if (names.includes("create-kugelaudio")) await expectSameProject(project, `kugelaudio@${version}`, work, { env });

    const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const expected = `npm:curb.js@${version}`;
    expect(manifest.dependencies.curb === expected, `the project depends on ${manifest.dependencies.curb}, expected ${expected}`);
    const printed = await run("npx", ["curb", "--version"], { cwd: project, env });
    expect(printed.trim() === version, `\`curb --version\` printed ${printed.trim()}, expected ${version}`);
    await run("npx", ["curb", "check"], { cwd: project, env });
    await run("npx", ["curb", "build", "--out", join(work, "dist")], { cwd: project, env });
    await run("npx", ["curb", "upgrade", "--check"], { cwd: project, env });
    if (channelOf(version) === "preview") {
      await run("npx", ["curb", "upgrade", "--check", "--preview"], { cwd: project, env });
    }
    console.log(`\nnpm create curb.js@${version} installs, checks and builds from the public registry.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
