/**
 * A caller's line as a speech-to-speech model hears it, put back together.
 *
 * The model transcribes the caller in parts, cut at their pauses. A part may be the next words,
 * the same words again, or the whole line so far, grown by a few words: a model may send the line
 * once more each time it hears more. All three are one line. The conversation keeps one caller
 * message for it (`AgentSession.recordHeard`), and a call's record one caller turn
 * (`server/voice/s2s/call-record.ts`).
 */

/** Lowercase words, without punctuation: how two transcripts of the same words compare. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** `part` holds only words `line` ends with: the model sent them twice. */
function repeats(said: string, next: string): boolean {
  return next !== "" && (said === next || said.endsWith(` ${next}`));
}

/** `part` is `line` and more: the model sent the whole line again, grown. */
function grows(said: string, next: string): boolean {
  return said !== "" && next.startsWith(`${said} `);
}

/** `part` repeats `line` or grows it: the caller is still saying that line, however long they paused. */
export function continuesHeardLine(line: string, part: string): boolean {
  const said = words(line);
  const next = words(part);
  return repeats(said, next) || grows(said, next);
}

/** `line` with `part` added: kept as it is when `part` repeats it, replaced when `part` grows it. */
export function joinHeardLine(line: string, part: string): string {
  const said = words(line);
  const next = words(part);
  if (repeats(said, next)) return line;
  if (grows(said, next)) return part;
  return `${line}${/^[.,;:!?]/.test(part) ? "" : " "}${part}`;
}
