// create-curb.js refuses a Node.js older than its `engines.node`, by name, instead of
// failing later with an unrelated error.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { nodeFloor, unsupportedNodeMessage } from "../bin/node-version.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const checkModule = new URL("../bin/node-version.js", import.meta.url).href;

test("the published engines.node is a single floor the check can read", () => {
  assert.deepEqual(nodeFloor(manifest.engines.node), [22, 12, 0]);
});

test("a Node older than the floor is refused by name", () => {
  for (const version of ["22.11.9", "21.7.3", "20.19.0", "18.20.4"]) {
    const message = unsupportedNodeMessage("create-curb.js", ">=22.12.0", version);
    assert.match(message, /^UnsupportedNodeVersion: create-curb.js needs Node\.js >=22\.12\.0/);
    assert.match(message, new RegExp(`this is Node\\.js ${version.replaceAll(".", "\\.")}\\.`));
  }
});

test("the floor and every newer Node are accepted", () => {
  for (const version of ["22.12.0", "22.23.3", "24.0.0", "26.12.0"]) {
    assert.equal(unsupportedNodeMessage("create-curb.js", ">=22.12.0", version), null);
  }
});

test("an engines.node that is not one floor fails loudly", () => {
  for (const range of [undefined, "^22.12.0", ">=22", ">=22.12.0 <27"]) {
    assert.throws(() => nodeFloor(range), /engines\.node" must read ">=X\.Y\.Z"/);
  }
});

test("exitOnUnsupportedNode exits 1 with the refusal on stderr", (t) => {
  const root = mkdtempSync(join(tmpdir(), "node-version-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageJson = join(root, "package.json");
  writeFileSync(packageJson, JSON.stringify({ name: "future-app", engines: { node: ">=999.0.0" } }));
  const script =
    `const { exitOnUnsupportedNode } = await import(${JSON.stringify(checkModule)});` +
    `exitOnUnsupportedNode(new URL(${JSON.stringify(pathToFileURL(packageJson).href)}));` +
    'console.log("ran on");';
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /UnsupportedNodeVersion: future-app needs Node\.js >=999\.0\.0/);
});
