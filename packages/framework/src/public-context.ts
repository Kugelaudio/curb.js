import { formatMissingMarkdownError, normalizePublicSrc } from "./public-context.shared.js";

const cache = new Map<string, string>();
const isBrowser = typeof window !== "undefined";
let latestMarkdownLoad = 0;

if (!isBrowser) {
  const { hydratePublicMarkdownCache } = await import("./public-context.node.js");
  hydratePublicMarkdownCache(cache);
}

async function fetchPublicMarkdownIndex(basePath: string): Promise<string[]> {
  const response = await fetch(`${basePath}/context.index.json`);
  // 404 means the project has no context/ directory — a defined empty state.
  // Anything else non-ok is a real serving failure and must surface.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error("Failed to load context/context.index.json.");
  }

  const files = (await response.json()) as unknown;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw new Error("context/context.index.json must be a JSON array of markdown paths.");
  }

  return files;
}

export async function preloadPublicMarkdown(basePath = "") {
  if (!isBrowser) return;

  const load = ++latestMarkdownLoad;
  const files = await fetchPublicMarkdownIndex(basePath);
  const documents = await Promise.all(
    files.map(async (src) => {
      const parts = src.split("/");
      if (!src.endsWith(".md") || parts.some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`Invalid context markdown path: ${src}`);
      }
      const path = parts.map(encodeURIComponent).join("/");
      const response = await fetch(`${basePath}/${path}`);
      if (!response.ok) {
        throw new Error(`Failed to load context markdown: ${src}`);
      }

      return [src, await response.text()] as const;
    }),
  );
  if (load !== latestMarkdownLoad) return;
  cache.clear();
  for (const [src, content] of documents) cache.set(src, content);
}

/**
 * Install the markdown a `curb build` artifact carries INLINE.
 *
 * Why inline rather than copying `context/` into the artifact and reading it there: the
 * Node path above resolves `context/` against `AGENT_PROJECT_DIR` or the working
 * directory, and a hosted artifact has neither — the platform starts it from an
 * arbitrary directory that is not a curb project. Any file-based fix would have to
 * reconstruct a project root the artifact does not have, and would be wrong again the
 * first time a runner chose a different cwd. Inlined content has no root to get wrong.
 *
 * The whole directory is installed, not the files the tree references statically, so a
 * computed `<Text src={…}>` and a skill loaded mid-conversation resolve exactly as they
 * do from a checkout.
 *
 * Called by the entries `curb build` generates, before the agent renders. Not part of
 * the authoring API (`index.ts`); nothing in a project should call it.
 */
export function setBundledPublicMarkdown(files: Record<string, string>): void {
  for (const [src, content] of Object.entries(files)) {
    cache.set(normalizePublicSrc(src), content);
  }
}

export function listPublicMarkdown() {
  return [...cache.keys()].sort();
}

export function resolvePublicMarkdown(src: string) {
  const normalized = normalizePublicSrc(src);
  const content = cache.get(normalized);
  if (content) return content;

  throw new Error(formatMissingMarkdownError(src, listPublicMarkdown()));
}
