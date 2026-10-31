#!/usr/bin/env node
// Maps the files a pull request changes to the test suites it can affect. test.yml reads
// the result, so a pull request runs only those. A file no rule knows runs everything, so
// a new path can never skip a test by accident.

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SUITES = ["framework", "scaffolders", "scripts", "examples", "compat", "smoke", "package", "website"];

const IGNORED = [
  /^packages\/framework\/docs\/(?!agent-guide\/)/,
  /^\.github\/assets\//,
  /^(?!README\.md$)[^/]+\.md$/,
  /^(LICENSE|NOTICE|\.gitignore|cliff\.toml)$/,
];

const RULES = [
  // The site renders the agent guide, and website/src/seo.test.ts holds the README and both
  // manifests to its tagline.
  [/^(website\/|README\.md$|\.github\/workflows\/pages\.yml$|packages\/framework\/docs\/agent-guide\/)/, ["website"]],
  [/^packages\/framework\/package\.json$/, ["framework", "examples", "compat", "smoke", "package", "website"]],
  [/^packages\/create-curb\.js\/package\.json$/, ["scaffolders", "package", "website"]],
  [/^packages\/framework\//, ["framework", "examples", "compat", "smoke", "package"]],
  [/^packages\/create-curb\.js\//, ["scaffolders", "package"]],
  [/^examples\/insurance-agent\//, ["examples", "smoke"]],
  [/^examples\//, ["examples"]],
  [/^compat\//, ["compat"]],
  [/^\.github\/workflows\/publish\.yml$/, ["scripts"]],
  [/^scripts\/check-projects\./, ["scripts", "examples", "compat"]],
  [/^scripts\/self-host-smoke\./, ["smoke"]],
  [/^scripts\/(npm-package|release-install-test|release-version)\./, ["scripts", "package"]],
  [/^scripts\//, ["scripts"]],
];

/** The suites these changed files can affect, in the order of SUITES. */
export function affectedSuites(files) {
  const suites = new Set();
  for (const file of files) {
    if (IGNORED.some((pattern) => pattern.test(file))) continue;
    const rule = RULES.find(([pattern]) => pattern.test(file));
    for (const suite of rule ? rule[1] : SUITES) suites.add(suite);
  }
  return SUITES.filter((suite) => suites.has(suite));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A pull request's checkout is its merge commit, so the first parent is the base it merges into.
  const files =
    process.env.GITHUB_EVENT_NAME === "pull_request"
      ? execFileSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
      : null;
  const suites = files ? affectedSuites(files) : SUITES;
  console.log(`suites: ${suites.join(" ") || "none"}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `suites=${suites.join(" ")}\n`);
  }
}
