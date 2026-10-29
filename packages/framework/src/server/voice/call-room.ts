/**
 * The call a voice session serves, whatever carries its audio.
 *
 * The framework's one voice session (`startVoiceAgent`, `livekit-host/host.ts`) needs five
 * things from a call: who is on it, when someone joins or leaves, when the agent itself
 * lost it, a way to wire the LiveKit `AgentSession`'s audio and transcripts to it, and a
 * phone line's transfer track. Two transports provide them:
 *
 * - a LiveKit room (`livekit-host/livekit-call-room.ts`): `curb start`'s worker, the built
 *   artifact's direct-join and managed modes, and a browser call when the environment names
 *   a LiveKit (`LIVEKIT_URL`, `CURB_REALTIME_SESSION_URL`);
 * - the page's own socket (`local-host/local-call-room.ts`): a browser call with no LiveKit
 *   configured, `curb dev`'s default. Raw PCM over a WebSocket, no WebRTC, no media server,
 *   so the dev loop runs wherever a WebSocket does, a browser-hosted Node runtime included.
 *
 * Everything above this seam (turn-taking, interruption, the opening, end_call, clips) is
 * the same code on both, which is what keeps a local call honest about production.
 */

import type { voice } from "@livekit/agents";
import type { CallParticipant } from "./livekit-host/call-opening.js";
import type { TransferAudioSink } from "./livekit-host/transfer-audio.js";

/** How a call opens its session: the agent, and what to do with a message typed into it. */
export type CallSessionStart = {
  session: voice.AgentSession;
  agent: voice.Agent;
  /** A message the caller typed on the call's own channel (LiveKit's chat topic). A local call
   * has none: its page types on the conversation's socket, which reaches `sendText`. */
  onTypedText: (session: voice.AgentSession, text: string) => Promise<void>;
};

export interface VoiceCallRoom {
  /** The call's name: the LiveKit room, or the local call's id. Clips and logs use it. */
  readonly name: string;
  /** Everyone on the call besides the agent, right now. */
  participants(): Iterable<CallParticipant>;
  onParticipantConnected(listener: (participant: CallParticipant | undefined) => void): void;
  onParticipantDisconnected(listener: (participant: CallParticipant | undefined) => void): void;
  /** The AGENT lost the call; there is nothing left to keep alive. */
  onDisconnected(listener: (reason: string) => void): void;
  /** Wire `session`'s audio and transcripts to this call and start it. */
  startSession(start: CallSessionStart): Promise<void>;
  /** The track a phone caller hears a transfer's announcement and ringback on. */
  publishTransferTrack(): Promise<TransferAudioSink>;
  disconnect(): Promise<void>;
}
