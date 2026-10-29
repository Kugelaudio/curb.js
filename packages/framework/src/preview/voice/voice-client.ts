/**
 * The page's one voice client. Each call arrives with its transport (the voice_session
 * frame's `transport`): a LiveKit room (`livekit-voice-client.ts`) or the dev server's own
 * socket (`local-voice-client.ts`). This hands each call to the client for its transport and
 * shows that client's state; both share one recording store, so a conversation's
 * recordings stay one list whatever carried its calls.
 *
 * Before a call nobody knows its transport yet, so what the caller sets then (microphone,
 * mute) goes to both clients and is in place whichever one takes the call.
 */

import { CallRecordings } from "./call-recordings.js";
import type { VoiceTicket } from "./call-state.js";
import type { ConversationRecording } from "./conversation-recording.js";
import { LivekitVoiceClient } from "./livekit-voice-client.js";
import { LocalVoiceClient } from "./local-voice-client.js";
import type { VoiceClientState } from "./types.js";

type TransportClient = LivekitVoiceClient | LocalVoiceClient;

export class VoiceClient {
  private readonly recordings = new CallRecordings();
  private readonly livekit: LivekitVoiceClient;
  private readonly local: LocalVoiceClient;
  private active: TransportClient;

  constructor(clients?: { livekit: LivekitVoiceClient; local: LocalVoiceClient }) {
    this.livekit = clients?.livekit ?? new LivekitVoiceClient(this.recordings);
    this.local = clients?.local ?? new LocalVoiceClient(this.recordings);
    this.active = this.local;
  }

  private get inCall(): boolean {
    const state = this.active.getState();
    return state.connected || state.connecting;
  }

  private get clients(): readonly TransportClient[] {
    return [this.active, this.active === this.local ? this.livekit : this.local];
  }

  getState(): VoiceClientState {
    return this.active.getState();
  }

  getRecordings(conversationId: string | null): readonly ConversationRecording[] {
    return this.recordings.get(conversationId);
  }

  subscribe(listener: () => void): () => void {
    const unsubscribe = this.clients.map((client) => client.subscribe(listener));
    return () => {
      for (const stop of unsubscribe) stop();
    };
  }

  async refreshMicrophones(options: { requestPermission?: boolean } = {}): Promise<void> {
    const [first, second] = this.clients;
    await first!.refreshMicrophones(options);
    // After the first, the browser already names the devices: no second permission prompt.
    await second!.refreshMicrophones();
  }

  expectReply(): void {
    this.active.expectReply();
  }

  async setMicMuted(muted: boolean): Promise<void> {
    if (this.inCall) return this.active.setMicMuted(muted);
    await Promise.all(this.clients.map((client) => client.setMicMuted(muted)));
  }

  async selectMicrophone(deviceId: string): Promise<void> {
    if (this.inCall) return this.active.selectMicrophone(deviceId);
    await Promise.all(this.clients.map((client) => client.selectMicrophone(deviceId)));
  }

  async start(ticket: VoiceTicket): Promise<void> {
    const client = ticket.transport === "local" ? this.local : this.livekit;
    if (client !== this.active) {
      this.active.stop();
      this.active = client;
    }
    await client.start(ticket);
  }

  stop(): void {
    this.active.stop();
  }

  dispose(): void {
    this.livekit.dispose();
    this.local.dispose();
  }
}
