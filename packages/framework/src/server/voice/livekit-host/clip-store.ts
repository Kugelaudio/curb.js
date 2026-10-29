/**
 * Per-conversation debug audio clips, captured server-side in the agent's
 * node pipeline — so they are EXACT: a user clip is byte-for-byte what STT
 * heard; an assistant clip is the TTS output before WebRTC encoding. One
 * clip per transcript message, addressed by role + ordinal (the n-th user /
 * assistant message), which mirrors the browser transcript's ordering.
 */

import { pcmToWav } from "../wav.js";

/** Keep the most recent clips only — debug material, not a recording system. */
const MAX_CLIPS_PER_ROLE = 30;
/** Hard cap per clip (~2 min @48k mono PCM16) so a stuck stream can't grow unbounded. */
const MAX_CLIP_BYTES = 2 * 60 * 48000 * 2;

export type ClipRole = "user" | "assistant";

type OpenClip = { chunks: Buffer[]; bytes: number; sampleRate: number };

export class ConversationClips {
  private readonly finished: Record<ClipRole, Buffer[]> = { user: [], assistant: [] };
  /** Ordinal of finished[role][0] — earlier clips were evicted. */
  private readonly evicted: Record<ClipRole, number> = { user: 0, assistant: 0 };
  private readonly open: Record<ClipRole, OpenClip | null> = { user: null, assistant: null };

  /** Append PCM16 for the currently-open clip of `role`. */
  append(role: ClipRole, pcm: Buffer, sampleRate: number): void {
    const clip = (this.open[role] ??= { chunks: [], bytes: 0, sampleRate });
    if (clip.bytes >= MAX_CLIP_BYTES) return;
    clip.chunks.push(pcm);
    clip.bytes += pcm.length;
  }

  /** Close the open clip of `role` — it becomes the next ordinal's WAV. */
  finish(role: ClipRole): void {
    const clip = this.open[role];
    this.open[role] = null;
    if (!clip || clip.bytes === 0) {
      // The transcript message exists even when no audio was captured (e.g.
      // a non-taped TTS path) — keep ordinals aligned with an empty slot.
      this.finished[role].push(Buffer.alloc(0));
    } else {
      this.finished[role].push(pcmToWav(Buffer.concat(clip.chunks), clip.sampleRate));
    }
    if (this.finished[role].length > MAX_CLIPS_PER_ROLE) {
      this.finished[role].shift();
      this.evicted[role] += 1;
    }
  }

  /** WAV of the n-th (0-based) user/assistant message, or null. */
  wav(role: ClipRole, ordinal: number): Buffer | null {
    const index = ordinal - this.evicted[role];
    const wav = this.finished[role][index];
    return wav && wav.length > 0 ? wav : null;
  }
}
