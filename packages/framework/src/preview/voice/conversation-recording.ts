import type { AgentChatMessage } from "../../llm/types.js";

/** One exact browser-side recording of a LiveKit call. The mixed stream
 * contains the published microphone and the remote agent track, so pauses,
 * overlaps, and interruptions match what happened in the room. */
export type ConversationRecording = {
  id: string;
  conversationId: string;
  room: string;
  startedAt: number;
  endedAt: number;
  mimeType: string;
  blob: Blob;
};

export type RecordingWindow = {
  room: string;
  startedAt: number;
  endedAt: number;
  offsetMs: number;
  durationMs: number;
};

export type CombinedConversationRecording = {
  blob: Blob;
  durationMs: number;
  windows: RecordingWindow[];
};

/** Map a transcript timestamp onto the compact combined recording timeline.
 * Real-world gaps between separate calls collapse, while timing inside each
 * call remains exact. Audio metadata wins when a message names its room. */
export function replayTimeForMessage(
  message: AgentChatMessage,
  windows: readonly RecordingWindow[],
): number {
  if (windows.length === 0) return 0;
  const room = "audio" in message ? message.audio?.room : undefined;
  const byRoom = room ? windows.find((window) => window.room === room) : undefined;
  const at = message.at;
  const containing =
    at === undefined
      ? undefined
      : windows.find((window) => at >= window.startedAt && at <= window.endedAt);
  const window = byRoom ?? containing;
  if (window && at !== undefined) {
    const wallDuration = Math.max(1, window.endedAt - window.startedAt);
    const progress = Math.min(1, Math.max(0, (at - window.startedAt) / wallDuration));
    return window.offsetMs + progress * window.durationMs;
  }
  if (window) return window.offsetMs;
  if (at === undefined || at <= windows[0].startedAt) return 0;
  for (let index = 1; index < windows.length; index += 1) {
    if (at < windows[index].startedAt) {
      const previous = windows[index - 1];
      return previous.offsetMs + previous.durationMs;
    }
  }
  const last = windows[windows.length - 1];
  return last.offsetMs + last.durationMs;
}
function encodePcm16Wav(channels: readonly Float32Array[], sampleRate: number): Blob {
  const channelCount = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const dataBytes = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Decode and concatenate every call segment into one seekable WAV. Audio
 * contexts resample decoded input to a shared rate, so segments from browser
 * devices with different native rates still join without pitch changes. */
export async function combineConversationRecordings(
  recordings: readonly ConversationRecording[],
): Promise<CombinedConversationRecording> {
  if (recordings.length === 0) throw new Error("This conversation has no recorded calls.");
  const AudioContextConstructor = window.AudioContext;
  const context = new AudioContextConstructor();
  try {
    const ordered = [...recordings].sort((left, right) => left.startedAt - right.startedAt);
    const decoded = await Promise.all(
      ordered.map(async (recording) =>
        context.decodeAudioData(await recording.blob.arrayBuffer()),
      ),
    );
    const channelCount = Math.max(1, ...decoded.map((audio) => audio.numberOfChannels));
    const frameCount = decoded.reduce((total, audio) => total + audio.length, 0);
    const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
    const windows: RecordingWindow[] = [];
    let frameOffset = 0;
    for (let index = 0; index < decoded.length; index += 1) {
      const audio = decoded[index];
      const recording = ordered[index];
      for (let channel = 0; channel < channelCount; channel += 1) {
        const source = audio.getChannelData(Math.min(channel, audio.numberOfChannels - 1));
        channels[channel].set(source, frameOffset);
      }
      const offsetMs = (frameOffset / context.sampleRate) * 1000;
      const durationMs = audio.duration * 1000;
      windows.push({
        room: recording.room,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt,
        offsetMs,
        durationMs,
      });
      frameOffset += audio.length;
    }
    return {
      blob: encodePcm16Wav(channels, context.sampleRate),
      durationMs: (frameCount / context.sampleRate) * 1000,
      windows,
    };
  } finally {
    await context.close();
  }
}
