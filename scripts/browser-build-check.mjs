#!/usr/bin/env node
// Runs the static browser build on the starter project, because it is the only thing that bundles
// the browser runtime: a package it cannot resolve fails only here, and only when someone builds
// the page. A lockfile stands in for the real one, which needs a published Curb and which the
// build only copies.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRAMEWORK = join(ROOT, "packages/framework");

const work = mkdtempSync(join(tmpdir(), "curb-browser-build-"));
try {
  const template = join(work, "template");
  const out = join(work, "out");
  cpSync(join(ROOT, "packages/create-curb.js/templates/default"), template, { recursive: true });
  writeFileSync(join(template, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`);
  execFileSync("npx", ["tsx", "src/browser/static-build.ts", template, out], { cwd: FRAMEWORK, stdio: "inherit" });
  for (const file of ["index.html", "curb-browser/worker.js", "curb-browser/template.json"]) {
    if (!existsSync(join(out, file))) throw new Error(`the static browser build wrote no ${file}`);
  }
  console.log("The static browser build works.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
