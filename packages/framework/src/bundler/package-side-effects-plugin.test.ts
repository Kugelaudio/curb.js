import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { packageSideEffectsPlugin } from "./package-side-effects-plugin.js";

/**
 * The shape that broke `ai` with `zod/v4/mini`, in four files: a `sideEffects: false` package
 * whose index only re-exports, a second entry point of it reached through `import()` (which
 * wraps the shared modules in a lazy initializer), and a consumer that calls an export at the
 * top level.
 */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "curb-side-effects-"));
  const files: Record<string, string> = {
    "node_modules/lib/package.json": JSON.stringify({
      name: "lib",
      type: "module",
      sideEffects: false,
      exports: { ".": "./index.js", "./alt": "./alt.js" },
    }),
    "node_modules/lib/schemas.js":
      "export class Literal { constructor(value) { this.value = value; } }\n" +
      "export function literal(value) { return new Literal(value); }\n",
    "node_modules/lib/external.js": 'export * from "./schemas.js";\n',
    "node_modules/lib/index.js": 'import * as z from "./external.js";\nexport * from "./external.js";\nexport { z };\n',
    "node_modules/lib/alt.js": 'export * from "./external.js";\n',
    "node_modules/user/package.json": JSON.stringify({ name: "user", type: "module", exports: "./index.js" }),
    "node_modules/user/index.js": 'import { literal } from "lib";\nexport const value = literal("source").value;\n',
    "entry.mjs": 'import { value } from "user";\nconsole.log(value);\nexport const later = () => import("lib/alt");\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

async function bundleAndRun(plugins: esbuild.Plugin[]): Promise<string> {
  const root = project();
  const outfile = join(root, "out.mjs");
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["entry.mjs"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    plugins,
    logLevel: "silent",
  });
  return execFileSync(process.execPath, [outfile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("packageSideEffectsPlugin", () => {
  it("runs a lazily wrapped module's initializer behind a side-effect-free re-export", async () => {
    expect(await bundleAndRun([packageSideEffectsPlugin()])).toBe("source");
  });

  // The day esbuild fixes this, the bundle runs without the plugin and this test says the
  // plugin can go.
  it("is still needed: without it the same bundle crashes on load", async () => {
    await expect(bundleAndRun([])).rejects.toThrow(/Literal is not a constructor/);
  });

  it("leaves an unresolvable import to esbuild's own error", async () => {
    const root = project();
    writeFileSync(join(root, "entry.mjs"), 'import "missing-package";\n');
    await expect(
      esbuild.build({
        absWorkingDir: root,
        entryPoints: ["entry.mjs"],
        bundle: true,
        write: false,
        plugins: [packageSideEffectsPlugin()],
        logLevel: "silent",
      }),
    ).rejects.toThrow(/Could not resolve "missing-package"/);
  });
});
