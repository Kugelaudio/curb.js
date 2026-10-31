import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOf, packument } from "./release-install-test.mjs";

test("a version's channel is its npm dist-tag", () => {
  assert.equal(channelOf("1.15.0"), "latest");
  assert.equal(channelOf("1.16.0-preview.3"), "preview");
});

test("the packument names the tarball and serves it on the version's channel", () => {
  const tarball = join(mkdtempSync(join(tmpdir(), "curb-packument-")), "curb.js.tgz");
  writeFileSync(tarball, "bytes");
  const manifest = { name: "curb.js", version: "1.16.0-preview.3" };
  const served = packument(manifest, tarball, "http://registry/curb.js.tgz");
  assert.deepEqual(served["dist-tags"], { latest: "1.16.0-preview.3", preview: "1.16.0-preview.3" });
  const { dist } = served.versions["1.16.0-preview.3"];
  assert.equal(dist.tarball, "http://registry/curb.js.tgz");
  assert.match(dist.integrity, /^sha512-/);
});
