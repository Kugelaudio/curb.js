import { useState } from "react";

/**
 * What the caller is saying in a call, before the server commits it to the transcript.
 *
 * @livekit/agents publishes the caller's speech on `lk.transcription` as one short text
 * stream per recognition update, each holding the WHOLE text of its segment so far, tagged
 * with the segment's id and whether it is final. A turn can hold several segments (one per
 * STT final). So the live text is kept per segment and revised in place: an update to a
 * known segment replaces its text, a stream that opened earlier than the one already
 * applied is stale, and a final segment takes no more interims.
 */

/** Stream attributes @livekit/agents sets (`ATTRIBUTE_TRANSCRIPTION_*` in its constants);
 * the client SDK does not export them. */
export const TRANSCRIPTION_FINAL = "lk.transcription_final";
export const TRANSCRIPTION_SEGMENT_ID = "lk.segment_id";

export type CallerSegment = {
  id: string;
  text: string;
  final: boolean;
  /** When the segment was first heard: the order the caller said things in. */
  seq: number;
  /** The newest stream applied to it, in the order the streams opened. */
  opened: number;
};

export type CallerSpeech = readonly CallerSegment[];

export type CallerSegmentUpdate = { id: string; text: string; final: boolean; opened: number };

/** Enough for any turn; older segments were committed long ago. */
const KEPT_SEGMENTS = 64;

/** `speech` with `update` applied; the same list when nothing visible changed. */
export function applyCallerSegment(speech: CallerSpeech, update: CallerSegmentUpdate): CallerSpeech {
  const text = update.text.trim();
  if (!text) return speech;
  const at = speech.findIndex((segment) => segment.id === update.id);
  if (at < 0) {
    const added: CallerSegment = { id: update.id, text, final: update.final, seq: update.opened, opened: update.opened };
    return [...speech, added].slice(-KEPT_SEGMENTS);
  }
  const segment = speech[at];
  if (update.opened < segment.opened) return speech;
  if (segment.final && !update.final) return speech;
  if (segment.text === text && segment.final === update.final) return speech;
  const next = [...speech];
  next[at] = { ...segment, text, final: update.final, opened: update.opened };
  return next;
}

/** What the caller has said since segment `since` (exclusive), one line; null for nothing. */
export function callerTextSince(speech: CallerSpeech, since: number): string | null {
  const text = speech
    .filter((segment) => segment.seq > since)
    .map((segment) => segment.text)
    .join(" ");
  return text || null;
}

/**
 * Which segments are still live, given how many caller messages the transcript holds. When
 * that count grows, the server committed what was said, so everything heard until then
 * leaves the live row in the same render the committed message arrives in: no gap where
 * the words vanish, no frame showing them twice. A rewind lowers the count and keeps it.
 */
export type CommitWindow = { count: number; since: number };

export function followCommits(previous: CommitWindow | null, count: number, speech: CallerSpeech): CommitWindow {
  if (!previous) return { count, since: -1 };
  if (count <= previous.count) return count === previous.count ? previous : { count, since: previous.since };
  return { count, since: speech.reduce((newest, segment) => Math.max(newest, segment.seq), previous.since) };
}

/** The live caller text for a transcript holding `callerCount` caller messages. */
export function useLiveCallerText(speech: CallerSpeech, callerCount: number): string | null {
  const [commits, setCommits] = useState<CommitWindow>(() => followCommits(null, callerCount, speech));
  const next = followCommits(commits, callerCount, speech);
  // Adjusted during render (React re-renders before committing), so the render that shows
  // the committed message is the one that drops the live text.
  if (next !== commits) setCommits(next);
  return callerTextSince(speech, next.since);
}
