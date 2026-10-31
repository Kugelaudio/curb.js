import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmManifest, PACKAGES, stampTarball, unexpectedDifferences } from "./npm-package.mjs";

test("publishes the framework as curb.js at the stamped version, and leaves the rest alone", () => {
  const manifest = { name: "curb", version: "1.0.0", private: true, bin: { curb: "./bin/curb.js" } };
  const published = npmManifest(manifest, "1.15.0-preview.3");
  assert.equal(published.name, "curb.js");
  assert.equal(published.version, "1.15.0-preview.3");
  assert.deepEqual(published.bin, { curb: "./bin/curb.js" });
  assert.equal("private" in published, false);
  assert.match(published.repository.url, /Kugelaudio\/curb\.js/);
});

test("create-curb.js keeps its name, and gets the repository provenance checks against", () => {
  const published = npmManifest({ name: "create-curb.js", version: "1.0.1" }, "1.15.0");
  assert.equal(published.name, "create-curb.js");
  assert.equal(published.version, "1.15.0");
  assert.match(published.repository.url, /Kugelaudio\/curb\.js/);
});

test("curb.js is packed before create-curb.js, which pins it", () => {
  assert.deepEqual(PACKAGES, ["packages/framework", "packages/create-curb.js"]);
});

test("refuses a package Curb does not publish", () => {
  assert.throws(() => npmManifest({ name: "create-curb-app" }, "1.0.0"), /create-curb-app/);
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
  const manifest = { name: "curb", version: "1.0.0", private: true, files: ["kept.txt"] };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  const out = join(work, "out");
  mkdirSync(out);

  assert.throws(() => stampTarball(join(work, "release.tgz"), out, { version: "9.9.9" }), /dropped\.txt/);
  assert.deepEqual(readdirSync(out), []);
});

test("stamps the version into the tarball and ships the release notes", () => {
  const work = mkdtempSync(join(tmpdir(), "curb-npm-test-"));
  const release = join(work, "package");
  mkdirSync(release);
  writeFileSync(join(release, "kept.txt"), "kept\n");
  const manifest = { name: "curb", version: "1.0.0", private: true, files: ["kept.txt"] };
  writeFileSync(join(release, "package.json"), JSON.stringify(manifest));
  execFileSync("tar", ["-czf", join(work, "release.tgz"), "-C", work, "package"]);
  writeFileSync(join(work, "notes.md"), "## Added\n");
  const out = join(work, "out");
  mkdirSync(out);

  const tarball = stampTarball(join(work, "release.tgz"), out, { version: "1.15.0", notes: join(work, "notes.md") });
  assert.equal(readdirSync(out)[0], "curb.js-1.15.0.tgz");
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
  const stamped = JSON.parse(readFileSync(join(unpacked, "package/package.json"), "utf8"));
  assert.equal(stamped.name, "curb.js");
  assert.equal(stamped.version, "1.15.0");
  assert.equal(readFileSync(join(unpacked, "package/RELEASE_NOTES.md"), "utf8"), "## Added\n");
});
