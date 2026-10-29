/**
 * The browser's recordings of its calls, whichever transport carried them: the microphone
 * and the agent's voice mixed into one stream as they happened, so pauses, overlaps and
 * interruptions replay as the caller heard them. One instance serves both voice clients
 * (`voice-client.ts`), so a conversation's recordings stay one list.
 */

import type { ConversationRecording } from "./conversation-recording.js";

const NO_RECORDINGS: readonly ConversationRecording[] = [];

/** Which call a recording belongs to. */
export type RecordedCall = { conversationId: string; room: string };

type ActiveCapture = {
  recorder: MediaRecorder;
  chunks: Blob[];
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  sources: Map<MediaStreamTrack, MediaStreamAudioSourceNode>;
  call: RecordedCall;
  startedAt: number;
  mimeType: string;
};

export class CallRecordings {
  private capture: ActiveCapture | null = null;
  private recordingNumber = 1;
  private readonly saved = new Map<string, ConversationRecording[]>();
  /** Increments whenever a recording is saved. */
  revision = 0;

  /** A conversation's recordings: the same array until one is added, also when it has none,
   * so a component that restarts when the array changes does not restart on every render. */
  get(conversationId: string | null): readonly ConversationRecording[] {
    return (conversationId ? this.saved.get(conversationId) : undefined) ?? NO_RECORDINGS;
  }

  /** Start recording a call from its first tracks; more join with `connect`. */
  async start(call: RecordedCall, tracks: readonly MediaStreamTrack[]): Promise<void> {
    if (typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") {
      throw new Error("This browser does not support call recording.");
    }
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    if (tracks.length === 0) {
      await context.close();
      throw new Error("No microphone or agent audio track was available to record.");
    }
    const preferredTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    const recorder = new MediaRecorder(
      destination.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : { audioBitsPerSecond: 128_000 },
    );
    const capture: ActiveCapture = {
      recorder,
      chunks: [],
      context,
      destination,
      sources: new Map(),
      call,
      startedAt: Date.now(),
      mimeType: recorder.mimeType || mimeType || "audio/webm",
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) capture.chunks.push(event.data);
    });
    this.capture = capture;
    try {
      for (const track of tracks) this.connect(track);
      if (context.state === "suspended") await context.resume();
      recorder.start(500);
    } catch (error) {
      this.capture = null;
      for (const source of capture.sources.values()) source.disconnect();
      capture.sources.clear();
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  connect(track: MediaStreamTrack): void {
    const capture = this.capture;
    if (!capture || capture.sources.has(track)) return;
    const source = capture.context.createMediaStreamSource(new MediaStream([track]));
    source.connect(capture.destination);
    capture.sources.set(track, source);
  }

  disconnect(track: MediaStreamTrack): void {
    const source = this.capture?.sources.get(track);
    if (!source) return;
    source.disconnect();
    this.capture?.sources.delete(track);
  }

  /**
   * End the recording. Resolves `saved` once it is kept (and `revision` moved), `empty` when
   * no audio arrived; null when nothing was recording.
   */
  finish(): Promise<"saved" | "empty"> | null {
    const capture = this.capture;
    this.capture = null;
    if (!capture) return null;
    const endedAt = Date.now();
    const finalize = async (): Promise<"saved" | "empty"> => {
      for (const source of capture.sources.values()) source.disconnect();
      capture.sources.clear();
      await capture.context.close().catch(() => undefined);
      const blob = new Blob(capture.chunks, { type: capture.mimeType });
      if (blob.size === 0) return "empty";
      const recordings = this.saved.get(capture.call.conversationId) ?? [];
      // A new array: `get` hands out the old one until something changed.
      this.saved.set(capture.call.conversationId, [
        ...recordings,
        {
          id: `recording-${this.recordingNumber++}`,
          conversationId: capture.call.conversationId,
          room: capture.call.room,
          startedAt: capture.startedAt,
          endedAt,
          mimeType: capture.mimeType,
          blob,
        },
      ]);
      this.revision += 1;
      return "saved";
    };
    if (capture.recorder.state === "inactive") return finalize();
    return new Promise((resolve, reject) => {
      capture.recorder.addEventListener("stop", () => void finalize().then(resolve, reject), { once: true });
      capture.recorder.stop();
    });
  }
}

/** What a finished recording means for the call's visible state. */
export const RECORDING_EMPTY_ERROR = "The call ended before any audio could be recorded.";
