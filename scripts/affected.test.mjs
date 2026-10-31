import assert from "node:assert/strict";
import { test } from "node:test";

import { SUITES, affectedSuites } from "./affected.mjs";

test("docs, the website and the other workflows run nothing", () => {
  assert.deepEqual(
    affectedSuites([
      "README.md",
      "website/src/pages/index.astro",
      "packages/framework/docs/agent-guide/tools.md",
      ".github/workflows/pages.yml",
    ]),
    [],
  );
});

test("framework code runs what is built on it", () => {
  assert.deepEqual(affectedSuites(["packages/framework/src/index.ts"]), [
    "framework",
    "examples",
    "compat",
    "smoke",
    "package",
  ]);
});

test("the publish workflow runs the scripts suite, which tests it", () => {
  assert.deepEqual(affectedSuites([".github/workflows/publish.yml"]), ["scripts"]);
});

test("the release notes config runs nothing", () => {
  assert.deepEqual(affectedSuites(["cliff.toml"]), []);
});

test("a scaffolder runs the scaffolder tests and packs what it ships", () => {
  assert.deepEqual(affectedSuites(["packages/create-curb.js/bin/create-curb.js"]), ["scaffolders", "package"]);
  assert.deepEqual(affectedSuites(["packages/create-curb.js/templates/default/README.md"]), [
    "scaffolders",
    "package",
  ]);
});

test("an example runs the examples, and the one the smoke test builds runs that too", () => {
  assert.deepEqual(affectedSuites(["examples/pipeline/src/agent/agent.tsx"]), ["examples"]);
  assert.deepEqual(affectedSuites(["examples/insurance-agent/package.json"]), ["examples", "smoke"]);
});

test("a script runs what depends on it", () => {
  for (const file of ["npm-package", "release-install-test", "release-version"]) {
    assert.deepEqual(affectedSuites([`scripts/${file}.mjs`]), ["scripts", "package"]);
  }
  assert.deepEqual(affectedSuites(["scripts/check-projects.mjs"]), ["scripts", "examples", "compat"]);
});

test("the lockfile, the root manifest, this workflow and any unknown file run everything", () => {
  for (const file of ["package-lock.json", "package.json", ".github/workflows/test.yml", "something/new.txt"]) {
    assert.deepEqual(affectedSuites([file]), SUITES);
  }
});

test("the docs of a package do not pack it", () => {
  assert.deepEqual(affectedSuites(["packages/framework/docs/agent-guide/tools.md"]), []);
});

test("several files add up", () => {
  assert.deepEqual(affectedSuites(["compat/projects/a/package.json", "README.md", "scripts/x.mjs"]), [
    "scripts",
    "compat",
  ]);
});
