import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, resolveDependencyDir } from "./dependency-mirror.js";

/**
 * Packages that must NOT be bundled.
 *
 * Each of these loads a compiled `.node` binary through `process.dlopen`. A bundler
 * concatenates JavaScript; it cannot turn a shared object into text. Bundling them
 * produces output that builds cleanly and dies at the first native call, which is the
 * worst failure shape available: late, and far from its cause.
 *
 * They are copied beside the bundle instead, and the file list is discovered by
 * tracing rather than hand-maintained.
 */
export const NATIVE_PACKAGES = [
  // Silero VAD runs through ONNX Runtime. ~56 MB for linux-x64 alone.
  "onnxruntime-node",
  // Image transforms load libvips through a platform-specific compiled addon.
  "sharp",
  // The rtc-node JavaScript wrapper bundles cleanly; only its Rust binding cannot.
  "@livekit/rtc-ffi-bindings",
];

/**
 * Packages the bundled JavaScript loads BY NAME at runtime, through a require esbuild
 * cannot see and so never bundles. They ship as traced dependency files, seeded from the
 * framework's location: that is where the generated entry resolves them from at runtime.
 *
 * The isolated bundle copy must not be what reaches them. Where it cannot resolve them
 * they are silently missing from the artifact; where it can (a builder whose TMPDIR sits
 * inside the workspace) `--emit-layers` refuses, because a file only the bundle copy
 * reaches looks like agent code in the dependency layer.
 */
export const RUNTIME_REQUIRED_PACKAGES = [
  // @ai-sdk/provider-utils builds its download fetch with
  // `module.createRequire(<calling file>)("undici")`; bundled, the calling file is the entry.
  "undici",
];

/**
 * Packages excluded for a different reason: they are dev-time only and pulling them in
 * would bundle a dev server into a production artifact.
 */
export const DEV_ONLY_PACKAGES = ["vite", "tsx", "esbuild", "@vercel/nft"];

/**
 * Optional peers of a bundled dependency that a Curb agent never installs or reaches.
 *
 * `@livekit/agents` 1.9.4 (2026-10-24) imports `@modelcontextprotocol/client` lazily, with
 * `await import(...)` inside its own MCP integration, and declares it an optional peer.
 * Curb never uses that integration (its MCP client is `@modelcontextprotocol/sdk`), so the
 * package is absent; bundled, esbuild must still resolve the specifier and `curb build`
 * fails for every fresh install. External, the import stays a runtime import that nothing
 * calls. esbuild matches subpaths too (`@modelcontextprotocol/client/stdio`). Like
 * `DEV_ONLY_PACKAGES`, these are never in `manifest.externals`: the artifact never
 * resolves them, and the tracer's failure to find them is a known-benign warning
 * (`unused-optional-peer` in `warnings.ts`).
 */
export const UNUSED_OPTIONAL_PEERS = ["@modelcontextprotocol/client"];

/**
 * Node builtins esbuild should leave alone. `platform: "node"` already handles the
 * bare names; the `node:` prefixed forms are listed so a mixed-style import in a
 * dependency does not surprise us.
 */
export const NODE_BUILTIN_PREFIX = "node:";

/** Everything esbuild must treat as external. */
export function externalPackages(): string[] {
  return [...NATIVE_PACKAGES, ...DEV_ONLY_PACKAGES, ...UNUSED_OPTIONAL_PEERS];
}

/**
 * One entry of `manifest.externals`: `{ specifier, version, native }`.
 *
 * `DEV_ONLY_PACKAGES` are deliberately absent from the list this describes. They are
 * external to esbuild so a dev server never reaches the artifact, and the artifact never
 * resolves them at runtime -- which is the only thing `externals[]` is about.
 */
export type BundleExternal = {
  specifier: string;
  version: string;
  native: boolean;
};

/** Where an external's package directory is read from, and how far resolution may walk. */
export type ExternalSource = {
  /** Resolve `name` the way Node will at runtime, returning its package directory. */
  resolve: (name: string) => string | undefined;
  /** The tree `resolve` searches. Its own dependency closure is walked from here too. */
  root: string;
  /**
   * What `resolve` searches, for the error message when it finds nothing: "the artifact"
   * or "the project's install". A caller that cannot say which is not entitled to guess.
   */
  describe: string;
};

