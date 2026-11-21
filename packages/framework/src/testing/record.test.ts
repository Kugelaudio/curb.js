import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saved } from "../test-fixtures/conversations.js";
import { KEPT_TEST_RUNS, loadTestRun, newTestRunId, saveTestRun, savedTestRunIds, testRunPath, type SavedTestRun } from "./record.js";

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "curb-test-runs-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (id: string, overrides: Partial<SavedTestRun> = {}): SavedTestRun => ({
  format: "curb.test-run",
  version: 1,
  id,
  createdAt: "2030-01-01T00:00:00.000Z",
  curb: "1.0.0",
  complete: true,
  models: { agent: "openai:gpt-5.2", caller: "openai:gpt-5.4-mini", judge: "openai:gpt-5.4-mini" },
  callerPromptVersion: "2",
  judgePromptVersion: "1",
  maxErrorRate: 0.2,
  scenarios: [],
  conversations: [saved(1, "pass")],
  ...overrides,
});

describe("saved test runs", () => {
  it("are one JSON file per run under .curb/test-runs, read back as they were written", () => {
    const root = project();
    const written = run("20300101T000000Z-ab12");
    saveTestRun(root, written);

    expect(testRunPath(written.id)).toBe(".curb/test-runs/20300101T000000Z-ab12.json");
    expect(JSON.parse(readFileSync(join(root, testRunPath(written.id)), "utf8"))).toEqual(written);
    expect(loadTestRun(root, written.id)).toEqual(written);
    expect(loadTestRun(root, "latest")).toEqual(written);
    expect(loadTestRun(root, testRunPath(written.id))).toEqual(written);
    // No half-written file is left beside it.
    expect(readdirSync(join(root, ".curb/test-runs"))).toEqual(["20300101T000000Z-ab12.json"]);
  });

  it("name the newest as latest and keep only the newest runs", () => {
    const root = project();
    const ids = Array.from({ length: KEPT_TEST_RUNS + 2 }, (_, index) => `20300101T0000${String(index).padStart(2, "0")}Z-aaaa`);
    for (const id of ids) saveTestRun(root, run(id));

    expect(savedTestRunIds(root)).toHaveLength(KEPT_TEST_RUNS);
    expect(savedTestRunIds(root)[0]).toBe(ids.at(-1));
    expect(savedTestRunIds(root)).not.toContain(ids[0]);
    expect(loadTestRun(root, "latest").id).toBe(ids.at(-1));
  });

  it("get an id that sorts by when the run started", () => {
    expect(newTestRunId(new Date("2030-01-02T03:04:05.678Z"))).toMatch(/^20300102T030405678Z-[a-z0-9]{4}$/);
  });

  it("refuse a run that is not there, naming the ones that are, and a file of another format", () => {
    const root = project();
    expect(() => loadTestRun(root, "latest")).toThrow(
      "[CURB_TEST_RUN_NOT_FOUND] No saved test run in .curb/test-runs.\nFix: This project has no saved runs yet: run `npx curb test` first.",
    );
    saveTestRun(root, run("20300101T000000Z-ab12"));
    expect(() => loadTestRun(root, "20290101T000000Z-zzzz")).toThrow(
      '[CURB_TEST_RUN_NOT_FOUND] No saved test run at .curb/test-runs/20290101T000000Z-zzzz.json.\nFix: The saved runs are: 20300101T000000Z-ab12 (newest first; "latest" names the first).',
    );

    mkdirSync(join(root, "exports"));
    writeFileSync(join(root, "exports/calls.json"), JSON.stringify({ calls: [] }));
    expect(() => loadTestRun(root, "exports/calls.json")).toThrow(
      '[CURB_TEST_RUN_UNREADABLE] exports/calls.json is not a saved test run this version reads: its format is not "curb.test-run".',
    );
    writeFileSync(join(root, "exports/newer.json"), JSON.stringify({ ...run("x"), version: 2 }));
    expect(() => loadTestRun(root, "exports/newer.json")).toThrow("it is version 2 of the format, and this is version 1");
  });
});
