#!/usr/bin/env node
// The version the next release gets. Tags hold the version: nothing in the repository is ever
// bumped, because no workflow can push a commit to main.
//
//   node scripts/release-version.mjs --channel stable --semver minor
//   node scripts/release-version.mjs --channel preview
//
// The base is the higher of the stable `v*` tags and npm's `latest` of curb.js. A stable release
// bumps the base. A preview is `<next minor>-preview.<n>`, with n continuing
// from the published `preview` tag and the preview git tags, and starting over at 1 when a
// stable release moves the base past that line.
//
// Prints the result and adds version, git_tag, dist_tag and kugelaudio_tag to GITHUB_OUTPUT. A
// source that cannot be read fails the script: a version guessed from fewer sources could collide.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const PREVIEW = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/;

/** `[major, minor, patch]`, or null for anything that is not a plain X.Y.Z. */
function stableParts(version) {
  const match = STABLE.exec(version ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

/** `[major, minor, patch, n]`, or null for anything that is not a preview. */
function previewParts(version) {
  const match = PREVIEW.exec(version ?? "");
  return match ? match.slice(1, 5).map(Number) : null;
}

function compareParts(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

const tagVersions = (tags) => tags.map((tag) => tag.replace(/^v/, ""));

/** The highest plain release among the tags and npm's latest. */
function baseParts({ tags, npmLatest }) {
  const releases = [...tagVersions(tags), npmLatest].map(stableParts).filter(Boolean);
  return releases.reduce((high, parts) => (compareParts(parts, high) > 0 ? parts : high), [0, 0, 0]);
}

export function stableVersion({ tags, npmLatest, semver }) {
  const [major, minor, patch] = baseParts({ tags, npmLatest });
  if (semver === "major") return `${major + 1}.0.0`;
  if (semver === "minor") return `${major}.${minor + 1}.0`;
  if (semver === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`semver must be patch, minor or major, got ${JSON.stringify(semver)}`);
}

export function previewVersion({ tags, npmLatest, npmPreview }) {
  const [major, minor] = baseParts({ tags, npmLatest });
  const next = [major, minor + 1, 0];
  // Tags count too because the dist-tag can lag a publish that just finished, and a tag is written
  // just before its publish. Either way that number must not be reused.
  const previews = [npmPreview, ...tagVersions(tags)].map(previewParts).filter(Boolean);
  const newest = previews.reduce((high, parts) => (!high || compareParts(parts, high) > 0 ? parts : high), null);
  // A line already above the next minor goes on, so `preview` never moves backwards.
  if (newest && compareParts(newest.slice(0, 3), next) >= 0) {
    return `${newest.slice(0, 3).join(".")}-preview.${newest[3] + 1}`;
  }
  return `${next.join(".")}-preview.1`;
}

/** The dist-tag create-kugelaudio gets in a run, from the repository variable CREATE_KUGELAUDIO:
 *  `release` follows the run, `preview` stays on `preview` even in a stable release, and anything
 *  else, or nothing, leaves it unpublished. So moving its `latest` takes a deliberate setting. */
export function kugelaudioTag(setting, distTag) {
  if (setting === "release") return distTag;
  return setting === "preview" ? "preview" : "";
}

/** The dist-tags of an npm package; none for a package npm does not have. */
export async function npmDistTags(name, { registry = "https://registry.npmjs.org", fetchImpl = fetch } = {}) {
  const url = `${registry}/-/package/${encodeURIComponent(name)}/dist-tags`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const { values } = parseArgs({ options: { channel: { type: "string" }, semver: { type: "string" } } });
  if (values.channel !== "stable" && values.channel !== "preview") {
    throw new Error("usage: release-version.mjs --channel stable --semver <patch|minor|major> | --channel preview");
  }
  const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const distTags = await npmDistTags("curb.js");
  const sources = { tags, npmLatest: distTags.latest };
  const version =
    values.channel === "stable"
      ? stableVersion({ ...sources, semver: values.semver })
      : previewVersion({ ...sources, npmPreview: distTags.preview });
  const distTag = values.channel === "stable" ? "latest" : "preview";
  const result = {
    version,
    git_tag: `v${version}`,
    dist_tag: distTag,
    kugelaudio_tag: kugelaudioTag(process.env.CREATE_KUGELAUDIO, distTag),
  };
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(result).map(([key, value]) => `${key}=${value}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join(""));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
