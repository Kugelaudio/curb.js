import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactVerificationError,
  WORKER_START_MARKER,
  verificationIsolationRoot,
  readManifestEntrypoint,
  verifyArtifactStarts,
} from "./verify.js";

/**
 * Synthetic artifacts, not real builds: every case here is about what the CHECK does
 * with an entrypoint that behaves a certain way, and a 650 MB tree would only make the
 * same assertions slower. The two shapes that shipped broken artifacts are covered
 * literally -- an entrypoint that exits 0 having started nothing, and a manifest naming
 * a file other than the runnable one.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "curb-verify-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An artifact root: a manifest naming `entrypoint`, and files at their declared paths. */
function writeArtifact(
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
  parent = root,
): string {
  const outDir = join(parent, "artifact");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "curb.bundle.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  for (const [path, source] of Object.entries(files)) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
  }
  return outDir;
}

/** A stand-in worker: prints the marker the real one logs, then stays up. */
const STARTS_A_WORKER = [
  `console.log(JSON.stringify({ level: 30, msg: "starting worker" }));`,
  // Hold the process open the way a worker does, so the check has to kill it rather
  // than watch it exit.
  `setInterval(() => {}, 1000);`,
].join("\n");

/** The library-entry shape: exits cleanly, starts nothing. */
const EXITS_WITHOUT_STARTING = `console.log("bundled 41 modules");\nprocess.exit(0);\n`;

const verify = (outDir: string, timeoutMs = 20_000) =>
  verifyArtifactStarts({ outDir, timeoutMs, isolationRoot: root });

/**
 * A stand-in worker that also answers the render self-check, reporting `files` as the
 * context markdown it carries. The real one builds that report in `runHostedRenderCheck`.
 */
const workerReporting = (files: string[], errors: string[] = []): string =>
  [
    `if (process.argv.includes("curb-render-check")) {`,
    `  console.log("curb-render-check " + JSON.stringify({`,
    `    skills: ["/"],`,
    `    contextFiles: ${JSON.stringify(files)},`,
    `    contextDocs: ${JSON.stringify(files.map((src) => ({ skill: "/", src, chars: 12 })))},`,
    `    errors: ${JSON.stringify(errors)},`,
    `  }));`,
    `  process.exit(${errors.length > 0 ? 1 : 0});`,
    `}`,
    STARTS_A_WORKER,
  ].join("\n");

const verifyRendering = (outDir: string, expectedContextFiles: string[], timeoutMs = 20_000) =>
  verifyArtifactStarts({ outDir, timeoutMs, isolationRoot: root, expectedContextFiles });

describe("verifyArtifactStarts", () => {
  it("passes when the declared entrypoint starts a worker", async () => {
    const outDir = writeArtifact(
      { entrypoint: "packages/framework/entry/worker.mjs" },
      { "packages/framework/entry/worker.mjs": STARTS_A_WORKER },
    );

    const result = await verify(outDir);

    expect(result.entrypoint).toBe("packages/framework/entry/worker.mjs");
    expect(result.output).toContain(WORKER_START_MARKER);
  });

  it("fails when the entrypoint exits without starting a worker", async () => {
    const outDir = writeArtifact(
      { entrypoint: "entry/hosted.mjs" },
      { "entry/hosted.mjs": EXITS_WITHOUT_STARTING },
    );

    await expect(verify(outDir)).rejects.toThrowError(
      /exited with code 0 without starting a worker/,
    );
  });

  it("fails when the entrypoint runs forever without starting a worker", async () => {
    const outDir = writeArtifact(
      { entrypoint: "entry/hosted.mjs" },
      { "entry/hosted.mjs": `console.log("thinking about it");\nsetInterval(() => {}, 100);\n` },
    );

    await expect(verify(outDir, 2_000)).rejects.toThrowError(/did not start a worker within 2s/);
  });

  // The manifest naming the wrong file IS one of the bugs, so the check must follow the
  // manifest even when a runnable entry sits right next to the one it names.
  it("runs the entrypoint the manifest declares, not the runnable neighbour", async () => {
    const outDir = writeArtifact(
      { entrypoint: "entry/hosted.mjs" },
      {
        "entry/hosted.mjs": EXITS_WITHOUT_STARTING,
        "entry/worker.mjs": STARTS_A_WORKER,
      },
    );

    await expect(verify(outDir)).rejects.toThrowError(/"entry\/hosted\.mjs"/);
  });

  it("fails when the declared entrypoint is missing from the artifact", async () => {
    const outDir = writeArtifact({ entrypoint: "entry/worker.mjs" });

    await expect(verify(outDir)).rejects.toThrowError(/does not exist in the artifact/);
  });

  it("runs the artifact outside the directory it was built in", async () => {
    // Whatever the entrypoint sees as its own location must not be the build output:
    // in place, Node resolves against the real install above it and a missing package
    // still loads.
    const buildRoot = join(root, "build");
    mkdirSync(join(buildRoot, "node_modules"), { recursive: true });
    const outDir = writeArtifact(
      { entrypoint: "entry/worker.mjs" },
      {
        "entry/worker.mjs": [
          `console.log("ran from " + import.meta.dirname);`,
          `console.log(JSON.stringify({ level: 30, msg: "starting worker" }));`,
          `setInterval(() => {}, 1000);`,
        ].join("\n"),
      },
      buildRoot,
    );

    const result = await verify(outDir);

    expect(result.output).toContain("ran from ");
    expect(result.output).not.toContain(`ran from ${join(outDir, "entry")}`);
    expect(result.isolatedDir).not.toBe(outDir);
  });

});

