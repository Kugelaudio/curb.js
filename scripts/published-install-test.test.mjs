import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { waitForVersion, withRetries } from "./published-install-test.mjs";

const wait = async () => {};
const publishYml = readFileSync(fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url)), "utf8");

/** The text of one job, up to the next job or the end of the file. */
function job(name) {
  const start = publishYml.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `publish.yml has no ${name} job`);
  const next = publishYml.slice(start + 1).search(/\n {2}(?:# .*\n {2})*[a-z]+:\n/);
  return next === -1 ? publishYml.slice(start) : publishYml.slice(start, start + 1 + next);
}

test("waiting ends as soon as npm serves the version, through a lag and an error", async () => {
  const answers = ["", "1.0.0", "1.1.0", "unreached"];
  let reads = 0;
  const read = async () => {
    reads += 1;
    if (reads === 1) throw new Error("E404");
    return answers[reads - 1];
  };
  await waitForVersion("curb.js@1.1.0", "1.1.0", read, { wait });
  assert.equal(reads, 3);
});

test("waiting gives up, naming what npm served", async () => {
  await assert.rejects(
    waitForVersion("curb.js@1.1.0", "1.1.0", async () => "1.0.0", { attempts: 2, wait }),
    /npm serves 1\.0\.0 for curb\.js@1\.1\.0 after 2 tries/,
  );
  await assert.rejects(
    waitForVersion("curb.js@9.9.9", "9.9.9", () => Promise.reject(new Error("E404")), { attempts: 2, wait }),
    /npm serves nothing for curb\.js@9\.9\.9/,
  );
});

test("a task is retried, and its last failure is the one reported", async () => {
  let tries = 0;
  const lagging = async () => {
    tries += 1;
    if (tries < 3) throw new Error(`no ${tries}`);
    return "installed";
  };
  assert.equal(await withRetries(lagging, { wait }), "installed");
  await assert.rejects(
    withRetries(async () => Promise.reject(new Error("still broken")), { attempts: 2, wait }),
    /still broken/,
  );
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

test("the install check's timeout fits the wait for both packages", () => {
  const minutes = Number(/timeout-minutes: (\d+)/.exec(job("installed"))?.[1]);
  assert.ok(minutes * 60 > 2 * 60 * 10, `${minutes} minutes is shorter than the wait alone`);
});
