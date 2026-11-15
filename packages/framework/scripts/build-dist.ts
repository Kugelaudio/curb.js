/**
 * Compiles the framework into `dist/`, the form npm receives (`npm pack` runs this as
 * `prepack`). Like Next.js's `dist/compiled`, a fresh project then installs the framework's
 * native and shared packages only, not its whole dependency tree:
 *
 *   dist/*.js         the framework's Node entries, with every pure-JavaScript dependency
 *                     bundled in. `dependencies` and `peerDependencies` stay imports: native
 *                     code, the voice runtime that forks its own job processes, the TypeScript
 *                     loader a project's agent runs on, and packages whose types the public API
 *                     carries.
 *   dist/client.js    `curb/client`, built for the browser.
 *   dist/types/       the declarations, one per source module.
 *   dist/preview/     the `curb dev` page, already built: no Vite, Tailwind or UI library is
 *                     installed with a project.
 *   dist/hosted/      the host protocol as JSON Schema with its fixtures, for hosts written in
 *                     other languages (docs/agent-guide/host-protocol.md).
 *   dist/THIRD_PARTY_LICENSES.md  the license of every package bundled into dist/.
 *
 * A checkout keeps running the TypeScript source through tsx (`bin/curb.js`); `src/layout.ts`
 * is the one place that knows which of the two it runs from.
 *
 * Usage: node --import tsx scripts/build-dist.ts
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { build as viteBuild } from "vite";
import { packageSideEffectsPlugin } from "../src/bundler/package-side-effects-plugin.js";
import { DIST_ENTRIES } from "../src/layout.js";
import { createPreviewConfig } from "../src/vite/preview-config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  publishConfig: { exports: Record<string, string | Record<string, string>> };
};
const started = performance.now();

/** What a project installs with the framework; everything else is compiled into dist/. */
const installed = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)];
/** Only a checkout's `curb dev` loads these (the preview from source); dist/ serves it built. */
const SOURCE_ONLY = ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"];
/**
 * Requires inside a bundled package that only its own tooling reaches: `@vercel/nft`'s
 * `@mapbox/node-pre-gyp` loads these to publish or mock binaries, never to find one.
 */
const NEVER_LOADED = ["aws-sdk", "nock", "mock-aws-s3"];
const external = [...installed, ...SOURCE_ONLY, ...NEVER_LOADED, ...builtinModules, "node:*"];

/**
 * Installed packages that bundled CommonJS `require`s. esbuild leaves such a require to run
 * at run time, and `curb build`, which bundles dist/ again, cannot see one: the artifact would
 * miss the package. So the CommonJS caller gets its own copy bundled, while ESM imports of the
 * same package stay imports. Any other runtime require of an installed package fails this
 * build (step 6).
 */
const BUNDLED_FOR_REQUIRE = new Set(["ws"]);

const requireBundled: esbuild.Plugin = {
  name: "curb:bundle-required",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind !== "require-call" || !BUNDLED_FOR_REQUIRE.has(args.path)) return undefined;
      return { path: createRequire(join(args.resolveDir, "noop.js")).resolve(args.path) };
    });
  },
};

rmSync(dist, { recursive: true, force: true });

// 1. The Node entries, in one build so they share one copy of every module (chunks).
const node = await esbuild.build({
  absWorkingDir: root,
  entryPoints: Object.fromEntries(
    Object.entries(DIST_ENTRIES).filter(([name]) => name !== "client").map(([name, source]) => [name, join(root, "src", source)]),
  ),
  outdir: dist,
  // Flat: every module's `import.meta.url` sits in dist/, one level below the package root,
  // as the source sits in src/ (`src/layout.ts`).
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  jsx: "automatic",
  // The framework reads component names in its authoring diagnostics.
  keepNames: true,
  external,
  plugins: [requireBundled, packageSideEffectsPlugin()],
  // node-pre-gyp lists its nw.js page among its modules; the bundle carries it as text.
  loader: { ".html": "text" },
  metafile: true,
  // Each file's map carries the TypeScript it came from, so a stack trace names src/ lines
  // once Node reads maps (`bin/curb.js` turns that on before it loads dist/).
  sourcemap: true,
  logLevel: "warning",
  legalComments: "none",
  define: { "process.env.CURB_COMPILED": JSON.stringify("1") },
  banner: {
    // Bundled CommonJS calls `require`, `__filename` and `__dirname`, which ESM output lacks.
    // `curb build` bundles these files again under a banner of its own that declares the same
    // three names (src/bundler/index.ts): `var` on both sides, and imports named apart.
    js: [
      `import { createRequire as __curbDistCreateRequire } from "node:module";`,
      `import { fileURLToPath as __curbDistFileURLToPath } from "node:url";`,
      `import { dirname as __curbDistDirname } from "node:path";`,
      `var require = __curbDistCreateRequire(import.meta.url);`,
      `var __filename = __curbDistFileURLToPath(import.meta.url);`,
      `var __dirname = __curbDistDirname(__filename);`,
    ].join("\n"),
  },
});

