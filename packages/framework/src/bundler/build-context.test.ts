import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCurbBuild } from "./index.js";
import { projectContextFiles } from "./context-registry.js";

/**
 * The packaging half of the same failure: a bundle that compiles cleanly and carries none
 * of the project's `context/` markdown. `@vercel/nft` cannot see these files — it traces
 * JavaScript imports and the runtime reads them by path — so nothing but this wiring puts
 * them in the artifact.
 *
 * Trace and verify are skipped: this asserts what the BUNDLE contains, and the runtime
 * tree behind those steps is ~280 MB that says nothing about it.
 */

const fixtureProject = resolve(import.meta.dirname, "..", "test-fixtures", "project");

let outDir: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "curb-build-context-"));
  outDir = join(root, "standalone");
  await runCurbBuild({ projectRoot: fixtureProject, outDir, skipTrace: true, skipVerify: true });
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * One emitted entry, found through the manifest rather than through the repo layout.
 *
 * The entry directory is `entryHome` in index.ts: the framework root relative to the trace
 * base, so it is a function of where the framework sits in the repository. Spelling it out
 * here made these tests fail the day the repo was restructured, against a build that was
 * perfectly correct — the manifest names the runnable entry, so ask it.
 */
const entry = (name: string): string => {
  const manifest = JSON.parse(readFileSync(join(outDir, "curb.bundle.json"), "utf8")) as {
    entrypoint: string;
  };
  return readFileSync(join(dirname(join(outDir, manifest.entrypoint)), name), "utf8");
};

/**
 * A distinctive line of the file, not its `src` key.
 *
 * The key alone is a false green: the skills' own `?raw` sources are inlined too, and
 * they contain the literal `<Text src="policy/coverage-basics.md" />`. Only the file's
 * TEXT proves the markdown itself travelled.
 */
const distinctiveLine = (src: string): string =>
  readFileSync(join(fixtureProject, "context", src), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 20)[0];

describe("curb build packaging of context markdown", () => {
  it("carries every context file the project declares, in the RUNNABLE entry", () => {
    const declared = projectContextFiles(fixtureProject);
    expect(declared.length).toBeGreaterThan(0);

    const worker = entry("worker.mjs");
    for (const src of declared) {
      expect(worker).toContain(distinctiveLine(src));
    }
  });

  it("writes the agent's goals, experiments and hooks into the manifest even with verify skipped, [] when none", () => {
    const manifest = JSON.parse(readFileSync(join(outDir, "curb.bundle.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.goals).toEqual([]);
    expect(manifest.experiments).toEqual([]);
    expect(manifest.hooks).toEqual([]);
  });
});
