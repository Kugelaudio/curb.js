/**
 * Browser side of a live call: joins the LiveKit room the server prepared
 * (the ticket arrives over the conversation's WebSocket as a voice_session
 * frame), publishes the mic, and plays the agent's audio track (WebRTC
 * playback — Chrome echo-cancels it natively).
 *
 * It carries NO transcript: the conversation's messages are server-pushed
 * over the WS like any typed turn. What it adds is the live layer — call
 * status (listening/thinking/speaking) and the in-flight partial
 * transcription of what the user is saying.
 */

import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type Participant,
} from "livekit-client";
import type { VoiceClientState } from "./types.js";
import type { ConversationRecording } from "./conversation-recording.js";
import { CallRecordings, RECORDING_EMPTY_ERROR } from "./call-recordings.js";
import {
  endedCallState,
  INITIAL_VOICE_STATE,
  joinFailureMessage,
  microphoneDevices,
  NO_CALLER_SPEECH,
  pickMicrophone,
  type VoiceTicket,
} from "./call-state.js";
import {
  applyCallerSegment,
  TRANSCRIPTION_FINAL,
  TRANSCRIPTION_SEGMENT_ID,
  type CallerSegmentUpdate,
} from "./caller-transcript.js";

/** The topic @livekit/agents publishes the agent's transcript on
 * (`TOPIC_TRANSCRIPTION` in its constants). Not exported by the client SDK, so
 * it is pinned here rather than reached for through a deep import. */
const AGENT_TRANSCRIPT_TOPIC = "lk.transcription";

/** A transcript stream that ended abnormally. Barge-in ends one by design, so
 * this must never throw or reject — but it must not vanish either, since a
 * transcript that silently stops arriving looks exactly like an agent that
 * stopped talking. */
function logVoiceStreamEnd(error: unknown): void {
  console.warn("[voice] agent transcript stream ended early", error);
}

/** TEMPORARY: report a phase change to the dev server so browser render state
 * and the voice pipeline appear on one timeline. Fire-and-forget. */
function tracePhase(what: string): void {
  void fetch(`/__voice-phase?p=${encodeURIComponent(what)}`).catch(() => undefined);
}

export class LivekitVoiceClient {
  private state: VoiceClientState = INITIAL_VOICE_STATE;
  private readonly listeners = new Set<() => void>();
  private room: Room | null = null;
  private audioElements: HTMLMediaElement[] = [];
  private generation = 0;
  private microphoneTrack: MediaStreamTrack | null = null;
  private preferredMicrophoneId: string | null = null;
  /** The ticket currently joined (or being joined) — makes start idempotent. */
  private activeToken: string | null = null;
  /** Caller transcript streams opened so far: their order, which interims cannot carry. */
  private callerStreams = 0;

  private readonly onDeviceChange = () => {
    // refreshMicrophones records any failure in visible state before rejecting.
    void this.refreshMicrophones().catch(() => undefined);
  };

