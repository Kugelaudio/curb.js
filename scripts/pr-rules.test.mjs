import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEPENDABOT_LOGIN, MAX_TITLE_LENGTH, TYPES, bodyErrors, titleErrors } from "./pr-rules.mjs";

const SCRIPT = fileURLToPath(new URL("./pr-rules.mjs", import.meta.url));
const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../.github/pull_request_template.md", import.meta.url)),
  "utf8",
);

const DEPENDABOT_TITLES = [
  "chore(deps): Bump ai from 6.0.311 to 7.0.155",
  "chore(deps): Bump vite from 7.3.7 to 8.3.5",
  "chore(deps): Bump the minor-and-patch group with 33 updates",
  "chore(deps): Bump typescript from 6.0.3 to 7.0.2 in /website",
  "chore(deps): Bump the minor-and-patch group in /website with 2 updates",
  "ci(deps): Bump actions/checkout from 6.1.0 to 7.0.1",
];

/** Runs the script as the workflow does, on an event payload written to a file. */
function run(pullRequest, directory, event = {}) {
  const path = join(directory, "event.json");
  writeFileSync(path, JSON.stringify({ ...event, pull_request: pullRequest }));
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_PATH: path },
  });
}

test("every type is accepted, with or without a scope and a !", () => {
  for (const type of TYPES) {
    assert.deepEqual(titleErrors(`${type}: add a thing`), []);
    assert.deepEqual(titleErrors(`${type}(framework): add a thing`), []);
    assert.deepEqual(titleErrors(`${type}!: add a thing`), []);
    assert.deepEqual(titleErrors(`${type}(create-curb-app)!: add a thing`), []);
  }
});

test("titles already used in this repository pass", () => {
  for (const title of [
    "docs(examples): add a README to livekit-pipeline",
    "feat(website): search and share metadata for curbjs.com",
    "ci: add a gate job as the required check",
  ]) {
    assert.deepEqual(titleErrors(title), []);
  }
});

test("a title outside the format names the rule and shows a valid example", () => {
  for (const title of [
    "",
    "add a thing",
    "feature: add a thing",
    "style: add a thing",
    "Feat: add a thing",
    "feat add a thing",
    "feat:add a thing",
    "feat(): add a thing",
    "feat(a b): add a thing",
    "feat!(framework): add a thing",
    "[test] add a thing",
    'Revert "feat: add a thing"',
  ]) {
    const [error, ...rest] = titleErrors(title);
    assert.deepEqual(rest, [], title);
    assert.match(error, /^title-format: /, title);
    assert.match(error, /valid example: feat\(framework\): /, title);
  }
});

test("the subject starts lowercase and has no trailing period", () => {
  assert.match(titleErrors("feat: Add a thing")[0], /^title-subject: .*lowercase/);
  assert.match(titleErrors("feat: `curb dev` reloads")[0], /^title-subject: .*lowercase/);
  assert.match(titleErrors("feat:  add a thing")[0], /^title-subject: .*lowercase/);
  assert.match(titleErrors("feat: add a thing.")[0], /^title-subject: .*period/);
  assert.equal(titleErrors("feat: Add a thing.").length, 2);
  assert.deepEqual(titleErrors("feat: über alles"), []);
});

test("the whole title is at most the limit, counted in characters", () => {
  const padded = (length) => "fix: ".padEnd(length, "a");
  assert.deepEqual(titleErrors(padded(MAX_TITLE_LENGTH)), []);
  assert.match(titleErrors(padded(MAX_TITLE_LENGTH + 1))[0], /^title-length: the title is 101 /);
  assert.deepEqual(titleErrors("fix: ".padEnd(MAX_TITLE_LENGTH - 2, "a") + "🙂🙂"), []);
});

test("a body with any text of its author's passes", () => {
  assert.deepEqual(bodyErrors("Fixes the thing."), []);
  assert.deepEqual(bodyErrors("## Summary\n\nFixes the thing."), []);
  assert.deepEqual(bodyErrors(TEMPLATE.replace("## Why\n", "## Why\n\nBecause it broke.\n")), []);
  assert.deepEqual(bodyErrors("## What\n\nFixes the thing.\n\n## Why\n"), []);
});

test("a heading the template does not have is the author's text", () => {
  assert.deepEqual(bodyErrors("## Summary"), []);
});

test("an empty body fails", () => {
  for (const body of [null, undefined, "", " \n\t\n"]) {
    assert.match(bodyErrors(body)[0], /^body-empty: /);
  }
});

test("comments do not count, closed or not", () => {
  assert.equal(bodyErrors("<!-- nothing\nyet -->").length, 1);
  assert.equal(bodyErrors("## What\n<!-- left open").length, 1);
});

