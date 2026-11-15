import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the framework's own files are. It runs in one of two forms, and this module is the
 * only one that tells them apart:
 *
 *   - from npm, compiled: `dist/` holds every entry below as `<name>.js`, built by
 *     `scripts/build-dist.ts`, and the preview page already built under `dist/preview/`;
 *   - in a checkout, from source: `src/` holds the TypeScript, which tsx compiles on the fly
 *     (`bin/curb.js`), and `curb dev` serves the preview through Vite.
 *
 * Both directories sit one level below the package root, and dist/ is flat, so every module's
 * own `import.meta.url` names a file directly inside the one or the other.
 */

/** Each module another process or a generated file loads by path, by its name in dist/. */
export const DIST_ENTRIES = {
  index: "index.ts",
  orchestration: "orchestration.ts",
  providers: "providers.ts",
  testing: "testing/index.ts",
  client: "client/index.ts",
  cli: "cli/main.ts",
  "dev-child": "cli/dev-child.ts",
  "voice-worker": "server/voice/livekit-host/worker.ts",
  "hosted-runtime": "bundler/hosted-runtime.ts",
} as const;

export type FrameworkModule = keyof typeof DIST_ENTRIES;

const here = fileURLToPath(import.meta.url);

/** True when running from the compiled `dist/`, false from the TypeScript source. */
export const COMPILED = !here.endsWith(".ts");

/** The directory holding the running modules: `dist/` or `src/`. */
export const moduleDir = dirname(here);

/** The framework package's root, where package.json, bin/ and docs/ are. */
export const packageRoot = dirname(moduleDir);

/** The file of one of the framework's entries in the form that is running. */
export function frameworkModule(name: FrameworkModule): string {
  return COMPILED ? join(moduleDir, `${name}.js`) : join(moduleDir, DIST_ENTRIES[name]);
}

/** The built preview page, which `curb dev` serves when compiled. */
export const builtPreviewDir = join(packageRoot, "dist", "preview");
