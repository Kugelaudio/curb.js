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
  ]);
});

test("a scaffolder runs only the scaffolder tests", () => {
  assert.deepEqual(affectedSuites(["packages/create-curb.js/bin/create-curb.js"]), ["scaffolders"]);
  assert.deepEqual(affectedSuites(["packages/create-framework-app/templates/default/README.md"]), [
    "scaffolders",
  ]);
});

test("an example runs the examples, and the one the smoke test builds runs that too", () => {
  assert.deepEqual(affectedSuites(["examples/pipeline/src/agent/agent.tsx"]), ["examples"]);
  assert.deepEqual(affectedSuites(["examples/insurance-agent/package.json"]), ["examples", "smoke"]);
});

test("a script runs what depends on it", () => {
  assert.deepEqual(affectedSuites(["scripts/npm-package.mjs"]), ["scripts"]);
  assert.deepEqual(affectedSuites(["scripts/check-projects.mjs"]), ["scripts", "examples", "compat"]);
});

test("the lockfile, this workflow and any unknown file run everything", () => {
  for (const file of ["package-lock.json", ".github/workflows/test.yml", "something/new.txt"]) {
    assert.deepEqual(affectedSuites([file]), SUITES);
  }
});

test("several files add up", () => {
  assert.deepEqual(affectedSuites(["compat/projects/a/package.json", "README.md", "scripts/x.mjs"]), [
    "scripts",
    "compat",
  ]);
});
