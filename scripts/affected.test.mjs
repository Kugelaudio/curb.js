import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SUITES, affectedSuites } from "./affected.mjs";

test("docs the site does not render run nothing", () => {
  assert.deepEqual(
    affectedSuites(["CONTRIBUTING.md", "packages/framework/docs/build-verification.md", ".github/assets/logo.png"]),
    [],
  );
});

test("repository settings no test reads run nothing", () => {
  for (const file of [".github/dependabot.yml", ".github/AGENTS.md", ".github/ISSUE_TEMPLATE/bug_report.md"]) {
    assert.deepEqual(affectedSuites([file]), []);
  }
});

test("what the site reads runs the website suite", () => {
  for (const file of [
    "website/src/pages/index.astro",
    "packages/framework/docs/agent-guide/tools.md",
    "README.md",
  ]) {
    assert.deepEqual(affectedSuites([file]), ["website"]);
  }
});

test("the manifests the site checks run the website suite with their own suites", () => {
  assert.ok(affectedSuites(["packages/framework/package.json"]).includes("website"));
  assert.ok(affectedSuites(["packages/framework/package.json"]).includes("framework"));
  assert.deepEqual(affectedSuites(["packages/create-curb.js/package.json"]), ["scaffolders", "scripts", "package", "website"]);
  assert.ok(affectedSuites(["packages/framework/package.json"]).includes("scripts"));
  assert.deepEqual(affectedSuites(["website/package-lock.json"]), ["scripts", "website"]);
  assert.deepEqual(affectedSuites(["packages/framework/README.md"]), ["package", "website"]);
  assert.deepEqual(affectedSuites(["packages/create-curb.js/README.md"]), ["package", "website"]);
  assert.ok(!affectedSuites(["packages/framework/src/index.ts"]).includes("website"));
});

test("framework code runs what is built on it", () => {
  assert.deepEqual(affectedSuites(["packages/framework/src/index.ts"]), [
    "framework",
    "examples",
    "compat",
    "smoke",
    "browser",
    "package",
  ]);
});

test("the starter project is what the static browser build runs on", () => {
  assert.ok(affectedSuites(["packages/framework/src/browser/browser-build.ts"]).includes("browser"));
  assert.ok(affectedSuites(["packages/create-curb.js/templates/default/package.json"]).includes("browser"));
  assert.deepEqual(affectedSuites(["scripts/browser-build-check.mjs"]), ["scripts", "browser"]);
});

test("the files the scripts suite tests run that suite", () => {
  for (const file of ["workflows/publish.yml", "workflows/pr-rules.yml", "pull_request_template.md"]) {
    assert.deepEqual(affectedSuites([`.github/${file}`]), ["scripts"]);
  }
});

test("the pages workflow runs the site and the tests that read it", () => {
  assert.deepEqual(affectedSuites([".github/workflows/pages.yml"]), ["scripts", "website"]);
});

test("the release notes config runs nothing", () => {
  assert.deepEqual(affectedSuites(["cliff.toml"]), []);
});

test("a scaffolder runs the scaffolder tests and packs what it ships", () => {
  assert.deepEqual(affectedSuites(["packages/create-curb.js/bin/create-curb.js"]), ["scaffolders", "package"]);
  assert.deepEqual(affectedSuites(["packages/create-curb.js/templates/default/README.md"]), [
    "scaffolders",
    "browser",
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
  for (const file of [
    "package-lock.json",
    "package.json",
    ".github/workflows/test.yml",
    ".github/workflows/new.yml",
    ".github/CODEOWNERS",
    "something/new.txt",
  ]) {
    assert.deepEqual(affectedSuites([file]), SUITES);
  }
});

test("the docs of a package do not pack it", () => {
  assert.ok(!affectedSuites(["packages/framework/docs/agent-guide/tools.md"]).includes("package"));
});

test("several files add up", () => {
  assert.deepEqual(affectedSuites(["compat/projects/a/package.json", "CONTRIBUTING.md", "scripts/x.mjs"]), [
    "scripts",
    "compat",
  ]);
});

const testYml = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
const gateJob = testYml.slice(testYml.indexOf("\n  gate:\n"));

/** Runs gate's own script, the way a GitHub step does, with these job results. */
function gate(results) {
  const script = /run: \|\n((?:          .*\n)+)/.exec(gateJob)[1];
  return spawnSync("bash", ["-e", "-c", script], { env: { ...process.env, ...results } }).status;
}

test("gate reports on every run, and waits for every job", () => {
  assert.match(gateJob, /needs: \[affected, test, package, website\]/);
  assert.match(gateJob, /if: always\(\)/);
  assert.match(gateJob, /PACKAGE: \$\{\{ needs\.package\.result \}\}/);
  assert.match(gateJob, /WEBSITE: \$\{\{ needs\.website\.result \}\}/);
});

test("gate fails when the website suite fails, and when it is cancelled", () => {
  for (const WEBSITE of ["failure", "cancelled"]) {
    for (const TEST of ["success", "skipped"]) {
      assert.equal(gate({ AFFECTED: "success", TEST, PACKAGE: "success", WEBSITE }), 1, `test ${TEST}, website ${WEBSITE}`);
    }
  }
});

test("gate fails when the package job fails, and when it is cancelled", () => {
  for (const PACKAGE of ["failure", "cancelled"]) {
    assert.equal(gate({ AFFECTED: "success", TEST: "success", PACKAGE, WEBSITE: "success" }), 1, `package ${PACKAGE}`);
  }
});

test("gate fails when test or affected fails, whatever the website suite did", () => {
  assert.equal(gate({ AFFECTED: "success", TEST: "failure", PACKAGE: "success", WEBSITE: "success" }), 1);
  assert.equal(gate({ AFFECTED: "failure", TEST: "skipped", PACKAGE: "skipped", WEBSITE: "skipped" }), 1);
});

test("gate passes a suite that succeeded or was not needed", () => {
  for (const TEST of ["success", "skipped"]) {
    for (const PACKAGE of ["success", "skipped"]) {
      for (const WEBSITE of ["success", "skipped"]) {
        assert.equal(gate({ AFFECTED: "success", TEST, PACKAGE, WEBSITE }), 0, `test ${TEST}, package ${PACKAGE}, website ${WEBSITE}`);
      }
    }
  }
});

test("a change only the website suite covers does not start the test job", () => {
  assert.match(testYml, /needs\.affected\.outputs\.suites != 'website'/);
  assert.deepEqual(affectedSuites(["README.md"]).join(" "), "website");
});