// 2. `curb/client`, for a browser app's own bundler.
const client = await esbuild.build({
  absWorkingDir: root,
  entryPoints: { client: join(root, "src", DIST_ENTRIES.client) },
  outdir: dist,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  external: installed,
  metafile: true,
  sourcemap: true,
  logLevel: "warning",
  legalComments: "none",
});

// 3. The declarations, one per source module (the tests and fixtures excluded).
execFileSync(process.execPath, [createRequire(import.meta.url).resolve("typescript/bin/tsc"), "-p", join(root, "tsconfig.dist.json")], {
  stdio: "inherit",
});

// 4. The preview page, built once instead of on every `curb dev`.
const previewConfig = createPreviewConfig({ projectRoot: root, attachTo: createServer() });
await viteBuild({
  ...previewConfig,
  server: undefined,
  // The context markdown is the project's; `curb dev` serves it beside the built page.
  publicDir: false,
  cacheDir: join(root, "node_modules", ".vite-dist"),
  logLevel: "warn",
  plugins: (previewConfig.plugins ?? []).filter((plugin) => (plugin as { name?: string }).name !== "framework:context-index"),
  build: { outDir: join(dist, "preview"), emptyOutDir: true, rollupOptions: { shimMissingExports: true } },
});

// 4b. The host protocol a host in another language implements: the schema and its fixtures.
for (const name of ["protocol.schema.json", "protocol-fixtures"]) {
  cpSync(join(root, "src", "hosted", name), join(dist, "hosted", name), { recursive: true });
}

// 5. The licenses of what was bundled.
writeFileSync(join(dist, "THIRD_PARTY_LICENSES.md"), licenseNotice([node.metafile, client.metafile]));

// 5b. The maps name a bundled package by its path in this checkout (`../../../node_modules/x`),
// which points outside an installed package; name it as the package's own copy instead.
for (const output of [...Object.keys(node.metafile.outputs), ...Object.keys(client.metafile.outputs)]) {
  if (!output.endsWith(".map")) continue;
  const path = join(root, output);
  const map = JSON.parse(readFileSync(path, "utf8")) as { sources: string[] };
  map.sources = map.sources.map((source) => source.replace(/^(?:\.\.\/)+node_modules\//, "../node_modules/"));
  writeFileSync(path, JSON.stringify(map));
}

// 6. No runtime require of an installed package is left for `curb build` to miss.
const requiredAtRunTime = Object.keys(node.metafile.outputs)
  .filter((output) => output.endsWith(".js"))
  .flatMap((output) => [...readFileSync(join(root, output), "utf8").matchAll(/__require\("([^"]+)"\)/g)].map((match) => match[1]!))
  .filter((name) => installed.some((dependency) => name === dependency || name.startsWith(`${dependency}/`)));
if (requiredAtRunTime.length > 0) {
  throw new Error(`build-dist: bundled CommonJS requires ${[...new Set(requiredAtRunTime)].join(", ")} at run time; add it to BUNDLED_FOR_REQUIRE or make it a dependency nothing bundled requires.`);
}

// 7. Every path npm will export exists (`publishConfig.exports`, applied by scripts/npm-package.mjs).
const missing = Object.values(manifest.publishConfig.exports)
  .flatMap((target) => (typeof target === "string" ? [target] : Object.values(target)))
  .filter((target) => !existsSync(join(root, target)));
if (missing.length > 0) throw new Error(`build-dist: publishConfig.exports names files the build did not write: ${missing.join(", ")}`);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`dist/ built in ${seconds} s`);

/** Every package a build inlined, with its license text, for dist/THIRD_PARTY_LICENSES.md. */
function licenseNotice(metafiles: esbuild.Metafile[]): string {
  const packages = new Map<string, string>();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const path = join(root, input);
      const parts = path.split(sep);
      const at = parts.lastIndexOf("node_modules");
      if (at < 0) continue;
      const nameParts = parts[at + 1]!.startsWith("@") ? 2 : 1;
      const packageDir = parts.slice(0, at + 1 + nameParts).join(sep);
      packages.set(relative(root, packageDir), packageDir);
    }
  }
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const packageDir of [...packages.values()].sort()) {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      license?: string | { type?: string };
      repository?: string | { url?: string };
    };
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "see the package");
    const text = licenseText(packageDir);
    sections.push(
      [`## ${id}`, "", `License: ${license}`, "", ...(text ? ["```", text.trim(), "```", ""] : [])].join("\n"),
    );
  }
  return [
    "# Bundled third-party packages",
    "",
    "The files in this directory include the following packages, each under its own license.",
    "",
    ...sections,
  ].join("\n");
}

function licenseText(packageDir: string): string | undefined {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "LICENCE", "LICENSE-MIT"]) {
    const path = join(packageDir, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

