import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveAgentDir, resolveContextDir } from "../project.node.js";
import { listMarkdownIn } from "../public-context.node.js";

/**
 * One file under the bundle's `assets/` tree.
 *
 * `kind` is the closed vocabulary of the manifest's `assets[]`; `curb build` emits the
 * two kinds it can produce from a revision. `native` and `static` exist in the vocabulary
 * and are not produced here -- the native prebuilds live in the vendored dependency tree
 * this builder mirrors, not under `assets/`.
 */
export type BundleAsset = {
  /** Bundle-root-relative POSIX path. Also appears in `manifest.files`. */
  path: string;
  kind: "context" | "agent-source";
};

const CONTEXT_DIR = "assets/context";
const AGENT_SOURCE_DIR = "assets/agent-source";

/**
 * The authoring keys the generated agent registry declares, as `./agent/<relative path>`.
 *
 * Read back OUT of the generated registry rather than re-walking `src/agent/`, so the
 * agent source shipped under `assets/` is by construction the same set the bundle's
 * module graph carries. A second walk here would be a second discovery implementation
 * that has to agree with `generateAgentModulesCode` forever, and the first time it
 * disagreed an authoring surface would show a file the running agent never loaded.
 */
export function agentSourceKeys(registryCode: string): string[] {
  const keys = new Set<string>();
  for (const match of registryCode.matchAll(/"(\.\/agent\/[^"]+)"/g)) keys.add(match[1]);
  return [...keys].sort();
}

/**
 * Write `assets/context/` and `assets/agent-source/` into a finished bundle.
 *
 * These are what let an authoring surface show a RUNNING agent's source: the platform has
 * the artifact, not the checkout, and the project's markdown reaches the runtime inlined
 * in the module graph (see context-registry.ts) where nothing can read it back as text.
 *
 * Copied as BYTES, not decoded and re-encoded, because `assets/context/` must be
 * byte-identical to the revision -- and because a digest over a round-tripped string
 * would silently stop matching the revision's own.
 */
export async function writeBundleAssets(options: {
  projectRoot: string;
  outDir: string;
  /** The generated agent registry module, source of the agent/skill file set. */
  registryCode: string;
}): Promise<BundleAsset[]> {
  const { projectRoot, outDir, registryCode } = options;
  const assets: BundleAsset[] = [];

  const copy = async (from: string, to: string, kind: BundleAsset["kind"]): Promise<void> => {
    let contents: Buffer;
    try {
      contents = await readFile(from);
    } catch (error) {
      throw new Error(
        `curb build: cannot read ${from} for the bundle's assets/ tree: ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          `  It is part of the revision the artifact is built from, so a bundle that ` +
          `omits it would describe a source tree the project does not have.`,
      );
    }
    const destination = join(outDir, to);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    assets.push({ path: to, kind });
  };

  const contextDir = resolveContextDir(projectRoot);
  for (const src of listMarkdownIn(contextDir)) {
    await copy(resolve(contextDir, src), `${CONTEXT_DIR}/${src}`, "context");
  }

  const agentDir = resolveAgentDir(projectRoot);
  for (const key of agentSourceKeys(registryCode)) {
    const relativePath = key.slice("./agent/".length);
    await copy(resolve(agentDir, relativePath), `${AGENT_SOURCE_DIR}/${relativePath}`, "agent-source");
  }

  // An agent always has an entry module -- `generateAgentModulesCode` throws without one
  // -- so an empty set means the registry shape changed and this reader silently stopped
  // finding it. Reported rather than shipping a bundle whose authoring surface is blank.
  if (!assets.some((asset) => asset.kind === "agent-source")) {
    throw new Error(
      "curb build: found no agent source to place under assets/agent-source/.\n" +
        "  The generated agent registry declares its modules as \"./agent/<path>\" keys; " +
        "nothing matched, which means the registry's shape changed and assets.ts must be " +
        "updated with it.",
    );
  }

  return assets.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
