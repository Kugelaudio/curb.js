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
// published version also breaks when a dependency it allows by range ships a new release. npm can take minutes to serve a publication, and its
// tarballs lag `npm view`, so it first waits until every package names its tarball and that
// tarball answers, then gives an `npm create` that still meets E404 or ETARGET another try.

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

/** How long npm gets to serve a fresh publication before the check gives up. */
export const SERVE_DEADLINE_MS = 10 * 60_000;

/**
 * Resolves once npm serves every `name@version`: `npm view` names its tarball and that tarball
 * answers. Both lag a publish, the tarball longest, so both are asked, each package in turn,
 * backing off from `firstWaitMs` to `maxWaitMs` until `deadlineMs` after the start.
 */
export async function waitForRelease(
  names,
  version,
  {
    viewTarball,
    probe,
    now = Date.now,
    sleep = (ms) => delay(ms),
    log = console.log,
    deadlineMs = SERVE_DEADLINE_MS,
    firstWaitMs = 5_000,
    maxWaitMs = 60_000,
  },
) {
  const started = now();
  for (const name of names) {
    const spec = `${name}@${version}`;
    let waitMs = firstWaitMs;
    for (let attempt = 1; ; attempt += 1) {
      const state = await serveState(spec, viewTarball, probe);
      if (state.ready) {
        log(`${spec} is on npm: ${state.url}`);
        break;
      }
      const left = started + deadlineMs - now();
      if (left <= 0) {
        const minutes = Math.round((now() - started) / 60_000);
        throw new Error(
          `the npm registry has not served ${spec} after ${minutes} minutes (${attempt} tries; last: ${state.reason})`,
        );
      }
      const pause = Math.min(waitMs, left);
      log(`waiting for npm to serve ${spec}, try ${attempt}: ${state.reason}; next try in ${Math.ceil(pause / 1000)} s`);
      await sleep(pause);
      waitMs = Math.min(waitMs * 2, maxWaitMs);
    }
  }
}

async function serveState(spec, viewTarball, probe) {
  const url = await viewTarball(spec).then((answer) => answer.trim(), () => "");
  if (!url) return { ready: false, reason: "npm view names no tarball" };
  const status = await probe(url).catch((error) => error.message);
  if (status === 200) return { ready: true, url };
  return { ready: false, reason: `${url} answers ${status}` };
}

/** Whether a failed npm command is the registry still lagging a publication (E404, ETARGET). */
export function isRegistryLag(error) {
  return /\b(E404|ETARGET)\b/.test(`${error?.output ?? ""}\n${error?.message ?? ""}`);
}

/** The result of `task`, tried again up to `attempts` times in all while npm still lags; any other failure is thrown at once. */
export async function retryOnRegistryLag(task, { attempts = 3, wait = () => delay(30_000), log = console.log } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt === attempts || !isRegistryLag(error)) throw error;
      log(`\nnpm does not serve everything yet (try ${attempt} of ${attempts}): ${error.message}`);
      await wait();
    }
  }
}

function npmViewTarball(spec, env) {
  return new Promise((done, failed) => {
    execFile("npm", ["view", spec, "dist.tarball"], { env }, (error, stdout) => (error ? failed(error) : done(stdout)));
  });
}

/** The HTTP status of a tarball URL; the body is not downloaded. */
async function tarballStatus(url) {
  const response = await fetch(url, { method: "HEAD", cache: "no-store" });
  return response.status;
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
    await waitForRelease(names, version, { viewTarball: (spec) => npmViewTarball(spec, env), probe: tarballStatus });

    await retryOnRegistryLag(async () => {
      rmSync(project, { recursive: true, force: true });
      mkdirSync(project);
      await run("npm", ["create", "--yes", `curb.js@${version}`, ".", "--", "--skip-git"], { cwd: project, env });
    });
    await expectSameProject(project, `curb@${version}`, work, { env, attempt: retryOnRegistryLag });
    if (names.includes("create-kugelaudio")) await expectSameProject(project, `kugelaudio@${version}`, work, { env, attempt: retryOnRegistryLag });

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
