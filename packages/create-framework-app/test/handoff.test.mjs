// A copy of create-curb-app from the CDN hands the run to the newest release that the
// CDN's latest.json names, because npx keeps an old copy forever on a machine that ran the
// quickstart before. Each test runs the bin as a published copy (no framework checkout
// beside it) against a local latest.json, with a fake npx that records how it was called.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isNewerRelease } from "../bin/newest-release.js";

const binDir = fileURLToPath(new URL("../bin", import.meta.url));
const repoBin = join(binDir, "create-curb-app.js");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const picocolors = dirname(createRequire(import.meta.url).resolve("picocolors/package.json"));

const FAKE_NPX = `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_NPX_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  handoff: process.env.CREATE_CURB_APP_HANDOFF,
}));
process.exit(Number(process.env.FAKE_NPX_EXIT ?? 0));
`;

/** A published copy of this create-curb-app at `version`, a fake npx, and a directory that
 * already holds a file, so a run that does not hand off stops at its first check. */
function publishedCopy(t, version) {
  const root = mkdtempSync(join(tmpdir(), "create-curb-app-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "create-curb-app");
  cpSync(binDir, join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...manifest, version }));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(picocolors, join(root, "node_modules", "picocolors"));
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "npx"), FAKE_NPX);
  chmodSync(join(fakeBin, "npx"), 0o755);
  const taken = join(root, "taken");
  mkdirSync(taken);
  writeFileSync(join(taken, "README.md"), "already here\n");
  return { root, bin: join(pkg, "bin", "create-curb-app.js"), fakeBin, taken, log: join(root, "npx.json") };
}

/** A local CDN that answers latest.json with `status` and `body`, counting the requests. */
async function cdn(t, { status = 200, body }) {
  const served = { requests: 0 };
  const server = createServer((request, response) => {
    served.requests += 1;
    if (request.url !== "/latest.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, served };
}

const pointer = (version) => ({ version, createApp: { version, tarball: `create-curb-app-${version}.tgz` } });

/** Run `bin` with `args`; resolves its exit code and output. Asynchronous, so the local
 * CDN in this process can answer while the bin waits for it. */
function run(bin, args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function envFor(copy, base, extra = {}) {
  return {
    PATH: `${copy.fakeBin}:${process.env.PATH}`,
    HOME: copy.root,
    CURB_CDN: base,
    FAKE_NPX_LOG: copy.log,
    FAKE_NPX_EXIT: "3",
    ...extra,
  };
}

test("an older copy hands the run to the newest release, with the same arguments, once", async (t) => {
  const copy = publishedCopy(t, "1.5.1");
  const { base } = await cdn(t, { body: pointer("1.6.0") });
  const result = await run(copy.bin, ["my-agent", "--yes", "--stt", "azure"], envFor(copy, base));
  assert.equal(result.code, 3, "the bin exits with the newest release's exit code");
  assert.deepEqual(JSON.parse(readFileSync(copy.log, "utf8")), {
    argv: ["--yes", "--allow-remote=all", `${base}/create-curb-app-1.6.0.tgz`, "my-agent", "--yes", "--stt", "azure"],
    handoff: "1.6.0",
  });
  assert.match(result.stdout, /create-curb-app 1\.6\.0 is out and this copy is 1\.5\.1/);
});

test("the newest release, and a copy newer than the pointer, create the project themselves", async (t) => {
  for (const [own, latest] of [["1.6.0", "1.6.0"], ["1.6.0", "1.5.9"]]) {
    const copy = publishedCopy(t, own);
    const { base, served } = await cdn(t, { body: pointer(latest) });
    const result = await run(copy.bin, [copy.taken, "--yes"], envFor(copy, base));
    assert.equal(served.requests, 1);
    assert.equal(existsSync(copy.log), false, `${own} against ${latest} must not hand off`);
    assert.match(result.stderr, /already exists and is not empty/);
    assert.doesNotMatch(result.stderr, /Could not check/);
  }
});

test("an explicit --framework or CREATE_CURB_APP_HANDOFF keeps this release, without asking the CDN", async (t) => {
  const cases = [
    { args: ["--framework", "file:/unused"], env: {} },
    { args: [], env: { CREATE_CURB_APP_HANDOFF: "off" } },
  ];
  for (const { args, env } of cases) {
    const copy = publishedCopy(t, "1.5.1");
    const { base, served } = await cdn(t, { body: pointer("1.6.0") });
    const result = await run(copy.bin, [copy.taken, "--yes", ...args], envFor(copy, base, env));
    assert.equal(served.requests, 0);
    assert.equal(existsSync(copy.log), false);
    assert.match(result.stderr, /already exists and is not empty/);
  }
});

test("a repo checkout never asks the CDN", async (t) => {
  const copy = publishedCopy(t, "1.5.1");
  const { base, served } = await cdn(t, { body: pointer("1.6.0") });
  const result = await run(repoBin, [copy.taken, "--yes"], envFor(copy, base));
  assert.equal(served.requests, 0);
  assert.equal(existsSync(copy.log), false);
  assert.match(result.stderr, /already exists and is not empty/);
});

test("a pointer that cannot be read is said, and this release creates the project", async (t) => {
  for (const [served, reason] of [
    [{ status: 404, body: {} }, /HTTP 404/],
    [{ body: { version: "1.6.0" } }, /names no create-curb-app release/],
  ]) {
    const copy = publishedCopy(t, "1.5.1");
    const { base } = await cdn(t, served);
    const result = await run(copy.bin, [copy.taken, "--yes"], envFor(copy, base));
    assert.equal(existsSync(copy.log), false);
    assert.match(result.stderr, /Could not check for a newer create-curb-app \(/);
    assert.match(result.stderr, reason);
    assert.match(result.stderr, /creating the project with 1\.5\.1\./);
    assert.match(result.stderr, /already exists and is not empty/);
  }
});

test("a release is newer field by field, and only a plain X.Y.Z release is ever newer", () => {
  assert.equal(isNewerRelease("1.10.0", "1.9.9"), true);
  assert.equal(isNewerRelease("2.0.0", "1.99.99"), true);
  assert.equal(isNewerRelease("1.5.0", "1.5.0"), false);
  assert.equal(isNewerRelease("1.4.9", "1.5.0"), false);
  assert.equal(isNewerRelease("2.0.0-beta.1", "1.0.0"), false);
  assert.equal(isNewerRelease("1.6.0", "dev"), false);
});
