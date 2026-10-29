import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// bin/ is plain JavaScript outside the type-checked tree; a computed specifier keeps tsc
// from resolving it while Vitest imports the real module the `curb` shim runs.
const checkModule = new URL("../../bin/node-version.js", import.meta.url).href;
const { nodeFloor, unsupportedNodeMessage } = await import(checkModule);
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("the curb CLI's Node.js version check", () => {
  it("reads the published engines.node as one floor", () => {
    expect(nodeFloor(manifest.engines.node)).toEqual([22, 12, 0]);
  });

  it("refuses an older Node by name", () => {
    for (const version of ["22.11.9", "21.7.3", "20.19.0", "18.20.4"]) {
      expect(unsupportedNodeMessage("curb", ">=22.12.0", version)).toBe(
        `UnsupportedNodeVersion: curb needs Node.js >=22.12.0, but this is Node.js ${version}. ` +
          "Install Node.js 22.12.0 or newer (https://nodejs.org) and run the command again.",
      );
    }
  });

  it("accepts the floor and every newer Node", () => {
    for (const version of ["22.12.0", "22.23.3", "24.0.0", "26.12.0"]) {
      expect(unsupportedNodeMessage("curb", ">=22.12.0", version)).toBeNull();
    }
  });

  it("exits 1 with the refusal on stderr before anything else runs", () => {
    const root = mkdtempSync(join(tmpdir(), "curb-node-version-"));
    try {
      const packageJson = join(root, "package.json");
      writeFileSync(packageJson, JSON.stringify({ name: "curb", engines: { node: ">=999.0.0" } }));
      const script =
        `const { exitOnUnsupportedNode } = await import(${JSON.stringify(checkModule)});` +
        `exitOnUnsupportedNode(new URL(${JSON.stringify(pathToFileURL(packageJson).href)}));` +
        'console.log("ran on");';
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^UnsupportedNodeVersion: curb needs Node\.js >=999\.0\.0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