test("the untouched template fails, however its checklist is ticked", () => {
  assert.equal(bodyErrors(TEMPLATE).length, 1);
  assert.equal(bodyErrors(TEMPLATE.replaceAll("\n", "\r\n")).length, 1);
  assert.equal(bodyErrors(TEMPLATE.replaceAll("- [ ]", "- [x]")).length, 1);
  assert.equal(bodyErrors(TEMPLATE.replaceAll("- [ ]", "- [X]")).length, 1);
});

test("the script reports every broken rule and exits non-zero", () => {
  const directory = mkdtempSync(join(tmpdir(), "pr-rules-"));
  try {
    const result = run({ title: "Add a thing.", body: null }, directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /title-format: /);
    assert.match(result.stderr, /body-empty: /);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("the script passes a compliant pull request", () => {
  const directory = mkdtempSync(join(tmpdir(), "pr-rules-"));
  try {
    const result = run({ title: "fix: add a thing", body: "Fixes the thing." }, directory);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("shell metacharacters in a title and body are only text", () => {
  const directory = mkdtempSync(join(tmpdir(), "pr-rules-"));
  try {
    const payload = `$(touch pwned) \`touch pwned\`; touch pwned && touch pwned | "'`;

    const valid = run({ title: `fix: stop ${payload}`, body: payload }, directory);
    assert.equal(valid.status, 0, valid.stderr);

    const invalid = run({ title: payload, body: payload }, directory);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /^title-/);
    assert.ok(!invalid.stdout.includes(payload) && !invalid.stderr.includes(payload));

    assert.equal(existsSync(join(directory, "pwned")), false);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("Dependabot's real titles pass, and only for its exact login", () => {
  for (const title of DEPENDABOT_TITLES) {
    assert.ok([...title].length <= MAX_TITLE_LENGTH, title);
    assert.deepEqual(titleErrors(title, DEPENDABOT_LOGIN), [], title);
    for (const author of [
      undefined,
      null,
      "",
      "someone",
      "dependabot",
      "Dependabot[bot]",
      "dependabot[bot] ",
      "dependabot-preview[bot]",
      "not-dependabot[bot]",
    ]) {
      assert.match(titleErrors(title, author)[0], /^title-subject: .*lowercase/, `${author}`);
    }
  }
});

test("a person's capitalised subject still fails", () => {
  assert.match(titleErrors("chore(deps): Bump ai from 6.0.311 to 7.0.155", "someone")[0], /lowercase/);
  assert.match(titleErrors("feat: Add a thing", "someone")[0], /^title-subject: /);
});

test("every other title rule still applies to Dependabot", () => {
  const check = (title) => titleErrors(title, DEPENDABOT_LOGIN);
  assert.match(check("Bump ai from 6.0.311 to 7.0.155")[0], /^title-format: /);
  assert.match(check("deps: Bump ai from 6.0.311 to 7.0.155")[0], /^title-format: /);
  assert.match(check("chore(deps): Bump ai from 6.0.311 to 7.0.155.")[0], /^title-subject: .*period/);
  assert.match(check("chore(deps): Bump ".padEnd(MAX_TITLE_LENGTH + 1, "a"))[0], /^title-length: /);
});

test("the body rule still applies to Dependabot, whose real bodies pass it", () => {
  assert.deepEqual(bodyErrors("Bumps [ai](https://example.com) from 6.0.311 to 7.0.155."), []);
  assert.deepEqual(bodyErrors("Bumps the minor-and-patch group with 33 updates:"), []);
  assert.equal(bodyErrors("").length, 1);
});

test("the script takes the author from the pull request and from nowhere else", () => {
  const directory = mkdtempSync(join(tmpdir(), "pr-rules-"));
  try {
    const pullRequest = { title: DEPENDABOT_TITLES[0], body: "Bumps ai." };

    const dependabot = { ...pullRequest, user: { login: DEPENDABOT_LOGIN } };
    assert.equal(run(dependabot, directory).status, 0);

    const person = { ...pullRequest, user: { login: "someone" } };
    assert.equal(run(person, directory).status, 1);
    assert.equal(run(person, directory, { sender: { login: DEPENDABOT_LOGIN } }).status, 1);
    assert.equal(
      run({ ...person, head: { ref: "dependabot/npm_and_yarn/ai-7.0.155" } }, directory).status,
      1,
    );
    assert.equal(run({ ...person, title: `chore: Bump ${DEPENDABOT_LOGIN}` }, directory).status, 1);

    assert.equal(run({ ...pullRequest, user: null }, directory).status, 1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