/**
 * A started worker says the imports resolved. It says nothing about the agent having
 * anything to say: an artifact shipped that booted, joined a room and rendered nothing,
 * because the project's context/ markdown was never packaged.
 */
describe("verifyArtifactStarts render check", () => {
  const artifact = (worker: string): string =>
    writeArtifact({ entrypoint: "entry/worker.mjs" }, { "entry/worker.mjs": worker });

  it("reports what the artifact rendered", async () => {
    const outDir = artifact(workerReporting(["policy/coverage-basics.md"]));

    const result = await verifyRendering(outDir, ["policy/coverage-basics.md"]);

    expect(result.render?.contextFiles).toEqual(["policy/coverage-basics.md"]);
    expect(result.render?.contextDocs).toHaveLength(1);
  });

  it("fails when the artifact carries none of the project's context markdown", async () => {
    // The shape of the bug verbatim: the worker starts, and every <Text src=…> in it
    // would raise inside a live call.
    const outDir = artifact(workerReporting([]));

    await expect(verifyRendering(outDir, ["policy/coverage-basics.md"])).rejects.toThrowError(
      /missing context markdown[\s\S]*context\/policy\/coverage-basics\.md/,
    );
  });

  it("fails when only some of the context markdown made it", async () => {
    const outDir = artifact(workerReporting(["policy/coverage-basics.md"]));

    await expect(
      verifyRendering(outDir, ["policy/coverage-basics.md", "member/unlocked-context.md"]),
    ).rejects.toThrowError(/member\/unlocked-context\.md/);
  });

  it("fails on an error-severity authoring diagnostic", async () => {
    const outDir = artifact(workerReporting([], ["[AGENT_AUTHORING_RENDER_FAILED] ERROR: …"]));

    await expect(verifyRendering(outDir, [])).rejects.toThrowError(
      /AGENT_AUTHORING_RENDER_FAILED/,
    );
  });

  it("fails when the artifact starts but never reports a render", async () => {
    const outDir = artifact(STARTS_A_WORKER);

    await expect(verifyRendering(outDir, [], 3_000)).rejects.toThrowError(
      /did not finish rendering/,
    );
  });

});

describe("readManifestEntrypoint", () => {
  it("rejects an artifact with no manifest", async () => {
    mkdirSync(join(root, "empty"), { recursive: true });

    await expect(readManifestEntrypoint(join(root, "empty"))).rejects.toThrowError(
      /has no curb\.bundle\.json/,
    );
  });

  it("rejects a manifest with no entrypoint", async () => {
    const outDir = writeArtifact({ schemaVersion: 1 });

    await expect(readManifestEntrypoint(outDir)).rejects.toThrowError(/declares no "entrypoint"/);
  });

  it("rejects an entrypoint that points outside the artifact", async () => {
    const outDir = writeArtifact({ entrypoint: "../elsewhere/worker.mjs" });

    await expect(readManifestEntrypoint(outDir)).rejects.toThrowError(/points outside the artifact/);
  });
});
