/**
 * A LiveKit room as the call a voice session serves (`../call-room.ts`).
 */

import { RoomEvent, type Room } from "@livekit/rtc-node";
import type { VoiceCallRoom } from "../call-room.js";
import { isCaller } from "./call-opening.js";
import { publishTransferTrack } from "./transfer-audio.js";
import { isTransferTarget } from "./transfer-handoff.js";

/** WebRTC/Opus uses a 48 kHz clock. Kugel's native 24 kHz PCM remains the TTS contract;
 * agents-js performs the explicit, duration-preserving 2x resample before frames enter
 * rtc-node instead of leaving it implicit in the native publishing layer. */
const LIVEKIT_PLAYOUT_SAMPLE_RATE = 48000;

/**
 * The caller's audio is delivered at 16 kHz, the rate Silero VAD and every wired STT
 * (Azure, Deepgram, ElevenLabs) consume. At the SDK default of 24 kHz both VAD and STT
 * ran their own JavaScript resampler, one native round trip per 10 ms frame each: 12.6%
 * of a 4-call runner.s main thread in a load test. Asking the room's
 * audio stream for 16 kHz resamples once, natively, before JavaScript sees a frame.
 */
const LIVEKIT_INPUT_SAMPLE_RATE = 16000;

/** `room`, already connected as the agent participant, as a voice call. */
export function livekitCallRoom(room: Room, name: string): VoiceCallRoom {
  return {
    name,
    participants: () => room.remoteParticipants.values(),
    onParticipantConnected: (listener) => void room.on(RoomEvent.ParticipantConnected, listener),
    onParticipantDisconnected: (listener) => void room.on(RoomEvent.ParticipantDisconnected, listener),
    onDisconnected: (listener) => void room.on(RoomEvent.Disconnected, (reason) => listener(String(reason))),
    startSession: async ({ session, agent, onTypedText }) => {
      await session.start({
        agent,
        room,
        inputOptions: {
          audioSampleRate: LIVEKIT_INPUT_SAMPLE_RATE,
          /**
           * THE HOST DECIDES WHEN THE CALL IS OVER, not the caller's client leaving.
           *
           * By default LiveKit closes the session on a client-initiated disconnect, and the agent
           * stays in the room without one: a caller the platform lets back in during its grace
           * gets an agent that never answers. `caller-watchdog.ts` ends a call nobody came back to.
           */
          closeOnDisconnect: false,
          /**
           * A TYPED MESSAGE IS A CALLER TURN, and it was not being recorded as one.
           *
           * Speech reaches the conversation log through the STT plugin, which reports every
           * final result. Text arrives on a different path entirely — the SDK's chat topic —
           * and nothing on it reported anything, so a call conducted by typing produced a
           * transcript containing only the agent's half. `onTypedText` reports it and then
           * answers it the SDK's own way.
           */
          textInputCallback: (activeSession, event) => onTypedText(activeSession, event.text),
        },
        outputOptions: { audioSampleRate: LIVEKIT_PLAYOUT_SAMPLE_RATE },
      });
      // LiveKit relinks a caller who returns under the same identity, and ignores any other, so
      // a caller back under a new one is heard only from here. Added after the start so this
      // runs after LiveKit's own listener, which links a call's first caller.
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        const io = session._roomIO;
        if (!io || io.isParticipantAvailable) return;
        if (isCaller(participant) && !isTransferTarget(participant)) io.setParticipant(participant.identity);
      });
    },
    publishTransferTrack: () => publishTransferTrack(room),
    disconnect: () => room.disconnect(),
  };
}
