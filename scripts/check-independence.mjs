#!/usr/bin/env node
// Fails when Curb cites something only KugelAudio can open.
//
// Curb is a public, self-hostable framework. Its source and docs must stand on their own:
// internal decision records, ticket ids, numbered design notes and private repository
// paths or links are dead ends for every reader outside KugelAudio, so they fail CI.
//
//   node scripts/check-independence.mjs
//
// Exit 0 when clean, 1 with one `file:line: text` per hit otherwise.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** What a citation of a private platform document looks like. */
const PRIVATE_REFERENCE =
  /\bD-\d{2}\b|\bOQ-\d{2}\b|\b\d{2}-[a-z][a-z-]+\.md\b|products\/(platform|web)\b|packages\/private\b|\b(ENG|KUG)-\d{4,}\b|github\.com\/Kugelaudio\/KugelAudio\b/i;

/** The public surface: what ships in the packages and what a reader of the repo sees first. */
const SCANNED = ["packages", "examples", "scripts", "README.md", "AGENTS.md"];

/** This file spells the patterns out, so it is the one file never scanned. */
const SELF = fileURLToPath(import.meta.url);

/** Directories never scanned: installed third-party code, not ours. */
const SKIPPED_DIRS = new Set(["node_modules", ".curb", "dist"]);

/** Binary files cannot cite a document; skip them rather than decode them. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wav|mp3|onnx|wasm|gz|tgz|zip)$/i;

function* files(path) {
  const stats = statSync(path);
  if (stats.isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* files(child);
    else if (entry.isFile() && !BINARY.test(entry.name)) yield child;
  }
}

const hits = [];
let scanned = 0;
for (const target of SCANNED) {
  for (const file of files(join(root, target))) {
    if (file === SELF) continue;
    scanned += 1;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (PRIVATE_REFERENCE.test(line)) {
        hits.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (hits.length > 0) {
  console.error(`check-independence: ${hits.length} reference(s) to private documents:`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(
    "\nCurb must not cite internal decision records, ticket ids, numbered design notes or " +
      "private repository paths and links. State the reason in the comment itself instead.",
  );
  process.exit(1);
}
console.log(`check-independence: ${scanned} file(s) scanned, no private platform references.`);
