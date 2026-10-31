import assert from "node:assert/strict";
import test from "node:test";
import { cdnLatestVersion, npmDistTags, previewVersion, stableVersion } from "./release-version.mjs";

const none = { tags: [], npmLatest: undefined, cdnLatest: undefined };

test("with no tags and nothing published, the first releases start from 0.0.0", () => {
  assert.equal(stableVersion({ ...none, semver: "patch" }), "0.0.1");
  assert.equal(stableVersion({ ...none, semver: "minor" }), "0.1.0");
  assert.equal(stableVersion({ ...none, semver: "major" }), "1.0.0");
  assert.equal(previewVersion(none), "0.1.0-preview.1");
});

test("the first release lands above the CDN when no tag exists and npm holds a placeholder", () => {
  const today = { tags: [], npmLatest: "0.0.0", cdnLatest: "1.14.1" };
  assert.equal(previewVersion(today), "1.15.0-preview.1");
  assert.equal(stableVersion({ ...today, semver: "patch" }), "1.14.2");
  assert.equal(stableVersion({ ...today, semver: "minor" }), "1.15.0");
  assert.equal(stableVersion({ ...today, semver: "major" }), "2.0.0");
});

test("the base is the highest of the tags, npm and the CDN, whichever holds it", () => {
  assert.equal(stableVersion({ tags: ["v1.14.1"], npmLatest: "1.15.2", cdnLatest: "1.14.1", semver: "patch" }), "1.15.3");
  assert.equal(stableVersion({ tags: ["v1.16.0"], npmLatest: "1.15.2", cdnLatest: "1.14.1", semver: "patch" }), "1.16.1");
  assert.equal(stableVersion({ tags: ["v1.15.0"], npmLatest: "1.15.0", cdnLatest: "1.17.3", semver: "minor" }), "1.18.0");
});

test("versions compare numerically, so 1.10 is above 1.9", () => {
  assert.equal(stableVersion({ tags: ["v1.9.9", "v1.10.0", "v1.2.0"], semver: "patch" }), "1.10.1");
});

test("a stable version ignores preview tags and anything that is not a version", () => {
  const tags = ["v1.14.1", "v1.15.0-preview.3", "v9.9.9-rc.1", "vnext", "v2"];
  assert.equal(stableVersion({ tags, semver: "minor" }), "1.15.0");
  assert.equal(stableVersion({ tags: [], npmLatest: "9.0.0-preview.1", cdnLatest: "1.0.0", semver: "patch" }), "1.0.1");
});

test("a preview continues the line the preview dist-tag holds", () => {
  const sources = { tags: ["v1.14.1"], npmLatest: "1.14.1", cdnLatest: "1.14.1" };
  assert.equal(previewVersion({ ...sources, npmPreview: "1.15.0-preview.3" }), "1.15.0-preview.4");
  assert.equal(previewVersion({ ...sources, npmPreview: "1.15.0-preview.9" }), "1.15.0-preview.10");
});

test("a preview tag ahead of the dist-tag still uses up its number", () => {
  const tags = ["v1.14.1", "v1.15.0-preview.3", "v1.15.0-preview.4"];
  assert.equal(previewVersion({ tags, npmPreview: "1.15.0-preview.3" }), "1.15.0-preview.5");
});

test("a stale dist-tag cannot reuse a number the preview tags already hold", () => {
  const tags = ["v1.14.1", "v1.15.0-preview.2", "v1.15.0-preview.10"];
  assert.equal(previewVersion({ tags, npmPreview: "1.15.0-preview.2" }), "1.15.0-preview.11");
});

test("a stable release moves the preview base and starts the count over", () => {
  const tags = ["v1.14.1", "v1.15.0-preview.3", "v1.15.0"];
  assert.equal(previewVersion({ tags, npmLatest: "1.15.0", npmPreview: "1.15.0-preview.3" }), "1.16.0-preview.1");
  assert.equal(
    previewVersion({ tags: ["v2.0.0"], npmLatest: "2.0.0", npmPreview: "1.15.0-preview.3" }),
    "2.1.0-preview.1",
  );
});

test("a higher CDN release moves the preview base too", () => {
  const sources = { tags: ["v1.15.0-preview.3"], npmLatest: "1.14.1", npmPreview: "1.15.0-preview.3" };
  assert.equal(previewVersion({ ...sources, cdnLatest: "1.15.1" }), "1.16.0-preview.1");
});

test("a patch release leaves the preview line alone", () => {
  const tags = ["v1.14.1", "v1.15.0-preview.3", "v1.14.2"];
  assert.equal(previewVersion({ tags, npmLatest: "1.14.2", npmPreview: "1.15.0-preview.3" }), "1.15.0-preview.4");
});

test("a preview line above the next minor goes on, so the channel never moves backwards", () => {
  assert.equal(previewVersion({ tags: [], cdnLatest: "1.14.1", npmPreview: "1.17.0-preview.2" }), "1.17.0-preview.3");
});

test("refuses a semver that is not patch, minor or major", () => {
  assert.throws(() => stableVersion({ ...none, semver: "prerelease" }), /semver must be patch, minor or major/);
});

const answering = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });

test("npm's dist-tags are read, and a package npm lacks has none", async () => {
  assert.deepEqual(await npmDistTags("curb.js", { fetchImpl: answering(200, { latest: "1.0.0" }) }), { latest: "1.0.0" });
  assert.deepEqual(await npmDistTags("curb.js", { fetchImpl: answering(404, {}) }), {});
});

test("a source that cannot be read fails instead of giving a lower version", async () => {
  await assert.rejects(npmDistTags("curb.js", { fetchImpl: answering(503, {}) }), /HTTP 503/);
  await assert.rejects(cdnLatestVersion("https://cdn.example", { fetchImpl: answering(503, {}) }), /HTTP 503/);
  await assert.rejects(cdnLatestVersion("https://cdn.example", { fetchImpl: answering(200, {}) }), /names no release/);
});

test("the CDN's version is read from latest.json", async () => {
  const version = await cdnLatestVersion("https://cdn.example", { fetchImpl: answering(200, { version: "1.14.1" }) });
  assert.equal(version, "1.14.1");
});