  constructor(private readonly recordings = new CallRecordings()) {
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    }
  }

  getState(): VoiceClientState {
    return this.state;
  }

  /** A conversation's recordings: the same array until one is added, also when it has none,
   * so a component that restarts when the array changes does not restart on every render. */
  getRecordings(conversationId: string | null): readonly ConversationRecording[] {
    return this.recordings.get(conversationId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private patch(partial: Partial<VoiceClientState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  /**
   * One transcript text stream, the caller's or the agent's (see the handler in `start`).
   * Public so a test can feed it the streams @livekit/agents publishes.
   */
  async receiveTranscript(
    reader: AsyncIterable<string>,
    stream: { fromCaller: boolean; attributes: Readonly<Record<string, string>> },
    generation = this.generation,
  ): Promise<void> {
    if (generation !== this.generation) return;
    if (stream.fromCaller) return this.receiveCallerTranscript(reader, stream.attributes, generation);
    let text = "";
    try {
      for await (const chunk of reader) {
        if (generation !== this.generation) return;
        text += chunk;
        // LiveKit's synchronizer paces the agent's stream against actual playback using
        // the word timestamps our TTS reports, so each chunk lands as its words are
        // heard. This is the ink cursor.
        if (this.state.replyPlayback.phase !== "speaking") {
          tracePhase(`speaking first chunk ${JSON.stringify(text.slice(0, 40))}`);
        }
        this.patch({ replyPlayback: { phase: "speaking", heard: text } });
      }
      if (generation !== this.generation) return;
      // Ran to the end, so every word reached the caller. The final chunk does not always
      // carry the closing word (the synchronizer closes the stream once playout is done),
      // which left that word muted after it had plainly been said.
      tracePhase("spoken (agent stream ended)");
      this.patch({ replyPlayback: { phase: "spoken" } });
    } catch (error) {
      // Barge-in cuts the agent's stream by design: the words already delivered stay put
      // and the interruption record takes over.
      if (generation !== this.generation) return;
      logVoiceStreamEnd(error);
    }
  }

  /**
   * One recognition update of what the caller is saying: a whole stream per interim, the
   * full text of its segment so far (see `caller-transcript.ts`). Only the segment's final
   * says the caller finished a sentence, so only it arms `pending`; an interim heard while
   * the agent still speaks leaves its reply inked as far as it was heard.
   */
  private async receiveCallerTranscript(
    reader: AsyncIterable<string>,
    attributes: Readonly<Record<string, string>>,
    generation: number,
  ): Promise<void> {
    // Taken before the first await, so it is the order the streams opened in.
    const opened = ++this.callerStreams;
    const id = attributes[TRANSCRIPTION_SEGMENT_ID] ?? `stream-${opened}`;
    const final = attributes[TRANSCRIPTION_FINAL] === "true";
    let text = "";
    try {
      for await (const chunk of reader) {
        if (generation !== this.generation) return;
        text += chunk;
        this.applyCallerSpeech({ id, text, final: false, opened });
      }
    } catch (error) {
      // What arrived stays: the next update of the segment replaces it.
      if (generation !== this.generation) return;
      logVoiceStreamEnd(error);
      return;
    }
    if (generation !== this.generation || !final) return;
    const before = this.state.callerSpeech;
    this.applyCallerSpeech({ id, text, final: true, opened });
    if (this.state.callerSpeech === before) return;
    // The caller finished a sentence. A reply is coming and not one word of it has been
    // spoken: the earliest honest moment to mute, well before the agent's own stream exists.
    tracePhase("pending (caller segment final)");
    this.patch({ processing: true, replyPlayback: { phase: "pending" } });
  }

  private applyCallerSpeech(update: CallerSegmentUpdate): void {
    const callerSpeech = applyCallerSegment(this.state.callerSpeech, update);
    if (callerSpeech !== this.state.callerSpeech) this.patch({ callerSpeech, processing: false });
  }

  /** Refresh the microphone list. Without `requestPermission`, browsers may return
   * anonymous labels until the call starts; with it, the browser asks once and names them. */
  async refreshMicrophones({ requestPermission = false }: { requestPermission?: boolean } = {}): Promise<void> {
    try {
      const listed = microphoneDevices(await Room.getLocalDevices("audioinput", requestPermission));
      const active = this.room?.getActiveDevice("audioinput") ?? this.preferredMicrophoneId;
      const selected = pickMicrophone(listed, active);
      this.preferredMicrophoneId = selected;
      this.patch({ microphones: listed, selectedMicrophoneId: selected });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.patch({ error: `Could not list microphones: ${detail}` });
      throw cause;
    }
  }

  /**
   * Mute or unmute the microphone mid-call.
   *
   * `setMicrophoneEnabled` rather than stopping the track or muting it locally:
   * LiveKit signals the mute to the room, so the agent receives nothing at all
   * and its VAD stays quiet. Silencing only the local element would leave the
   * agent listening to a caller who believes they are muted, which is the one
   * outcome a mute button must never produce.
   *
   * The publication is kept, so unmuting resumes the same track without
   * re-asking for permission or re-running device selection.
   */
  /**
   * A reply is coming and none of it has been spoken.
   *
   * The transcript stream that drives the ink-as-spoken cursor does not open
   * until LiveKit forwards its first synchronized chunk, which is already a few
   * words into playout — so a reply committed before then rendered fully inked
   * and only dropped to muted once the stream caught up. Turn start is the
   * honest moment to mute; speech is what un-mutes.
   *
   * Spoken turns hit this through the STT final. Typing into a live call never
   * produces one, so the caller announces it instead.
   */
  expectReply(): void {
    if (!this.state.connected) return;
    tracePhase("pending (expectReply)");
    this.patch({ replyPlayback: { phase: "pending" } });
  }

  async setMicMuted(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room || !this.state.connected) {
      // Nothing is published yet. Remember the intent so a call that starts
      // muted stays muted rather than opening a live mic.
      this.patch({ micMuted: muted });
      return;
    }
    if (this.state.micMuted === muted) return;

    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
      this.patch({ micMuted: muted, error: null });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // Left at its previous value: reporting a mute that did not happen is how
      // somebody keeps talking believing nobody can hear them.
      this.patch({ error: `Could not ${muted ? "mute" : "unmute"} the microphone: ${detail}` });
      throw cause;
    }
  }

  /** Select an input for the next call or switch the live call in place. */
  async selectMicrophone(deviceId: string): Promise<void> {
    const device = this.state.microphones.find((candidate) => candidate.deviceId === deviceId);
    if (!device) {
      const error = new Error(`Microphone ${JSON.stringify(deviceId)} is no longer available.`);
      this.patch({ error: error.message });
      throw error;
    }

    const room = this.room;
    if (!room || !this.state.connected) {
      this.preferredMicrophoneId = deviceId;
      this.patch({ selectedMicrophoneId: deviceId, error: null });
      return;
    }

    if (this.state.switchingMicrophone || this.state.selectedMicrophoneId === deviceId) return;
    this.patch({ switchingMicrophone: true, error: null });
    const previousTrack = this.microphoneTrack;
    try {
      const switched = await room.switchActiveDevice("audioinput", deviceId, true);
      if (!switched) throw new Error("LiveKit did not activate the selected device.");
      const nextTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack;
      if (!nextTrack) throw new Error("The selected device did not provide an audio track.");
      if (previousTrack && previousTrack !== nextTrack) this.recordings.disconnect(previousTrack);
      this.recordings.connect(nextTrack);
      this.microphoneTrack = nextTrack;
      this.preferredMicrophoneId = deviceId;
      this.patch({ selectedMicrophoneId: deviceId, switchingMicrophone: false, error: null });
      await this.refreshMicrophones();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.patch({ switchingMicrophone: false, error: `Could not switch microphone: ${detail}` });
      throw cause;
    }
  }

  private finishRecording(): void {
    void this.recordings.finish()?.then((outcome) =>
      this.patch(
        outcome === "saved" ? { recordingRevision: this.recordings.revision } : { error: RECORDING_EMPTY_ERROR },
      ),
    );
  }

  async start(ticket: VoiceTicket): Promise<void> {
    if (this.activeToken === ticket.token) return; // already on this call
    this.stop();
    this.activeToken = ticket.token;
    const generation = ++this.generation;
    this.patch({
      ...endedCallState(this.state, this.preferredMicrophoneId),
      connecting: true,
    });

    const room = new Room();
    this.room = room;
    const remoteAudioTracks = new Set<MediaStreamTrack>();

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      // WebRTC element playback: inside Chrome's echo-cancellation reference
      // by construction — the mic never hears the agent.
      const element = track.attach();
      element.style.display = "none";
      document.body.appendChild(element);
      this.audioElements.push(element);
      remoteAudioTracks.add(track.mediaStreamTrack);
      this.recordings.connect(track.mediaStreamTrack);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      remoteAudioTracks.delete(track.mediaStreamTrack);
      this.recordings.disconnect(track.mediaStreamTrack);
    });

    /**
     * BOTH TRANSCRIPTS ARRIVE HERE, and which one this is decides everything.
     *
     * @livekit/agents publishes over a text stream on `lk.transcription` for
     * the caller's STT and the agent's reply alike, with `senderIdentity` set
     * to whoever was transcribed. `RoomEvent.TranscriptionReceived` fires only
     * for the legacy transcription data packet, so it never fires at all —
     * which is why the caller's turn never armed `pending` and a reply stayed
     * inked for its first few words, until the AGENT's stream opened partway
     * into playout and finally muted it.
     */
    room.registerTextStreamHandler(AGENT_TRANSCRIPT_TOPIC, (reader, info) => {
      const fromCaller = info.identity === room.localParticipant.identity;
      void this.receiveTranscript(reader, { fromCaller, attributes: reader.info.attributes ?? {} }, generation);
    });

    // speaking = the agent's participant is producing audio right now.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      if (generation !== this.generation) return;
      const speaking = speakers.some((speaker) => !speaker.isLocal);
      this.patch({ speaking, ...(speaking ? { processing: false } : {}) });
    });

    room.on(RoomEvent.Disconnected, () => {
      if (generation !== this.generation) return;
      this.activeToken = null;
      this.room = null;
      this.microphoneTrack = null;
      this.finishRecording();
      for (const element of this.audioElements) element.remove();
      this.audioElements = [];
      this.patch(endedCallState(this.state, this.preferredMicrophoneId));
    });

    try {
      await room.connect(ticket.url, ticket.token, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true, {
        ...(this.preferredMicrophoneId
          ? { deviceId: { exact: this.preferredMicrophoneId } }
          : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack;
      this.microphoneTrack = microphone ?? null;
      const tracks = [...remoteAudioTracks, ...(microphone ? [microphone] : [])];
      await this.recordings.start({ conversationId: ticket.conversationId, room: ticket.room }, tracks);
      await this.refreshMicrophones();
    } catch (error) {
      if (generation !== this.generation) return;
      // Invalidate this room before disconnecting so its Disconnected event
      // cannot erase the explicit setup error below.
      this.generation += 1;
      this.activeToken = null;
      this.room = null;
      this.microphoneTrack = null;
      this.finishRecording();
      for (const element of this.audioElements) element.remove();
      this.audioElements = [];
      if (room.state !== ConnectionState.Disconnected) void room.disconnect();
      this.patch({
        connecting: false,
        error: joinFailureMessage(error),
      });
      return;
    }
    if (generation !== this.generation) {
      void room.disconnect();
      return;
    }
    this.patch({ connected: true, connecting: false, listening: true, error: null });
  }

  stop(): void {
    this.generation += 1;
    this.activeToken = null;
    const room = this.room;
    this.room = null;
    this.microphoneTrack = null;
    this.finishRecording();
    for (const element of this.audioElements) element.remove();
    this.audioElements = [];
    if (room && room.state !== ConnectionState.Disconnected) void room.disconnect();
    this.patch({
      connected: false,
      connecting: false,
      listening: false,
      speaking: false,
      processing: false,
      error: null,
      callerSpeech: NO_CALLER_SPEECH,
      switchingMicrophone: false,
      // Cleared with the call. Carrying a mute into the NEXT call would open it
      // silent with a live-looking UI, and the caller would find out by talking
      // to nobody.
      micMuted: false,
      replyPlayback: INITIAL_VOICE_STATE.replyPlayback,
    });
  }

  dispose(): void {
    this.stop();
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener("devicechange", this.onDeviceChange);
    }
    this.listeners.clear();
  }
}
