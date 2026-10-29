import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { resolveContextDir } from "./project.node.js";

const contextRoot = resolveContextDir();

/**
 * Markdown files under `root`, as root-relative POSIX paths.
 *
 * Separated from the module-level `contextRoot` so `curb build` can read the markdown of
 * the project it is BUILDING. The build process runs from its own directory, and the
 * cached root above is bound to that one.
 *
 * The separator is normalized because these strings are compared against author-written
 * `<Text src="policy/coverage-basics.md">` values, which are always POSIX.
 */
export function listMarkdownIn(root: string): string[] {
  // A project without a context/ directory has no file-backed markdown — a
  // defined empty state, not an error.
  if (!existsSync(root)) return [];

  const results: string[] = [];

  function walk(directory: string) {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.endsWith(".md")) {
        results.push(relative(root, fullPath).split(sep).join("/"));
      }
    }
  }

  walk(root);
  return results.sort();
}

export function listMarkdownFromDisk() {
  return listMarkdownIn(contextRoot);
}

export function readMarkdownFromDisk(relativePath: string) {
  return readFileSync(resolve(contextRoot, relativePath), "utf8");
}

/**
 * The complete markdown tree of one project's `context/`, as `{ src: contents }`.
 *
 * The WHOLE directory, not the files an agent happens to reference statically: a `<Text
 * src={…}>` can be computed at render time, and a skill loaded mid-conversation renders
 * long after any build-time scan. This mirrors what `hydratePublicMarkdownCache` does
 * from disk at import, which is the contract the runtime already has.
 */
export function readPublicMarkdownTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const src of listMarkdownIn(root)) {
    files[src] = readFileSync(resolve(root, src), "utf8");
  }
  return files;
}

export function hydratePublicMarkdownCache(cache: Map<string, string>) {
  for (const src of listMarkdownFromDisk()) {
    cache.set(src, readMarkdownFromDisk(src));
  }
}
