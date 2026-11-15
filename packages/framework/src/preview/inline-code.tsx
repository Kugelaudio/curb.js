import { Fragment } from "react";

/** A run of a diagnostic's text: prose, or something typed exactly as written. */
export type InlinePart = { text: string; code: boolean };

/** A `backticked` span, or an environment variable's name (two words or more, upper case). */
const TYPED = /`([^`\n]+)`|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Splits a diagnostic's sentence into prose and what a person types as written: commands and
 * file names the text puts in backticks, and environment variables. The backticks are the
 * text's own markup, so they are dropped rather than shown.
 */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let end = 0;
  for (const match of text.matchAll(TYPED)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index), code: false });
    parts.push({ text: match[1] ?? match[0], code: true });
    end = match.index + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end), code: false });
  return parts;
}

/** A diagnostic's sentence with its commands, files and variables set apart from the prose. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.code ? (
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
