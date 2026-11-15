import { Fragment } from "react";

/** A run of a diagnostic's text: prose, something typed exactly as written, or a link. */
export type InlinePart = { text: string; code: boolean; href?: string };

/** A `backticked` span, a web address (without the punctuation that ends its sentence), or
 * an environment variable's name (two words or more, upper case). */
const TYPED = /`([^`\n]+)`|https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)]|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Splits a diagnostic's sentence into prose, what a person types as written (commands and
 * file names the text puts in backticks, and environment variables), and web addresses. The
 * backticks are the text's own markup, so they are dropped rather than shown.
 */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let end = 0;
  for (const match of text.matchAll(TYPED)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index), code: false });
    if (match[0].startsWith("http")) parts.push({ text: match[0], code: false, href: match[0] });
    else parts.push({ text: match[1] ?? match[0], code: true });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), code: false });
  return parts;
}

/** A web address as a link reads: without its scheme. */
function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** A diagnostic's sentence with its commands, files and variables set apart from the prose,
 * and its web addresses as links that open in a new tab. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.href ? (
          <a key={index} className="inline-link" href={part.href} target="_blank" rel="noreferrer">
            {withoutScheme(part.text)}
          </a>
        ) : part.code ? (
          <code key={index} className="inline-code">
            {part.text}
          </code>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
