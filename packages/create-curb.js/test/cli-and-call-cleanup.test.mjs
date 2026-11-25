// --stt-model names a model for the speech-to-text providers that take one; for the ones
// that take none, the generated agent would not compile, so the flag is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bin = fileURLToPath(new URL("../bin/create-curb.js", import.meta.url));

/** create-curb.js into a fresh folder with the test's flags, no install, no git. */
function create(t, flags) {
  const root = mkdtempSync(join(tmpdir(), "create-curb.js-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "app");
  const result = spawnSync(
    process.execPath,
    [bin, project, ...flags, "--skip-install", "--skip-git", "--framework", "file:/unused"],
    // No provider keys: the test must not write a developer's real keys to disk.
    { cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: "utf8" },
  );
  return { project, result };
}

for (const stt of ["kugelaudio", "azure"]) {
  test(`--stt-model is refused with --stt ${stt}, which takes no model`, (t) => {
    const { project, result } = create(t, ["--stt", stt, "--stt-model", "some-model"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`--stt-model does not apply to --stt ${stt}`));
    assert.equal(existsSync(project), false);
  });
}

test("--stt-model is refused with the default speech-to-text, which takes no model", (t) => {
  const { result } = create(t, ["--stt-model", "some-model"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--stt-model does not apply to --stt kugelaudio/);
});

test("--stt-model is written for a provider that takes a model", (t) => {
  const { project, result } = create(t, ["--stt", "deepgram", "--stt-model", "nova-2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(project, "src/agent/agent.tsx"), "utf8"), /stt=\{deepgram\.stt\(\{ model: "nova-2" \}\)\}/);
});
