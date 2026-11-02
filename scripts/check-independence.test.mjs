import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { brokenBy, isScanned, scan } from "./check-independence.mjs";

const rule = (line) => brokenBy(line).map(({ what }) => what);

test("each kind of reference is caught, in any case", () => {
  assert.deepEqual(rule("moved out of the Monorepo"), ["the monorepo"]);
  assert.deepEqual(rule("a mono-repo package"), ["the monorepo"]);
  assert.deepEqual(rule("promoted by Kargo"), ["release infrastructure"]);
  assert.deepEqual(rule("synced by argo"), ["release infrastructure"]);
  assert.deepEqual(rule("an ArgoCD app"), ["release infrastructure"]);
  assert.deepEqual(rule("the gitops repository"), ["release infrastructure"]);
  assert.deepEqual(rule("https://cdn.kugelaudio.com/widget/v1/widget.js"), ["the CDN"]);
  assert.deepEqual(rule("reads latest.json"), ["the CDN"]);
  assert.deepEqual(rule("set CURB_CDN"), ["the CDN"]);
  assert.deepEqual(rule("npx create-curb-app"), ["a retired package name"]);
  assert.deepEqual(rule("create-framework-app"), ["a retired package name"]);
  assert.deepEqual(rule("see packages/private/ci"), ["a private document"]);
  assert.deepEqual(rule("in packages/public/curb"), ["a private document"]);
  assert.deepEqual(rule("ticket ENG-12345"), ["a private document"]);
});

test("words that only contain a term, and what Curb keeps, pass", () => {
  for (const line of [
    "npm create kugelaudio my-agent",
    "create-kugelaudio is packed from packages/create-curb.js",
    "no jargon, cargo or embargo here",
    "curb login reads https://api.eu.kugelaudio.com",
    "kugelaudio.tts({ voice: 1 })",
    "https://docs.kugelaudio.com/hosted-agents/quickstart",
    "npm create curb.js my-agent",
    "the CDN of a provider",
  ]) {
    assert.deepEqual(rule(line), [], line);
  }
});

test("only history, lockfiles, compat/ and the check itself are exempt", () => {
  for (const file of [
    "CHANGELOG.md",
    "package-lock.json",
    "website/package-lock.json",
    "yarn.lock",
    "compat/projects/1.14.1/README.md",
    "scripts/check-independence.mjs",
    "scripts/check-independence.test.mjs",
  ]) {
    assert.equal(isScanned(file), false, file);
  }
  for (const file of [
    "README.md",
    "CONTRIBUTING.md",
    ".github/workflows/publish.yml",
    "website/src/guide.ts",
    "packages/create-curb.js/templates/default/.mcp.json",
    "examples/compat/README.md",
  ]) {
    assert.equal(isScanned(file), true, file);
  }
});

/** A throwaway repository holding `files`. */
function repository(t, files) {
  const root = mkdtempSync(join(tmpdir(), "check-independence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

test("a scan covers the whole repository and names the file and line", (t) => {
  const root = repository(t, {
    ".github/workflows/x.yml": "a\nurl: https://cdn.kugelaudio.com/x\n",
    "brand-new-directory/notes.md": "from the monorepo\n",
    "CHANGELOG.md": "reads latest.json\n",
    "compat/old/AGENTS.md": "set CURB_CDN\n",
    "clean.md": "nothing to see\n",
  });
  const { scanned, hits } = scan(root);
  assert.equal(scanned, 3);
  assert.deepEqual(hits.map(({ file, line }) => `${file}:${line}`).sort(), [
    ".github/workflows/x.yml:2",
    "brand-new-directory/notes.md:1",
  ]);
});

test("a symlink is not scanned twice, and ignored files are not scanned", (t) => {
  const root = repository(t, {
    ".gitignore": "ignored/\n",
    "AGENTS.md": "the monorepo\n",
    "ignored/x.md": "the monorepo\n",
  });
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
  assert.deepEqual(scan(root).hits.map(({ file }) => file), ["AGENTS.md"]);
});