/**
 * Describe every declared external as the manifest carries it.
 *
 * The VERSION is read from the package.json of the directory the tree actually resolves,
 * never from a range in anyone's dependencies. A range is what the project asked for; the
 * bytes are what shipped, and the two drift -- `dependency-mirror.ts` exists because they
 * already did, twice, and the artifact resolved a version the project never installed. A
 * manifest that declared the range would have described both builds identically.
 *
 * `native` is DERIVED from those same bytes rather than from this file's list: a package
 * is native when a compiled addon (`*.node`) exists anywhere in the dependency closure it
 * resolves. That is the exact reason a package is on `NATIVE_PACKAGES` at all -- see the
 * comment at the top of this file -- so the manifest states the property instead of
 * restating the list, and an external added here later gets a truthful answer without
 * anyone remembering to classify it.
 *
 * A declared external that cannot be resolved THROWS. The alternative is a manifest entry
 * with an empty or invented version, which is worse than no entry: the artifact store
 * refuses an unpinned external precisely because it makes the artifact non-reproducible.
 */
export async function describeExternals(
  names: readonly string[],
  source: ExternalSource,
): Promise<BundleExternal[]> {
  const externals: BundleExternal[] = [];

  for (const specifier of names) {
    const packageDir = source.resolve(specifier);
    if (!packageDir) {
      throw new Error(
        `curb build: the declared external ${specifier} is not resolvable in ` +
          `${source.describe}, so the manifest cannot say which version shipped.\n` +
          `  An external the manifest cannot pin is an artifact nobody can reproduce; ` +
          `run npm install, then build again.`,
      );
    }
    const version = readManifest(packageDir)?.version;
    if (!version) {
      throw new Error(
        `curb build: ${packageDir} has no readable version, so the manifest cannot pin ` +
          `the external ${specifier}.\n` +
          `  A declared version that does not match the bytes is worse than none; this ` +
          `build refuses to invent one.`,
      );
    }
    externals.push({
      specifier,
      version,
      native: await closureCarriesNativeAddon(packageDir, source.root),
    });
  }

  return externals;
}

/**
 * Whether a compiled addon exists in the dependency closure `packageDir` resolves.
 *
 * The closure, not just the package: npm ships one prebuild per platform as a separate,
 * `os`/`cpu`-gated package, so `@livekit/rtc-node` holds no `.node` file of its own and is
 * still the single most target-pinned thing in the bundle -- its binding lives in
 * `@livekit/rtc-ffi-bindings-<platform>`. Answering from the package's own files alone
 * would report that one as portable.
 *
 * Resolution is bounded by `root` and follows the same upward walk Node will, so the
 * closure examined is the one the artifact actually has rather than the one its
 * package.json describes.
 */
async function closureCarriesNativeAddon(packageDir: string, root: string): Promise<boolean> {
  const visited = new Set<string>([packageDir]);
  const queue = [packageDir];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (await carriesNativeAddon(current)) return true;

    const manifest = readManifest(current);
    if (!manifest) continue;
    const dependencies = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ];
    for (const name of dependencies) {
      const resolved = resolveDependencyDir(current, root, name);
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push(resolved);
    }
  }

  return false;
}

/**
 * Whether the package's OWN files hold a `*.node`.
 *
 * `node_modules` is skipped rather than descended: a nested package is a separate node of
 * the closure walk above, which reaches it through a resolution rather than through a
 * directory listing. Descending here would attribute a dependency's binding to whichever
 * package npm happened to nest it under.
 */
async function carriesNativeAddon(packageDir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(packageDir, { withFileTypes: true });
  } catch {
    // KEEP-JUSTIFIED: an unreadable directory is not evidence of a native addon either
    // way. The caller's remaining evidence -- the rest of the closure -- still decides,
    // and a package directory that cannot be read at all fails the build later, at
    // collectBundleFiles, which names the path.
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (await carriesNativeAddon(join(packageDir, entry.name))) return true;
      continue;
    }
    if (entry.name.endsWith(".node")) return true;
  }
  return false;
}
