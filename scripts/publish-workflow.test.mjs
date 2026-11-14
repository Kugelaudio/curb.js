// The channel a run releases to comes from the same expression everywhere, and a preview dispatch
// needs nothing but the channel. The checks below read publish.yml as text.
//
// A tarball path in a workflow must reach npm as a path. npm reads a bare `out/x.tgz` as the
// GitHub repository out/x.tgz and fails in git, which no check caught before the first release
// run, because a path written any other way passes. So this runs real `npm publish --dry-run`
// with each path exactly as the workflows spell it.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const publishYml = readFileSync(join(workflows, "publish.yml"), "utf8");
const testYml = readFileSync(join(workflows, "test.yml"), "utf8");

/** The text of one job, up to the next job or the end of the file. */
function job(name) {
  const start = publishYml.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `publish.yml has no ${name} job`);
  const next = publishYml.slice(start + 1).search(/\n {2}[a-z]+:\n/);
  return next === -1 ? publishYml.slice(start) : publishYml.slice(start, start + 1 + next);
}

/** What a job's `needs:` lists. */
function needs(name) {
  const list = /^ {4}needs: \[(.*)\]$/m.exec(job(name))?.[1];
  assert.ok(list, `the ${name} job has no needs list`);
  return list.split(", ");
}

/** Runs the tag job's script with a stand-in for gh: GET_REF is what the lookup prints, and it fails
 * when empty, the way gh does on a 404. POST_FAILS makes the create fail. */
function runTagStep(t, { getRef = "", postFails = false }) {
  const script = /run: \|\n((?: {10}.*\n)+)/.exec(job("tag"))?.[1].replace(/^ {10}/gm, "");
  assert.ok(script, "the tag job has no script");
  const bin = mkdtempSync(join(tmpdir(), "curb-tag-step-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const calls = join(bin, "calls");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
if [[ "$*" == *"--method POST"* ]]; then
  [[ -z "$POST_FAILS" ]] || { echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; }
  exit 0
fi
[[ -n "$GET_REF" ]] || exit 1
echo "$GET_REF"
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SHA: "abc",
      GIT_TAG: "v9.9.9",
      GET_REF: getRef,
      POST_FAILS: postFails ? "1" : "",
    },
  });
  const posted = existsSync(calls) && readFileSync(calls, "utf8").includes("--method POST");
  return { ...result, posted };
}

/** Runs one step of the publish job in a folder holding the four tarballs, with a stand-in for npm
 * that knows no version, except that `npm view` serves the right integrity for every name in
 * `served`, and with a `sleep` that returns at once and is counted. Returns the npm commands it
 * ran, how often it slept, and the step's result. */
