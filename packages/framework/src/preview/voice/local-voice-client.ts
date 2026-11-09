/**
 * Browser side of a local call: the call `curb dev` runs when no LiveKit is configured. The
 * microphone goes to the dev server as PCM over a WebSocket of its own (`/voice/local`,
 * wire format in `local-voice-wire.ts`), and the agent's voice and transcripts come back on
 * it. No media server, no room.
 *
 * It shows the same live layer as `livekit-voice-client.ts` (call status, the caller's
 * words as they are recognised, the reply inked as it is heard) from the same state, and
 * it tells the server how much of each reply actually played, which is what cuts an
 * interrupted reply to the words the caller heard.
 */

import { parseLocalVoiceServerMessage, type LocalVoiceServerMessage } from "../../local-voice-wire.js";
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
import { applyCallerSegment } from "./caller-transcript.js";
import type { ConversationRecording } from "./conversation-recording.js";
import { listBrowserMicrophones, openBrowserCallMedia, type CallMedia, type OpenCallMedia } from "./local-voice-media.js";
import type { PlayoutEvent } from "./pcm.js";
import type { VoiceClientState } from "./types.js";

/** Close codes that end a call normally: hung up by either side, or the socket said nothing. */
const NORMAL_CLOSE = new Set([1000, 1005]);

/** What the page says when the agent's voice plays without echo cancellation. */
export const NO_ECHO_CANCELLATION =
  "This browser blocked the audio path echo cancellation needs, so the agent may hear itself. Use headphones, or check for a VPN or a privacy extension that limits WebRTC.";

/** The page's error line on a call with nothing wrong: empty, or this call's standing warning. */
function callWarning(media: CallMedia): string | null {
  return media.echoCancelled ? null : NO_ECHO_CANCELLATION;
}

/** What a local call reaches outside itself; a test passes its own. */
export type LocalCallIO = {
  openMedia: OpenCallMedia;
  openSocket(url: string): WebSocket;
  listMicrophones(requestPermission: boolean): Promise<MediaDeviceInfo[]>;
  /** The page's own URL, which the ticket's socket path is relative to. */
  pageUrl(): string;
};

export const BROWSER_CALL_IO: LocalCallIO = {
  openMedia: openBrowserCallMedia,
  openSocket: (url) => new WebSocket(url),
  listMicrophones: listBrowserMicrophones,
  pageUrl: () => window.location.href,
};

