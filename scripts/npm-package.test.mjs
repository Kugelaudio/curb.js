import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmManifest, unexpectedDifferences } from "./npm-package.mjs";

const SCRIPT = fileURLToPath(new URL("./npm-package.mjs", import.meta.url));

test("publishes the release as curb.js, public, and leaves the rest of the manifest alone", () => {
  const manifest = { name: "curb", version: "1.14.1", private: true, bin: { curb: "./bin/curb.js" } };
  const published = npmManifest(manifest);
  assert.equal(published.name, "curb.js");
  assert.equal(published.version, "1.14.1");
  assert.deepEqual(published.bin, { curb: "./bin/curb.js" });
  assert.equal("private" in published, false);
  assert.match(published.repository.url, /Kugelaudio\/curb\.js/);
});

test("refuses a tarball that is not the curb release", () => {
  assert.throws(() => npmManifest({ name: "create-curb-app" }), /create-curb-app/);
});

test("only package.json may differ after packing", () => {
  const before = new Map([["package.json", "a"], ["bin/curb.js", "b"], ["src/index.ts", "c"]]);
  assert.deepEqual(unexpectedDifferences(before, new Map([...before, ["package.json", "z"]])), []);
  assert.deepEqual(unexpectedDifferences(before, new Map([...before, ["src/index.ts", "z"]])), ["src/index.ts"]);
  const dropped = new Map(before);
  dropped.delete("bin/curb.js");
  assert.deepEqual(unexpectedDifferences(before, dropped), ["bin/curb.js"]);
  assert.deepEqual(unexpectedDifferences(before, new Map([...before, ["extra.txt", "z"]])), ["extra.txt"]);
});

test("leaves no tarball behind when it refuses one", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(release);
  writeFileSync(join(release, "dropped.txt"), "npm pack leaves this out\n");
  writeFileSync(join(release, "kept.txt"), "kept\n");
  const manifest = { name: "curb", version: "9.9.9", private: true, files: ["kept.txt"] };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  const out = join(work, "out");
  mkdirSync(out);

  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, join(work, "release.tgz"), out], { stdio: "pipe" }),
    /dropped\.txt/,
  );
  assert.deepEqual(readdirSync(out), []);
});
