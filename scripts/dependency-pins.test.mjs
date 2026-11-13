// What a project installs is what this repository tested: the published packages pin every
// runtime dependency to one version, the lockfile agrees with those pins, and every package
// in a lockfile came from the public registry with a sha512 to check it against.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const json = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const PUBLISHED = ["packages/framework", "packages/create-curb.js"];
const LOCKFILES = ["package-lock.json", "website/package-lock.json"];
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REGISTRY = "https://registry.npmjs.org/";

test("the published packages pin every runtime dependency to one version", () => {
  for (const dir of PUBLISHED) {
    const ranges = Object.entries(json(`${dir}/package.json`).dependencies ?? {})
      .filter(([, spec]) => !EXACT.test(spec))
      .map(([name, spec]) => `${name}@${spec}`);
    assert.deepEqual(ranges, [], `${dir}/package.json: pin these to the version package-lock.json holds`);
  }
});

test("the lockfile installs exactly the versions the published packages pin", () => {
  const packages = json("package-lock.json").packages;
  for (const dir of PUBLISHED) {
    const wrong = Object.entries(json(`${dir}/package.json`).dependencies ?? {})
      .map(([name, pin]) => [name, pin, (packages[`${dir}/node_modules/${name}`] ?? packages[`node_modules/${name}`])?.version])
      .filter(([, pin, locked]) => pin !== locked)
      .map(([name, pin, locked]) => `${name}: pinned ${pin}, locked ${locked}`);
    assert.deepEqual(wrong, [], `${dir}: run npm install so package-lock.json follows the pins`);
  }
});

test("an override of a pinned dependency names the same version", () => {
  const pins = json("packages/framework/package.json").dependencies;
  const overrides = json("package.json").overrides ?? {};
  const nested = Object.values(overrides).filter((value) => typeof value === "object");
  for (const scope of nested) {
    for (const [name, version] of Object.entries(scope)) {
      if (name in pins) assert.equal(version, pins[name], `the root override of ${name} must equal the framework's pin`);
    }
  }
});

test("every locked package comes from the public registry with a sha512", () => {
  for (const lockfile of LOCKFILES) {
    const bad = Object.entries(json(lockfile).packages)
      // "" is the root, and a path without node_modules/ is one of this repository's workspaces.
      // A bundled dependency ships inside its parent's tarball, which that parent's sha512 covers.
      .filter(([path, entry]) => path.includes("node_modules/") && !entry.link && !entry.inBundle)
      .filter(([, entry]) => !entry.resolved?.startsWith(REGISTRY) || !entry.integrity?.startsWith("sha512-"))
      .map(([path, entry]) => `${path} ${entry.resolved ?? "(no resolved)"} ${entry.integrity ? "" : "(no integrity)"}`);
    assert.deepEqual(bad, [], `${lockfile}: every package must come from ${REGISTRY} with a sha512 integrity`);
  }
});
