// A fork's pull request is code nobody here has reviewed, and a self-hosted runner persists between
// jobs. So every job has to name a GitHub-hosted runner, or take its runs-on from the expression
// below, which allows a self-hosted runner only for what is listed and sends the rest to a hosted
// one. Skipping a job for a fork is no way out: gate passes a skipped job, so a fork could merge
// untested. The checks below read every workflow as text, as publish-workflow.test.mjs does.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflows = fileURLToPath(new URL("../.github/workflows", import.meta.url));

const FORK_TO = "ubuntu-24.04";

/** The one runs-on allowed to name a self-hosted runner. */
const forkSafeRunsOn = (label) =>
  "${{ (github.event_name == 'push' || github.event_name == 'workflow_dispatch' || " +
  "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)) " +
  `&& '${label}' || '${FORK_TO}' }}`;

/** The self-hosted label of a fork-safe runs-on, or null for anything else. */
function selfHostedLabel(runsOn) {
  const label = /&& '([^']+)' \|\| /.exec(runsOn)?.[1];
  return label && !isHosted(label) && runsOn === forkSafeRunsOn(label) ? label : null;
}

const isHosted = (runsOn) => /^(ubuntu|windows|macos)-[\w.-]+$/.test(runsOn);

/** `{ name, body }` for each job of a workflow's text. */
function jobsOf(text) {
  const parts = text.slice(text.indexOf("\njobs:\n")).split(/^ {2}([\w-]+):\n/m);
  return parts.slice(1).flatMap((part, index, all) => (index % 2 ? [] : [{ name: part, body: all[index + 1] }]));
}

/** Everything after `runs-on:`, or null for a job that has none, such as a reusable workflow's. */
const runsOnOf = ({ body }) => /^ {4}runs-on:(.*)$/m.exec(body)?.[1].trim() ?? null;

/** Fork-safe means GitHub-hosted, or the expression. A list, a group, a matrix value or a bare label is not. */
const isForkSafe = (runsOn) => runsOn !== null && (isHosted(runsOn) || selfHostedLabel(runsOn) !== null);

const allJobs = readdirSync(workflows).flatMap((file) =>
  jobsOf(readFileSync(join(workflows, file), "utf8")).map((job) => ({ ...job, file, runsOn: runsOnOf(job) })),
);

/** What the runner takes the expression to. `==` and null behave here as they do on GitHub, except
 * null == '', which no case reaches because github.repository is never empty. */
function runnerFor(runsOn, github) {
  const body = runsOn
    .replace(/^\$\{\{|\}\}$/g, "")
    .replaceAll("github.event.pull_request.head.repo.full_name", "github.event.pull_request?.head?.repo?.full_name");
  return new Function("github", `return ${body};`)(github);
}

const repository = "acme/curb.js";
const pullRequest = (full_name) => ({ pull_request: { head: { repo: full_name ? { full_name } : null } } });

/** Each kind of run, and whether it may reach a self-hosted runner. */
const RUNS = [
  ["a pull request from a branch here", "pull_request", pullRequest(repository), true],
  ["a Dependabot pull request, whose branch is here", "pull_request", pullRequest(repository), true],
  ["a push to main", "push", {}, true],
  ["a dispatch", "workflow_dispatch", {}, true],
  ["a pull request from a fork", "pull_request", pullRequest("someone/curb.js"), false],
  ["a pull request whose fork was deleted", "pull_request", pullRequest(null), false],
  ["a pull request with no head in its event", "pull_request", {}, false],
  ["a fork's pull_request_target", "pull_request_target", pullRequest("someone/curb.js"), false],
  ["a pull_request_target from here", "pull_request_target", pullRequest(repository), false],
  ["an event nobody listed", "schedule", {}, false],
  ["a run with no event name", "", {}, false],
];

