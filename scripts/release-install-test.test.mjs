import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOf, packument, projectDifferences } from "./release-install-test.mjs";

test("two projects match when only what installing writes differs", () => {
  const project = (files) => {
    const root = mkdtempSync(join(tmpdir(), "curb-project-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const scaffolded = { "package.json": "{}", "src/agent/agent.tsx": "a" };
  const installed = { ...scaffolded, "package-lock.json": "{}", "node_modules/curb/package.json": "{}" };
  assert.deepEqual(projectDifferences(project(installed), project(scaffolded)), []);
  assert.deepEqual(
    projectDifferences(project(installed), project({ ...scaffolded, "src/agent/agent.tsx": "b", "extra.md": "" })),
    ["extra.md", "src/agent/agent.tsx"],
  );
});

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
