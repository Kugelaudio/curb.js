// A tarball path in a workflow must reach npm as a path. npm reads a bare `out/x.tgz` as the
// GitHub repository out/x.tgz and fails in git, which no check caught before the first release
// run, because a path written any other way passes. So this runs real `npm publish --dry-run`
// with each path exactly as the workflows spell it.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflows = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/** The quoted `.tgz` arguments of every npm command in a workflow's text. */
export function npmTarballArgs(text) {
  return text
    .split("\n")
    .filter((line) => /(^|\s)npm\s/.test(line))
    .flatMap((line) => [...line.matchAll(/"([^"\s]+\.tgz)"/g)].map((match) => match[1]));
}

function tarballArgs() {
  return readdirSync(workflows).flatMap((file) => npmTarballArgs(readFileSync(join(workflows, file), "utf8")));
}

/** `npm publish --dry-run <arg>` from a folder holding a small package at that path, against a
 * local registry that knows no package. Git cannot reach anything, so the run stays offline. */
async function dryRun(t, arg) {
  const root = mkdtempSync(join(tmpdir(), "curb-publish-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = "curb-publish-path-check";
  const relative = arg.replaceAll("$name", name).replaceAll("$VERSION", "9.9.9");
  const pkg = join(root, "package");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "9.9.9" }));
  mkdirSync(join(root, "out"));
  execFileSync("tar", ["-czf", join(root, relative), "-C", root, "package"]);
  const registry = createServer((request, response) => response.writeHead(404).end("{}"));
  await new Promise((listening) => registry.listen(0, "127.0.0.1", listening));
  t.after(() => registry.close());
  const args = ["publish", "--dry-run", "--access", "public", relative];
  args.push(`--registry=http://127.0.0.1:${registry.address().port}/`);
  return new Promise((done) => {
    const child = spawn("npm", args, {
      cwd: root,
      env: { ...process.env, GIT_SSH_COMMAND: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stderr }));
  });
}

test("the workflows publish both tarballs, in the dry run and for real", () => {
  assert.deepEqual(tarballArgs().length, 2);
});

test("npm reads every tarball path in a workflow as a file", async (t) => {
  for (const arg of tarballArgs()) {
    const result = await dryRun(t, arg);
    assert.equal(result.status, 0, `npm publish --dry-run ${arg}\n${result.stderr}`);
  }
});

test("npm does not read a bare path as a file, which is why the ./ is there", async (t) => {
  const result = await dryRun(t, "out/$name-$VERSION.tgz");
  assert.notEqual(result.status, 0);
});

test("finds a bare path, the form npm takes for a repository", () => {
  const line = '            npm publish --access public --tag "$DIST_TAG" "out/$name-$VERSION.tgz"';
  assert.deepEqual(npmTarballArgs(line), ["out/$name-$VERSION.tgz"]);
  assert.deepEqual(npmTarballArgs('tarball="out/$name-$VERSION.tgz"'), []);
});
