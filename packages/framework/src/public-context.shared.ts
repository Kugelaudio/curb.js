export function normalizePublicSrc(src: string) {
  const trimmed = src.trim().replace(/^\/+/, "");
  if (!trimmed) {
    throw new Error("Context src cannot be empty.");
  }

  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

export function formatMissingMarkdownError(src: string, available: string[]) {
  return `Context markdown "${src}" was not found. Available files: ${available.length > 0 ? available.join(", ") : "(none)"}.`;
}
