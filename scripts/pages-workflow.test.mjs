// The checks below read pages.yml as text, the way publish-workflow.test.mjs reads publish.yml.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pagesYml = readFileSync(fileURLToPath(new URL("../.github/workflows/pages.yml", import.meta.url)), "utf8");

test("pull requests do not share a concurrency group, and a deploy is never cancelled", () => {
  const group = /^ {2}group: (.+)$/m.exec(pagesYml)?.[1];
  assert.ok(group?.includes("github.event.pull_request.number"), "one group across pull requests cancels their checks");
  assert.doesNotMatch(group, /github\.run_id/);
  const cancel = /^ {2}cancel-in-progress: (.+)$/m.exec(pagesYml)?.[1];
  assert.equal(cancel, "${{ github.event_name == 'pull_request' }}");
});
