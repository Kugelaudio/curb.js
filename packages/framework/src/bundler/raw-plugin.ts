import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Plugin } from "esbuild";

/**
 * Teaches esbuild the `?raw` import suffix.
 *
 * `generateAgentModulesCode` emits `import src from "…/skill.tsx?raw"` because the
 * authoring surfaces need each agent and skill as TEXT as well as as a module. That
 * suffix is a Vite feature, and esbuild has no equivalent.
 *
 * `root` is what makes the OUTPUT reproducible. esbuild labels each bundled module with a
 * `// <namespace>:<path>` comment, and for a plugin-resolved module that path is whatever
 * the plugin returned -- so returning the absolute file name stamped thirteen
 * build-machine paths into every artifact, and nothing inside the digested bytes may
 * depend on where the build ran. The path presented to esbuild is therefore relative to
 * `root`, and the absolute one travels to the loader through `pluginData`, which nothing
 * prints.
 */
export function rawLoaderPlugin(root: string): Plugin {
  return {
    name: "curb:raw",
    setup(build) {
      // Claim the suffixed path before esbuild's own resolver sees it, which would
      // fail: no file called "skill.tsx?raw" exists on disk.
      build.onResolve({ filter: /\?raw$/ }, (args) => {
        const absolute = resolve(args.resolveDir || root, args.path.slice(0, -"?raw".length));
        return {
          path: relative(root, absolute).split("\\").join("/"),
          namespace: "curb-raw",
          pluginData: { absolute },
        };
      });

      build.onLoad({ filter: /.*/, namespace: "curb-raw" }, async (args) => {
        const absolute: unknown = args.pluginData?.absolute;
        // A curb-raw path this plugin did not resolve cannot be read from a root-relative
        // name. Reported rather than read from whatever the name resolves against here,
        // which would inline some other file's text as an agent's source.
        if (typeof absolute !== "string" || !isAbsolute(absolute)) {
          throw new Error(
            `curb build: the ?raw loader was handed ${args.path} with no absolute path.\n` +
              `  Only imports resolved by this plugin belong in the curb-raw namespace.`,
          );
        }
        return {
          contents: `export default ${JSON.stringify(await readFile(absolute, "utf8"))};`,
          loader: "js",
        };
      });
    },
  };
}
