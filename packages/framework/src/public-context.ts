import { formatMissingMarkdownError, normalizePublicSrc } from "./public-context.shared.js";

const cache = new Map<string, string>();
const isBrowser = typeof window !== "undefined";

if (!isBrowser) {
  const { hydratePublicMarkdownCache } = await import("./public-context.node.js");
  hydratePublicMarkdownCache(cache);
}

async function fetchPublicMarkdownIndex() {
  const response = await fetch("/context.index.json");
  // 404 means the project has no context/ directory — a defined empty state.
  // Anything else non-ok is a real serving failure and must surface.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error("Failed to load context/context.index.json.");
  }

  const files = (await response.json()) as unknown;
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    throw new Error("context/context.index.json must be a JSON array of markdown paths.");
  }

  return files;
}

export async function preloadPublicMarkdown() {
  if (!isBrowser) return;

  const files = await fetchPublicMarkdownIndex();
  await Promise.all(
    files.map(async (src) => {
      const response = await fetch(`/${src}`);
      if (!response.ok) {
        throw new Error(`Failed to load context markdown: ${src}`);
      }

      cache.set(src, await response.text());
    }),
  );
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