test("the jobs on self-hosted runners are the ones this test knows, so its parser still finds them", () => {
  const selfHosted = allJobs.filter(({ runsOn }) => !isHosted(runsOn)).map(({ file, name }) => `${file}:${name}`);
  assert.deepEqual(selfHosted.sort(), [
    "pages.yml:build",
    "pages.yml:deploy",
    "test.yml:affected",
    "test.yml:gate",
    "test.yml:test",
    "test.yml:website",
  ]);
});

test("every job in every workflow is fork-safe", () => {
  for (const { file, name, runsOn } of allJobs) {
    assert.ok(isForkSafe(runsOn), `${file}: job ${name} has runs-on ${runsOn}. Use forkSafeRunsOn's expression.`);
  }
});

test("every self-hosted job lands where each kind of run should", () => {
  const expressions = allJobs.map(({ runsOn }) => runsOn).filter((runsOn) => !isHosted(runsOn));
  for (const runsOn of expressions) {
    const label = selfHostedLabel(runsOn);
    for (const [what, event_name, event, selfHosted] of RUNS) {
      const expected = selfHosted ? label : FORK_TO;
      assert.equal(runnerFor(runsOn, { event_name, event, repository }), expected, what);
    }
  }
});

test("each runner takes the same jobs it took before forks were routed", () => {
  const label = (file, job) => selfHostedLabel(allJobs.find((j) => j.file === file && j.name === job).runsOn);
  assert.equal(label("test.yml", "affected"), "curb-js-light");
  assert.equal(label("test.yml", "gate"), "curb-js-light");
  assert.equal(label("test.yml", "test"), "curb-js-runner");
  assert.equal(label("test.yml", "website"), "curb-js-runner");
  assert.equal(label("pages.yml", "build"), "curb-js-runner");
  assert.equal(label("pages.yml", "deploy"), "curb-js-runner");
});

test("the check refuses a runs-on that can put a fork on a self-hosted runner", () => {
  for (const runsOn of [
    "curb-js-runner",
    "self-hosted",
    "[self-hosted, linux]",
    "${{ matrix.runner }}",
    "",
    null,
    // Fails open: on an event with no head the check reads as not a fork.
    "${{ github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || 'curb-js-runner' }}",
    // Fails open: everything but pull_request is trusted, pull_request_target included.
    "${{ github.event_name != 'pull_request' && 'curb-js-runner' || 'ubuntu-24.04' }}",
    // Trusts the event alone.
    "${{ github.event_name == 'pull_request' && 'curb-js-runner' || 'ubuntu-24.04' }}",
    // The hosted fallback is itself self-hosted.
    forkSafeRunsOn("curb-js-runner").replace(`'${FORK_TO}'`, "'curb-js-light'"),
  ]) {
    assert.equal(isForkSafe(runsOn), false, String(runsOn));
  }
  assert.equal(isForkSafe(forkSafeRunsOn(FORK_TO)), false, "a hosted label inside the expression says nothing");
  assert.equal(isForkSafe("ubuntu-24.04"), true);
});

test("the check sees a job added at the end of a workflow, and one with no runs-on", () => {
  const text = "name: x\n\njobs:\n  one:\n    runs-on: ubuntu-24.04\n  two:\n    uses: ./.github/workflows/x.yml\n";
  const jobs = jobsOf(text);
  assert.deepEqual(jobs.map(({ name }) => name), ["one", "two"]);
  assert.equal(isForkSafe(runsOnOf(jobs[1])), false);
});

test("no job is skipped for a fork, because gate would pass it", () => {
  for (const { file, name, body } of allJobs) {
    const conditions = body.split("\n").filter((line) => /^\s*(- )?if:/.test(line));
    for (const condition of conditions) {
      assert.doesNotMatch(condition, /head\.repo|\.fork\b|github\.repository/, `${file}: job ${name}`);
    }
  }
});

test("every checkout leaves no credentials behind", () => {
  for (const { file, name, body } of allJobs) {
    for (const [step] of body.matchAll(/^ {6}- uses: actions\/checkout@.*\n(?: {8}.*\n)*/gm)) {
      assert.match(step, /^ {10}persist-credentials: false$/m, `${file}: job ${name}`);
    }
  }
});
