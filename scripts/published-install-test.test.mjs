import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isRegistryLag,
  PACKAGES,
  publishedNames,
  retryOnRegistryLag,
  SERVE_DEADLINE_MS,
  waitForRelease,
} from "./published-install-test.mjs";

const wait = async () => {};
const publishYml = readFileSync(fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url)), "utf8");

/** The text of one job, up to the next job or the end of the file. */
function job(name) {
  const start = publishYml.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `publish.yml has no ${name} job`);
  const next = publishYml.slice(start + 1).search(/\n {2}(?:# .*\n {2})*[a-z]+:\n/);
  return next === -1 ? publishYml.slice(start) : publishYml.slice(start, start + 1 + next);
}

test("every package publish.yml sends is waited for", () => {
  assert.ok(publishYml.includes(`for name in ${PACKAGES.join(" ")}; do`));
});

/** A clock that only moves when the code under test sleeps, so a ten-minute wait takes no time. */
function fakeClock() {
  const clock = { at: 0, sleeps: [], lines: [] };
  clock.now = () => clock.at;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.at += ms;
  };
  clock.log = (line) => clock.lines.push(line);
  return clock;
}

const tarball = (spec) => {
  const [name, version] = spec.split("@");
  return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
};

test("waiting ends once every package names its tarball and that tarball answers", async () => {
  const clock = fakeClock();
  const views = [];
  const probes = [];
  // curb.js is served at once; create-curb.js is unknown to `npm view` once, then its tarball
  // 404s twice (the failure seen after real publishes), then answers.
  const viewTarball = async (spec) => {
    views.push(spec);
    if (spec === "create-curb.js@1.20.0" && views.filter((v) => v === spec).length === 1) {
      throw Object.assign(new Error("npm view failed"), { output: "npm error code E404" });
    }
    return `${tarball(spec)}\n`;
  };
  const probe = async (url) => {
    probes.push(url);
    const seen = probes.filter((p) => p === url).length;
    return url.includes("create-curb.js-") && seen <= 2 ? 404 : 200;
  };
  await waitForRelease(["curb.js", "create-curb.js", "create-curb"], "1.20.0", { viewTarball, probe, ...clock });

  assert.deepEqual(views, [
    "curb.js@1.20.0",
    "create-curb.js@1.20.0",
    "create-curb.js@1.20.0",
    "create-curb.js@1.20.0",
    "create-curb.js@1.20.0",
    "create-curb@1.20.0",
  ]);
  assert.deepEqual(clock.sleeps, [5_000, 10_000, 20_000], "the pause doubles");
  assert.ok(clock.lines.some((line) => /try 1: npm view names no tarball/.test(line)));
  assert.ok(clock.lines.some((line) => /create-curb\.js-1\.20\.0\.tgz answers 404; next try in 10 s/.test(line)));
  assert.ok(clock.lines.includes(`create-curb@1.20.0 is on npm: ${tarball("create-curb@1.20.0")}`));
});

test("the pause backs off to a minute and the wait gives up at the deadline, naming the package", async () => {
  const clock = fakeClock();
  const probe = async (url) => (url.includes("create-curb-") ? 404 : 200);
  await assert.rejects(
    waitForRelease(["curb.js", "create-curb"], "1.19.1", { viewTarball: async (s) => tarball(s), probe, ...clock }),
    (error) => {
      assert.match(error.message, /^the npm registry has not served create-curb@1\.19\.1 after 10 minutes/);
      assert.match(error.message, /create-curb-1\.19\.1\.tgz answers 404/);
      return true;
    },
  );
  assert.equal(clock.at, SERVE_DEADLINE_MS, "it waits the whole deadline and not a moment past it");
  assert.equal(Math.max(...clock.sleeps), 60_000);
  assert.deepEqual(clock.sleeps.slice(0, 5), [5_000, 10_000, 20_000, 40_000, 60_000]);
});

test("a probe that throws counts as not served yet", async () => {
  const clock = fakeClock();
  let probes = 0;
  const probe = async () => {
    probes += 1;
    if (probes === 1) throw new Error("socket hang up");
    return 200;
  };
  await waitForRelease(["curb.js"], "1.0.0", { viewTarball: async (s) => tarball(s), probe, ...clock });
  assert.equal(probes, 2);
  assert.ok(clock.lines.some((line) => /answers socket hang up/.test(line)));
});

const npmFailure = (output) => Object.assign(new Error("npm create exited with 1"), { output });

test("E404 and ETARGET read as the registry lagging, any other failure does not", () => {
  assert.ok(isRegistryLag(npmFailure("npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x")));
  assert.ok(isRegistryLag(npmFailure("npm error code ETARGET\nnpm error notarget No matching version")));
  assert.ok(!isRegistryLag(npmFailure("npm error code EINTEGRITY")));
  assert.ok(!isRegistryLag(new Error("release install test: npm create curb@1.0.0 wrote a different project")));
  assert.ok(!isRegistryLag(undefined));
});

test("an install that meets a lagging registry is tried again, up to three times", async () => {
  let tries = 0;
  const lagging = async () => {
    tries += 1;
    if (tries < 3) throw npmFailure("npm error code E404");
    return "installed";
  };
  assert.equal(await retryOnRegistryLag(lagging, { wait, log: () => {} }), "installed");
  assert.equal(tries, 3);

  tries = 0;
  await assert.rejects(
    retryOnRegistryLag(
      async () => {
        tries += 1;
        throw npmFailure("npm error code ETARGET");
      },
      { wait, log: () => {} },
    ),
    /exited with 1/,
  );
  assert.equal(tries, 3);
});

test("any other install failure is reported at once, without another try", async () => {
  let tries = 0;
  await assert.rejects(
    retryOnRegistryLag(
      async () => {
        tries += 1;
        throw npmFailure("npm error code EINTEGRITY");
      },
      { wait, log: () => {} },
    ),
    /exited with 1/,
  );
  assert.equal(tries, 1);
});

test("the install check needs the publish, and holds back neither the tag nor the release", () => {
  const installed = job("installed");
  assert.match(installed, /needs: \[plan, publish\]/);
  assert.doesNotMatch(job("tag"), /installed/);
  assert.doesNotMatch(job("release"), /installed/);
});

test("the install check runs for every channel with no publishing rights, on a GitHub-hosted runner", () => {
  const installed = job("installed");
  assert.match(installed, /runs-on: ubuntu-24\.04/);
  assert.match(installed, /node scripts\/published-install-test\.mjs "\$VERSION"/);
  assert.doesNotMatch(installed, /^\s*if:/m, "a condition could skip it on one channel");
  assert.doesNotMatch(installed, /id-token|^\s*environment:|secrets\.|NODE_AUTH_TOKEN|contents: write/m);
  assert.match(installed, /permissions:\n\s+contents: read/);
});

test("the install check's timeout fits the wait and the install after it", () => {
  const minutes = Number(/timeout-minutes: (\d+)/.exec(job("installed"))?.[1]);
  assert.ok(minutes * 60_000 >= SERVE_DEADLINE_MS + 15 * 60_000, `${minutes} minutes leaves the install too little time`);
});

test("the install test waits for create-kugelaudio only when this run published it", () => {
  assert.deepEqual(publishedNames(""), ["curb.js", "create-curb.js", "create-curb"]);
  assert.deepEqual(publishedNames(undefined), ["curb.js", "create-curb.js", "create-curb"]);
  assert.deepEqual(publishedNames("preview"), PACKAGES);
});
