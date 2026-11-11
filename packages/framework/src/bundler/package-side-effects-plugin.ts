import type { Plugin } from "esbuild";

const RESOLVING = "curb:package-side-effects";

/**
 * Bundles every package file as if it had side effects, whatever its `sideEffects` field says.
 *
 * esbuild (0.28.2 at least) can emit a bundle that crashes on load when a package declares
 * `sideEffects: false`. A module reached through `import()` or `require()` is wrapped in a lazy
 * initializer, and so is everything it imports. When a package's re-export-only file (an
 * `index.js` holding nothing but `export * from "./external.js"`) sits between a plain ESM
 * import and such a wrapped module, esbuild drops that file as side-effect free, and with it the
 * call that runs the initializer. The importer then reads the wrapped module's exports before
 * they exist: `TypeError: ZodMiniLiteral is not a constructor` at the first line of `ai` that
 * builds a zod mini schema, once `ai` imported `zod/v4/mini` and the MCP SDK reached
 * `zod/v4-mini` through a lazy module.
 *
 * Resolving bare imports with `sideEffects: true` keeps those files and their initializer calls.
 * Unused exports are still removed, and `/* @__PURE__ *\/` calls still are, so the bundle grows
 * by a few kilobytes rather than by everything the annotations let go. An import esbuild cannot
 * resolve, or one left external, is handed back untouched, so its error or warning is esbuild's
 * own.
 */
export function packageSideEffectsPlugin(): Plugin {
  return {
    name: RESOLVING,
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === RESOLVING) return undefined;
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          with: args.with,
          pluginData: RESOLVING,
        });
        if (resolved.errors.length > 0 || resolved.external) return undefined;
        return {
          path: resolved.path,
          namespace: resolved.namespace,
          suffix: resolved.suffix,
          pluginData: resolved.pluginData,
          sideEffects: true,
        };
      });
    },
  };
}
