/** What both voice clients (LiveKit and local, `voice-client.ts`) share about a call. */

import { REPLY_IDLE } from "../../llm/spoken-split.js";
import type { VoiceTransport } from "../../server/protocol.js";
import type { CallerSpeech } from "./caller-transcript.js";
import type { MicrophoneDevice, VoiceClientState } from "./types.js";

/** The call the server prepared, from its voice_session frame. */
export type VoiceTicket = {
  transport: VoiceTransport;
  url: string;
  token: string;
  room: string;
  conversationId: string;
};

export const NO_CALLER_SPEECH: CallerSpeech = [];

export const INITIAL_VOICE_STATE: VoiceClientState = {
  connected: false,
  connecting: false,
  listening: false,
  speaking: false,
  processing: false,
  error: null,
  callerSpeech: NO_CALLER_SPEECH,
  microphones: [],
  selectedMicrophoneId: null,
  switchingMicrophone: false,
  micMuted: false,
  replyPlayback: REPLY_IDLE,
  recordingRevision: 0,
};

/** The state a call leaves behind when it ends: idle, with what outlives one call. */
export function endedCallState(state: VoiceClientState, selectedMicrophoneId: string | null): VoiceClientState {
  return {
    ...INITIAL_VOICE_STATE,
    microphones: state.microphones,
    selectedMicrophoneId,
    recordingRevision: state.recordingRevision,
  };
}

/** Stable, display-ready audio inputs. Browsers hide labels until microphone
 * permission is granted, so unnamed devices get a clear numbered fallback. */
export function microphoneDevices(devices: readonly MediaDeviceInfo[]): MicrophoneDevice[] {
  const seen = new Set<string>();
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId.length > 0)
    .filter((device) => {
      if (seen.has(device.deviceId)) return false;
      seen.add(device.deviceId);
      return true;
    })
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`,
    }));
}

/**
 * What a failed join tells the person: a blocked microphone says how to get one. A browser
 * built into an app (the Claude app's) may never allow it, so it names a real browser too.
 */
export function joinFailureMessage(error: unknown, pageUrl = globalThis.location?.origin ?? ""): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "NotAllowedError" || /permission denied/i.test(message)) {
    return (
      "This browser blocked the microphone. Allow it for this page (the icon left of the address bar) and press " +
      `Start call again, or open ${pageUrl || "this page"} in Chrome or Safari. You can also type to your agent here.`
    );
  }
  if (name === "NotFoundError") return "No microphone found. Connect one, then press Start call again.";
  return `Could not join the voice session: ${message}`;
}

/** The selected input after a refresh: the active one if still listed, else the first. */
export function pickMicrophone(listed: readonly MicrophoneDevice[], active: string | null): string | null {
  return active && listed.some((device) => device.deviceId === active) ? active : (listed[0]?.deviceId ?? null);
}
