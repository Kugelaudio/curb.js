import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prove -- not assume -- that this build stamped no build-machine path into the artifact.
 *
 * `manifest.reproducible` was `false` for a reason: esbuild labels each bundled module
 * with its path, and the `?raw` loader handed it absolute ones, so every artifact carried
 * thirteen `/Users/<someone>/...` comments. Two machines building the same revision
 * produced different bytes, and nothing said so.
 *
 * The flag is now claimed only after this check passes, because a claim of
 * reproducibility that is a constant in the source is not evidence of anything: the code
 * that made it false and the code that declared it true never met.
 *
 * Scope is deliberate and stated rather than silently assumed:
 *
 *   - it reads the files `curb build` GENERATES (the emitted entries). That is where the
 *     leak was, and it is the only output whose bytes this builder chooses.
 *   - it does not scan the vendored dependency tree. Those are byte copies of what the
 *     project installed; their content is pinned by the lockfile, not by this build, and
 *     scanning 600 MB of third-party text for the string "/root" would report a
 *     dependency's own source as a defect of ours.
 *   - it does not scan `assets/`, which are byte-identical copies of the revision. A path
 *     in there is the project's content and reproduces with it.
 */
export async function assertNoBuildPathsLeaked(options: {
  outDir: string;
  /** Bundle-root-relative POSIX paths of the files this build generated. */
  generated: readonly string[];
  /** Absolute directories of THIS build machine that must not appear in them. */
  roots: readonly string[];
}): Promise<void> {
  // Longest first, so a nested root is reported by its most specific name, and
  // deduplicated because projectRoot is often the same directory as the trace base.
  const roots = [...new Set(options.roots)].sort((left, right) => right.length - left.length);
  const leaks: string[] = [];

  for (const relativePath of options.generated) {
    const absolute = join(options.outDir, relativePath.split("/").join("/"));
    const contents = await readFile(absolute, "utf8");
    for (const root of roots) {
      const at = contents.indexOf(root);
      if (at < 0) continue;
      // The path plus a little of what follows it, so the report names WHICH occurrence
      // rather than only that there is one.
      leaks.push(`  ${relativePath}: ${JSON.stringify(contents.slice(at, at + 120))}`);
      break;
    }
  }

  if (leaks.length > 0) {
    throw new Error(
      "curb build: the bundle carries this machine's paths, so it is not reproducible.\n" +
        leaks.join("\n") +
        "\n  Nothing inside the digested bytes may carry a " +
        "build timestamp, a host path, a hostname, a random value, or a filesystem mtime. " +
        "Two builds of one revision on two machines would produce two different " +
        "treeDigests, and artifact identity would stop being a function of the revision.",
    );
  }
}