/** The ticket's socket path as a ws(s) URL on the page's own host. */
export function localVoiceSocketUrl(path: string, pageUrl: string): string {
  const url = new URL(path, pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

type ActiveCall = { socket: WebSocket; media: CallMedia };

export class LocalVoiceClient {
  private state: VoiceClientState = INITIAL_VOICE_STATE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private call: ActiveCall | null = null;
  /** The ticket currently joined (or being joined): makes start idempotent. */
  private activeToken: string | null = null;
  private preferredMicrophoneId: string | null = null;
  /** The order each caller segment first appeared in, which its updates do not carry. */
  private readonly callerSegments = new Map<string, number>();
  /** The current reply's words as far as they have been heard. */
  private agentText = "";

  private readonly onDeviceChange = () => {
    // refreshMicrophones records any failure in visible state before rejecting.
    void this.refreshMicrophones().catch(() => undefined);
  };

  constructor(
    private readonly recordings = new CallRecordings(),
    private readonly io: LocalCallIO = BROWSER_CALL_IO,
  ) {
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
    }
  }

  getState(): VoiceClientState {
    return this.state;
  }

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

  /** A reply is coming and none of it has been spoken (see `LivekitVoiceClient.expectReply`). */
  expectReply(): void {
    if (!this.state.connected) return;
    this.patch({ replyPlayback: { phase: "pending" } });
  }

  async refreshMicrophones({ requestPermission = false }: { requestPermission?: boolean } = {}): Promise<void> {
    try {
      const listed = microphoneDevices(await this.io.listMicrophones(requestPermission));
      const selected = pickMicrophone(listed, this.preferredMicrophoneId);
      this.preferredMicrophoneId = selected;
      this.patch({ microphones: listed, selectedMicrophoneId: selected });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.patch({ error: `Could not list microphones: ${detail}` });
      throw cause;
    }
  }

  /**
   * Mute or unmute the microphone mid-call. Muted, no frame is sent at all, so the agent's
   * VAD hears nothing, as when LiveKit unpublishes the track; the track is silenced too.
   */
  async setMicMuted(muted: boolean): Promise<void> {
    const call = this.call;
    if (!call || !this.state.connected) {
      this.patch({ micMuted: muted });
      return;
    }
    if (this.state.micMuted === muted) return;
    call.media.microphone.enabled = !muted;
    this.patch({ micMuted: muted, error: callWarning(call.media) });
  }

  /** Select an input for the next call or switch the live call in place. */
  async selectMicrophone(deviceId: string): Promise<void> {
    const device = this.state.microphones.find((candidate) => candidate.deviceId === deviceId);
    if (!device) {
      const error = new Error(`Microphone ${JSON.stringify(deviceId)} is no longer available.`);
      this.patch({ error: error.message });
      throw error;
    }
    const call = this.call;
    if (!call || !this.state.connected) {
      this.preferredMicrophoneId = deviceId;
      this.patch({ selectedMicrophoneId: deviceId, error: null });
      return;
    }
    if (this.state.switchingMicrophone || this.state.selectedMicrophoneId === deviceId) return;
    this.patch({ switchingMicrophone: true, error: callWarning(call.media) });
    const previous = call.media.microphone;
    try {
      const next = await call.media.switchMicrophone(deviceId);
      this.recordings.disconnect(previous);
      this.recordings.connect(next);
      this.preferredMicrophoneId = deviceId;
      this.patch({ selectedMicrophoneId: deviceId, switchingMicrophone: false, error: callWarning(call.media) });
      await this.refreshMicrophones();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.patch({ switchingMicrophone: false, error: `Could not switch microphone: ${detail}` });
      throw cause;
    }
  }

  async start(ticket: VoiceTicket): Promise<void> {
    if (this.activeToken === ticket.token) return; // already on this call
    this.stop();
    this.activeToken = ticket.token;
    const generation = ++this.generation;
    this.patch({ ...endedCallState(this.state, this.preferredMicrophoneId), connecting: true });

    let media: CallMedia | null = null;
    let socket: WebSocket | null = null;
    try {
      media = await this.io.openMedia(this.preferredMicrophoneId, {
        microphoneFrame: (pcm) => this.sendMicrophone(generation, pcm),
        playout: (event) => this.sendPlayout(generation, event),
      });
      socket = await this.connect(localVoiceSocketUrl(ticket.url, this.io.pageUrl()), generation);
      if (generation !== this.generation) throw new Error("the call was replaced while it opened");
      media.microphone.enabled = !this.state.micMuted;
      this.call = { socket, media };
      await this.recordings.start(
        { conversationId: ticket.conversationId, room: ticket.room },
        [media.microphone, media.agentVoice],
      );
      await this.refreshMicrophones();
    } catch (error) {
      const current = generation === this.generation;
      if (this.call?.socket === socket) this.call = null;
      this.finishRecording();
      socket?.close(1000, "call setup failed");
      // KEEP-JUSTIFIED: releasing the microphone after a failed setup; the setup error
      // below is what the caller sees, and a second error about the cleanup would bury it.
      await media?.close().catch(() => undefined);
      if (!current) return;
      this.generation += 1;
      this.activeToken = null;
      this.patch({ connecting: false, error: joinFailureMessage(error) });
      return;
    }
    this.patch({ connected: true, connecting: false, listening: true, error: callWarning(media) });
  }

  /** The call's socket, open; rejects when it closes or fails first. */
  private connect(url: string, generation: number): Promise<WebSocket> {
    const socket = this.io.openSocket(url);
    socket.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      let open = false;
      socket.addEventListener("open", () => {
        open = true;
        resolve(socket);
      });
      socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => this.receive(event.data, generation));
      socket.addEventListener("close", (event) => {
        if (!open) reject(new Error(`the dev server refused the call socket (${event.code} ${event.reason})`.trim()));
        else this.socketClosed(generation, event.code, event.reason);
      });
    });
  }

  /**
   * One frame from the dev server: the agent's voice (binary) or a control message. Public so
   * a test can play the server's side.
   */
  receive(data: ArrayBuffer | string, generation = this.generation): void {
    if (generation !== this.generation) return;
    if (typeof data !== "string") {
      this.call?.media.play(new Int16Array(data));
      return;
    }
    let message: LocalVoiceServerMessage;
    try {
      message = parseLocalVoiceServerMessage(data);
    } catch (error) {
      // The dev server and this page are one framework version; this is a bug, said out loud.
      console.error("[voice] the dev server sent a call frame this page does not understand", error);
      this.patch({ error: `The voice call sent a frame this page does not understand: ${String(error)}` });
      return;
    }
    switch (message.type) {
      case "audio_flush":
        this.call?.media.flush();
        return;
      case "audio_clear":
        this.call?.media.clear();
        return;
      case "agent_text":
        // Paced against playback by the server's transcription synchronizer: the ink cursor.
        this.agentText += message.text;
        this.patch({ replyPlayback: { phase: "speaking", heard: this.agentText } });
        return;
      case "agent_text_end":
        this.agentText = "";
        this.patch({ replyPlayback: { phase: "spoken" } });
        return;
      case "caller_text":
        return this.receiveCallerText(message.id, message.text, message.final);
      case "agent_state": {
        const speaking = message.state === "speaking";
        this.patch({ speaking, ...(speaking ? { processing: false } : {}) });
        return;
      }
    }
  }

  /**
   * One recognition update of what the caller is saying. Only a segment's final says the
   * caller finished a sentence, so only it arms `pending` (as in the LiveKit client).
   */
  private receiveCallerText(id: string, text: string, final: boolean): void {
    let opened = this.callerSegments.get(id);
    if (opened === undefined) {
      opened = this.callerSegments.size + 1;
      this.callerSegments.set(id, opened);
    }
    const before = this.state.callerSpeech;
    const callerSpeech = applyCallerSegment(before, { id, text, final, opened });
    if (callerSpeech === before) return;
    this.patch({ callerSpeech, processing: false });
    if (final) this.patch({ processing: true, replyPlayback: { phase: "pending" } });
  }

  private sendMicrophone(generation: number, pcm: ArrayBuffer): void {
    const socket = this.call?.socket;
    if (generation !== this.generation || this.state.micMuted || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(pcm);
  }

  private sendPlayout(generation: number, event: PlayoutEvent): void {
    const socket = this.call?.socket;
    if (generation !== this.generation || socket?.readyState !== WebSocket.OPEN) return;
    const type = event.type === "drained" ? "playout_done" : "playout_cleared";
    socket.send(JSON.stringify({ type, playedMs: event.playedMs }));
  }

  private socketClosed(generation: number, code: number, reason: string): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.activeToken = null;
    this.endCall();
    this.patch({
      ...endedCallState(this.state, this.preferredMicrophoneId),
      error: NORMAL_CLOSE.has(code) ? null : `The voice call ended: ${reason || `code ${code}`}`,
    });
  }

  private finishRecording(): void {
    void this.recordings.finish()?.then((outcome) =>
      this.patch(outcome === "saved" ? { recordingRevision: this.recordings.revision } : { error: RECORDING_EMPTY_ERROR }),
    );
  }

  private endCall(): void {
    const call = this.call;
    this.call = null;
    this.agentText = "";
    this.callerSegments.clear();
    this.finishRecording();
    if (!call) return;
    if (call.socket.readyState === WebSocket.OPEN || call.socket.readyState === WebSocket.CONNECTING) {
      call.socket.close(1000, "call ended");
    }
    void call.media.close().catch((error: unknown) => console.error("[voice] could not release the call's audio", error));
  }

  stop(): void {
    this.generation += 1;
    this.activeToken = null;
    this.endCall();
    this.patch({
      connected: false,
      connecting: false,
      listening: false,
      speaking: false,
      processing: false,
      error: null,
      callerSpeech: NO_CALLER_SPEECH,
      switchingMicrophone: false,
      // Cleared with the call, as in the LiveKit client: a mute carried into the next call
      // would open it silent with a live-looking UI.
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
