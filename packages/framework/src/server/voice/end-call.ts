/**
 * Hanging up without cutting the agent off mid-word.
 *
 * The model ends a call by calling the framework's `end_call` tool (installed
 * by the runtime while a call is attached) with its closing line as `goodbye`.
 * That tool fires DURING the turn — before the caller has heard anything: the
 * session says the goodbye once the tool ran, and TTS synthesizes and plays it
 * after that. Disconnecting there is what produces the classic "Thanks for
 * calling, take ca—".
 *
 * So the tool only records the intent, and the disconnect waits for the reply
 * that carried it to finish playing. The wait is LiveKit's own played-out
 * signal, not a timer: a `SpeechHandle` resolves `waitForPlayout()` once its
 * generation task is done, and that task awaits `audioOutput.waitForPlayout()`
 * — the room's audio source having handed every frame of the reply to the
 * published track. It is the same signal that decides whether a reply is
 * committed to the transcript whole or truncated to the words that actually
 * played (`interrupted`), which is why an interrupted goodbye is detectable
 * here at all.
 *
 * What it does NOT cover: the receiver's own jitter buffer. Once the last
 * frame is on the track, the remaining tens of milliseconds of client-side
 * playout are not observable from the agent side by any API LiveKit exposes.
 * No timer is added to paper over that — see docs/agent-guide/voice-sessions.md.
 */

/** The part of LiveKit's `SpeechHandle` a hang-up needs. Structural on
 * purpose: the voice host passes the real handle, tests pass a fake, and
 * neither needs to import the other's types. */
export type SpokenReply = {
  /** Resolves when this reply is done: fully played, or cut short. */
  waitForPlayout(): Promise<void>;
  /** True when the user talked over the reply (or it was superseded). */
  readonly interrupted: boolean;
};

export type EndCallHangup = {
  /** The model called `end_call`. Returns immediately; the call disconnects
   * once the reply that carried the tool call has finished playing. */
  request: () => void;
  /** True between a request and the disconnect it leads to. */
  isPending: () => boolean;
};

export type EndCallHangupOptions = {
  /** The reply being spoken right now, the one that says the goodbye, or null
   * when no reply is playing (nothing to wait for). */
  currentReply: () => SpokenReply | null;
  /** Tear down the voice session and disconnect the room. */
  close: () => Promise<void> | void;
  /** The caller talked over the closing line, so the call stays up. The model was told
   * the call ends: this is where it learns that it did not. */
  onCancelled?: () => void;
  /** Progress, at info level. */
  log?: (message: string) => void;
  /** The hang-up failed: the call is still up and nobody else is watching it.
   * Without a handler the rejection surfaces as an unhandled rejection rather
   * than disappearing. */
  onError?: (error: unknown) => void;
};

export function createEndCallHangup(options: EndCallHangupOptions): EndCallHangup {
  const { currentReply, close, onCancelled, log, onError } = options;
  let pending = false;
  // Talking over a goodbye keeps the call up once. A voicemail menu or an announcement
  // talks over every goodbye, and cancelling each time held the call until the other side
  // hung up; a model that ends the call again after a cancellation has heard what was said.
  let cancelledOnce = false;

  const request = () => {
    // The model queued the tool twice in one turn; the first request already
    // owns the wait.
    if (pending) return;
    pending = true;
    const reply = currentReply();

    void (async () => {
      await reply?.waitForPlayout();
      if (reply?.interrupted && !cancelledOnce) {
        // The user talked over the closing line, so they are not finished —
        // hanging up now would cut off a person who is mid-sentence, which is
        // strictly worse than staying on the line. The model gets its next
        // turn and can end the call again after answering.
        pending = false;
        cancelledOnce = true;
        log?.("end_call cancelled — the user interrupted the closing line");
        onCancelled?.();
        return;
      }
      log?.(
        reply?.interrupted
          ? "end_call — closing line interrupted again, hanging up"
          : "end_call — closing line finished playing, hanging up",
      );
      await close();
    })().catch((error: unknown) => {
      pending = false;
      if (onError) {
        onError(error);
        return;
      }
      throw error;
    });
  };

  return { request, isPending: () => pending };
}