function runPublishStep(t, step, { distTag, kugelaudioTag, served = [] }) {
  const start = job("publish").indexOf(`- name: ${step}\n`);
  assert.notEqual(start, -1, `the publish job has no step named ${step}`);
  const script = /run: \|\n((?: {10}.*\n)+)/.exec(job("publish").slice(start))?.[1].replace(/^ {10}/gm, "");
  const bin = mkdtempSync(join(tmpdir(), "curb-publish-step-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const cwd = join(bin, "work");
  mkdirSync(join(cwd, "out"), { recursive: true });
  mkdirSync(join(bin, "integrity"));
  for (const name of ["curb.js", "create-curb.js", "create-curb", "create-kugelaudio"]) {
    const tarball = Buffer.from(`${name} 9.9.9 tarball`);
    writeFileSync(join(cwd, "out", `${name}-9.9.9.tgz`), tarball);
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (served.includes(name)) writeFileSync(join(bin, "integrity", name), integrity);
  }
  const calls = join(bin, "calls");
  const sleeps = join(bin, "sleeps");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
[[ "$1" == view ]] || exit 0
served="${join(bin, "integrity")}/\${2%@*}"
[[ -f "$served" ]] && cat "$served"
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\necho "$*" >> "${sleeps}"\n`, { mode: 0o755 });
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      VERSION: "9.9.9",
      DIST_TAG: distTag,
      KUGELAUDIO_TAG: kugelaudioTag,
    },
  });
  const ran = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
  const slept = existsSync(sleeps) ? readFileSync(sleeps, "utf8").split("\n").filter(Boolean).length : 0;
  return {
    ...result,
    slept,
    published: ran.filter((line) => line.startsWith("publish ")),
    viewed: ran.filter((line) => line.startsWith("view ")).map((line) => line.split(" ")[1]),
  };
}

/** The lines of a workflow_dispatch input, up to the next input. */
function dispatchInput(name) {
  const match = new RegExp(`^      ${name}:\\n((?:        .*\\n)+)`, "m").exec(publishYml);
  assert.ok(match, `publish.yml has no ${name} input`);
  return match[1];
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

test("the workflows publish both tarballs, in both dry runs and for real", () => {
  assert.deepEqual(tarballArgs().length, 3);
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

test("a dispatch chooses its channel, and preview is the default", () => {
  const channel = dispatchInput("channel");
  assert.match(channel, /options: \[preview, stable\]/);
  assert.match(channel, /default: preview/);
});

test("a preview dispatch does not need a semver", () => {
  const semver = dispatchInput("semver");
  assert.doesNotMatch(semver, /required: true/);
  assert.doesNotMatch(semver, /default:/, "a stable dispatch that forgets semver must fail, not guess");
});

test("the channel reads the same in the concurrency group and in plan, and a push is preview", () => {
  const expression = "inputs.channel || 'preview'";
  assert.ok(publishYml.includes(`group: release-\${{ ${expression} }}`));
  assert.ok(publishYml.includes(`CHANNEL: \${{ ${expression} }}`));
  assert.doesNotMatch(publishYml, /github\.event_name/);
});

test("the package suite runs publish.yml's tarball commands", () => {
  for (const command of [
    'node scripts/npm-package.mjs "$VERSION" out',
    "node scripts/release-install-test.mjs out",
    'for name in curb.js create-curb.js create-curb create-kugelaudio; do',
    '"./out/$name-$VERSION.tgz"',
  ]) {
    assert.ok(publishYml.includes(command), `publish.yml no longer runs ${command}`);
    assert.ok(testYml.includes(command), `test.yml no longer runs ${command}`);
  }
});

test("a release without the variable publishes three names and is not held up", (t) => {
  const { status, stderr, published } = runPublishStep(t, "Publish what npm lacks", { distTag: "latest", kugelaudioTag: "" });
  assert.equal(status, 0, stderr);
  assert.deepEqual(published, [
    'publish --access public --tag latest ./out/curb.js-9.9.9.tgz',
    'publish --access public --tag latest ./out/create-curb.js-9.9.9.tgz',
    'publish --access public --tag latest ./out/create-curb-9.9.9.tgz',
  ]);
});

test("a stable release with create-kugelaudio held leaves its latest alone", (t) => {
  const { status, stderr, published } = runPublishStep(t, "Publish what npm lacks", {
    distTag: "latest",
    kugelaudioTag: "preview",
  });
  assert.equal(status, 0, stderr);
  assert.equal(published.at(-1), "publish --access public --tag preview ./out/create-kugelaudio-9.9.9.tgz");
  assert.equal(published.length, 4);
  assert.equal(published.filter((line) => line.includes("--tag latest")).length, 3);
});

test("create-kugelaudio goes to latest only when plan says so, and always last", (t) => {
  const { published } = runPublishStep(t, "Publish what npm lacks", { distTag: "latest", kugelaudioTag: "latest" });
  assert.equal(published.at(-1), "publish --access public --tag latest ./out/create-kugelaudio-9.9.9.tgz");
});

const published3 = ["curb.js", "create-curb.js", "create-curb"];

test("the read-back does not wait for a name that was not published", (t) => {
  const { status, stderr, stdout, viewed, slept } = runPublishStep(t, "Read the publication back", {
    distTag: "latest",
    kugelaudioTag: "",
    served: published3,
  });
  assert.equal(status, 0, stderr);
  assert.deepEqual(viewed, published3.map((name) => `${name}@9.9.9`));
  for (const name of published3) assert.match(stdout, new RegExp(`^${name}@9\\.9\\.9 is on npm$`, "m"));
  assert.doesNotMatch(stdout, /create-kugelaudio/);
  assert.equal(slept, 0);
});

test("the read-back waits for create-kugelaudio when plan publishes it", (t) => {
  const { status, stderr, viewed } = runPublishStep(t, "Read the publication back", {
    distTag: "latest",
    kugelaudioTag: "preview",
    served: [...published3, "create-kugelaudio"],
  });
  assert.equal(status, 0, stderr);
  assert.equal(viewed.at(-1), "create-kugelaudio@9.9.9");
});

test("the read-back keeps asking for ten minutes, then fails on a publication npm does not serve", (t) => {
  const { status, stderr, viewed, slept } = runPublishStep(t, "Read the publication back", {
    distTag: "latest",
    kugelaudioTag: "",
    served: ["curb.js"],
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /npm serves nothing for create-curb\.js@9\.9\.9, expected sha512-/);
  assert.equal(viewed.filter((spec) => spec === "create-curb.js@9.9.9").length, slept);
  assert.ok(slept * 10 >= 600, `the read-back gave up after ${slept} waits`);
});

test("the tag create-kugelaudio gets comes from plan, for every job that needs it", () => {
  assert.match(job("plan"), /CREATE_KUGELAUDIO: \$\{\{ vars\.CREATE_KUGELAUDIO \}\}/);
  assert.match(job("plan"), /kugelaudio_tag: \$\{\{ steps\.version\.outputs\.kugelaudio_tag \}\}/);
  for (const name of ["publish", "installed"]) {
    assert.ok(job(name).includes("KUGELAUDIO_TAG: ${{ needs.plan.outputs.kugelaudio_tag }}"), name);
  }
});

test("the test workflow cannot publish", () => {
  const steps = testYml.replace(/^\s*#.*$/gm, "");
  const publishes = steps.split("\n").filter((line) => /(^|\s)npm publish\s/.test(line));
  assert.equal(publishes.length, 1);
  assert.match(publishes[0], /--dry-run/);
  assert.doesNotMatch(publishes[0], /--tag latest/);
  assert.doesNotMatch(steps, /id-token/);
  assert.doesNotMatch(steps, /^\s*environment:/m);
  assert.doesNotMatch(steps, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
});

test("npm gets ten minutes per package to serve a publication, inside the job's timeout", () => {
  const text = job("publish");
  const attempts = Number(/for attempt in \$\(seq 1 (\d+)\)/.exec(text)?.[1]);
  const seconds = Number(/sleep (\d+)/.exec(text)?.[1]);
  const timeout = Number(/timeout-minutes: (\d+)/.exec(text)?.[1]);
  assert.ok(attempts * seconds >= 600, `the read-back waits ${attempts * seconds} s`);
  assert.ok(timeout * 60 > 4 * attempts * seconds, `${timeout} minutes does not fit all four packages`);
});

// GitHub can refuse GITHUB_TOKEN a ref on a commit whose workflow files differ from main's, and a
// rerun does not clear that. A publish before the tag once left a version on npm that no rerun could
// finish, so the tag has to exist before npm can hear of the version.
test("npm hears of a version only after its tag exists", () => {
  assert.deepEqual(needs("tag"), ["plan", "verify"]);
  assert.ok(needs("publish").includes("tag"));
  assert.ok(needs("release").includes("publish"));
  assert.doesNotMatch(job("tag"), /npm publish/);
  assert.doesNotMatch(job("verify"), /git\/refs/);
});

test("a release and a pull request both run the static browser build", () => {
  assert.match(job("verify"), /run: npm run check:browser\n/);
  assert.match(testYml, /run: npm run check:browser\n/);
});

test("a dry run neither tags nor publishes", () => {
  for (const name of ["tag", "publish"]) assert.match(job(name), /if: \$\{\{ !inputs\.dry_run \}\}/);
});

test("only tag and release can write to the repository, and neither can reach npm", () => {
  const writers = ["plan", "verify", "tag", "publish", "installed", "release"].filter((name) =>
    /contents: write/.test(job(name)),
  );
  assert.deepEqual(writers, ["tag", "release"]);
  for (const name of writers) assert.doesNotMatch(job(name), /id-token/);
});

test("the tag step creates a missing tag", (t) => {
  const result = runTagStep(t, {});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.posted);
});

test("a rerun finds its own tag and goes on", (t) => {
  const result = runTagStep(t, { getRef: "abc" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.posted, false);
});

test("a tag on another commit stops the run", (t) => {
  const result = runTagStep(t, { getRef: "def" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /v9\.9\.9 is already on def/);
  assert.equal(result.posted, false);
});

test("a refused tag stops the run and says what to do instead of a rerun", (t) => {
  const result = runTagStep(t, { postFails: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /nothing was published/);
  assert.match(result.stdout, /a rerun cannot help: start a new run from main/);
});
