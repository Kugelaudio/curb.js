#!/usr/bin/env node
// Fails when Curb leans on something outside this repository and npm.
//
// Curb is a public, self-hostable framework that stands on its own. Internal decision records,
// ticket ids, numbered design notes and private repository paths or links are dead ends for every
// reader outside KugelAudio. Company release infrastructure and the retired install flow are
// things Curb does not use. All of them fail CI, anywhere in the repository.
//
//   node scripts/check-independence.mjs
//
// Exit 0 when clean, 1 with one `file:line: text` per hit otherwise.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** What Curb must not reference, and what to do instead. */
export const FORBIDDEN = [
  {
    what: "a private document",
    pattern:
      /\bD-\d{2}\b|\bOQ-\d{2}\b|\b\d{2}-[a-z][a-z-]+\.md\b|products\/(platform|web)\b|packages\/(private|public)\b|\b(ENG|KUG)-\d{4,}\b|github\.com\/Kugelaudio\/KugelAudio\b/i,
    fix: "State the reason in the comment itself.",
  },
  {
    what: "the monorepo",
    pattern: /\bmono-?repo/i,
    fix: "This repository is Curb's only home. Describe the file by its path here.",
  },
  {
    what: "release infrastructure",
    pattern: /\bkargo\b|\bargo(cd)?\b|\bgit-?ops\b/i,
    fix: "Curb releases through .github/workflows/publish.yml and npm alone.",
  },
  {
    what: "the CDN",
    pattern: /cdn\.kugelaudio\.com|\blatest\.json\b|\bCURB_CDN\b/i,
    fix: "npm's dist-tags say what is newest. A browser asset ships in the package or from a host the repository owns.",
  },
  {
    what: "a retired package name",
    pattern: /\bcreate-(framework-app|curb-app)\b/i,
    fix: "The scaffolder is `npm create curb.js`.",
  },
];

/** Never scanned. History records what was true then, and compat/ freezes older releases. */
const EXEMPT = [/(^|\/)CHANGELOG\.md$/, /(^|\/)package-lock\.json$/, /\.lock$/, /^compat\//];

/** The only files allowed to break the rules: these two spell the patterns out. */
const ALLOWED = new Set(["scripts/check-independence.mjs", "scripts/check-independence.test.mjs"]);

/** Binary files cannot cite a document; skip them rather than decode them. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wav|mp3|onnx|wasm|gz|tgz|zip)$/i;

export const isScanned = (file) =>
  !ALLOWED.has(file) && !BINARY.test(basename(file)) && !EXEMPT.some((pattern) => pattern.test(file));

/** The rules a line breaks. */
export const brokenBy = (line) => FORBIDDEN.filter(({ pattern }) => pattern.test(line));

/** Every file git tracks or would track, so a new top-level directory cannot escape the check. */
function repositoryFiles(root) {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const listed = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 2 ** 26 });
  return listed.split("\0").filter(Boolean);
}

/** `{ scanned, hits }`: a symlink's target is scanned under its own name. */
export function scan(root) {
  const hits = [];
  let scanned = 0;
  for (const file of repositoryFiles(root).filter(isScanned)) {
    const stats = lstatSync(join(root, file), { throwIfNoEntry: false });
    if (!stats?.isFile()) continue;
    scanned += 1;
    readFileSync(join(root, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const rule of brokenBy(line)) hits.push({ file, line: index + 1, text: line.trim(), rule });
      });
  }
  return { scanned, hits };
}

function main() {
  const { scanned, hits } = scan(fileURLToPath(new URL("..", import.meta.url)));
  if (hits.length > 0) {
    console.error(`check-independence: ${hits.length} reference(s) Curb must not make:`);
    for (const { file, line, text, rule } of hits) {
      console.error(`  ${file}:${line}: ${rule.what}: ${text}\n    Fix: ${rule.fix}`);
    }
    process.exit(1);
  }
  console.log(`check-independence: ${scanned} file(s) scanned, nothing outside this repository and npm.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
