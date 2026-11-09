/**
 * The browser's audio for a local call (`local-voice-client.ts`): the microphone, cut into
 * 16 kHz PCM frames for the agent, and the agent's 24 kHz voice, played and counted.
 *
 * The agent's voice reaches the speakers through a WebRTC connection from this page to
 * itself. Chrome's echo canceller only subtracts audio that arrives over WebRTC, so voice
 * played straight from Web Audio would come back through the microphone and the agent
 * would interrupt itself. LiveKit calls get this for free; a local call builds the loop.
 *
 * Nothing but ICE tells whether that loop works, and without it the page looks fine: the
 * element plays, the worklet counts the audio as played, and nobody hears it. So the call
 * waits for the loop, and a page that cannot reach itself (a browser policy, an extension,
 * a firewall) plays the voice straight from Web Audio and says what that costs.
 */

import { LOCAL_VOICE_INPUT_SAMPLE_RATE, LOCAL_VOICE_OUTPUT_SAMPLE_RATE } from "../../local-voice-wire.js";
import { int16ToFloat, type PlayoutEvent } from "./pcm.js";
import {
  CAPTURE_PROCESSOR,
  localVoiceWorkletSource,
  PLAYOUT_PROCESSOR,
  type CaptureOptions,
  type PlayoutCommand,
} from "./local-voice-worklet.js";

/** The microphone frames the agent hears: 20 ms. */
const FRAME_SAMPLES = LOCAL_VOICE_INPUT_SAMPLE_RATE / 50;

/** How long the loop gets to connect before the call starts without it. */
const LOOPBACK_CONNECT_MS = 3000;

/** What the call's audio tells the client. */
export type CallMediaEvents = {
  /** One frame of 16-bit mono PCM at {@link LOCAL_VOICE_INPUT_SAMPLE_RATE}. */
  microphoneFrame(pcm: ArrayBuffer): void;
  /** A segment of the agent's voice ended: played out, or cut. */
  playout(event: PlayoutEvent): void;
};

/** One call's audio, open. */
export type CallMedia = {
  /** The microphone in use; `enabled = false` silences it. */
  readonly microphone: MediaStreamTrack;
  /** The agent's voice, for the call recording. */
  readonly agentVoice: MediaStreamTrack;
  /** False when the voice bypasses the loop, so the agent may hear itself. */
  readonly echoCancelled: boolean;
  /** 16-bit mono PCM at {@link LOCAL_VOICE_OUTPUT_SAMPLE_RATE}. */
  play(pcm: Int16Array): void;
  /** The current segment has all its audio. */
  flush(): void;
  /** Cut the current segment (a barge-in). */
  clear(): void;
  /** Move to another microphone; the old track stops. */
  switchMicrophone(deviceId: string): Promise<MediaStreamTrack>;
  close(): Promise<void>;
};

export type OpenCallMedia = (deviceId: string | null, events: CallMediaEvents) => Promise<CallMedia>;

function microphone(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

/** The ICE candidates are in the description once gathering is complete, so the two ends
 * need no trickle (whose candidates could arrive before the other end can take them). */
async function gathered(connection: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  if (connection.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const done = () => {
        if (connection.iceGatheringState !== "complete") return;
        connection.removeEventListener("icegatheringstatechange", done);
        resolve();
      };
      connection.addEventListener("icegatheringstatechange", done);
    });
  }
  const description = connection.localDescription;
  if (!description) throw new Error("the audio loopback has no local description");
  return description;
}

/** `track` sent from this page to itself; the received copy is what the speakers play. */
async function webrtcLoopback(
  track: MediaStreamTrack,
): Promise<{ track: MediaStreamTrack; connection: RTCPeerConnection; close(): void }> {
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  const close = () => {
    sender.close();
    receiver.close();
  };
  try {
    const received = new Promise<MediaStreamTrack>((resolve) => {
      receiver.addEventListener("track", (event) => resolve(event.track), { once: true });
    });
    sender.addTrack(track, new MediaStream([track]));
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(await gathered(sender));
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(await gathered(receiver));
    return { track: await received, connection: receiver, close };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Whether `connection` is connected within `timeoutMs`. False at once when it fails; a
 * connection with no candidates stays "new" and never fails, so only the time ends that wait.
 */
export function connectedWithin(connection: RTCPeerConnection, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (connected: boolean) => {
      clearTimeout(timer);
      connection.removeEventListener("connectionstatechange", changed);
      resolve(connected);
    };
    const changed = () => {
      if (connection.connectionState === "connected") finish(true);
      else if (connection.connectionState === "failed" || connection.connectionState === "closed") finish(false);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    connection.addEventListener("connectionstatechange", changed);
    changed();
  });
}

export const openBrowserCallMedia: OpenCallMedia = async (deviceId, events) => {
  let stream = await microphone(deviceId);
  const workletUrl = URL.createObjectURL(new Blob([localVoiceWorkletSource()], { type: "text/javascript" }));
  const capture = new AudioContext();
  // The agent's own rate: the browser resamples to the device, the worklet only counts.
  const playback = new AudioContext({ sampleRate: LOCAL_VOICE_OUTPUT_SAMPLE_RATE });
  const element = document.createElement("audio");
  let loopback: Awaited<ReturnType<typeof webrtcLoopback>> | null = null;

  const close = async () => {
    for (const track of stream.getTracks()) track.stop();
    loopback?.close();
    element.srcObject = null;
    element.remove();
    URL.revokeObjectURL(workletUrl);
    await Promise.all([capture.close(), playback.close()]);
  };

  try {
    await Promise.all([capture.audioWorklet.addModule(workletUrl), playback.audioWorklet.addModule(workletUrl)]);

    const captureOptions: CaptureOptions = { outputRate: LOCAL_VOICE_INPUT_SAMPLE_RATE, frameSamples: FRAME_SAMPLES };
    const captureNode = new AudioWorkletNode(capture, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: captureOptions,
    });
    captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => events.microphoneFrame(event.data);
    // A graph only runs what reaches a destination; the gain keeps the microphone off the speakers.
    const muted = capture.createGain();
    muted.gain.value = 0;
    captureNode.connect(muted).connect(capture.destination);
    let source = capture.createMediaStreamSource(stream);
    source.connect(captureNode);

    const playoutNode = new AudioWorkletNode(playback, PLAYOUT_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    playoutNode.port.onmessage = (event: MessageEvent<PlayoutEvent>) => events.playout(event.data);
    const voiceOut = playback.createMediaStreamDestination();
    playoutNode.connect(voiceOut);
    const [voiceTrack] = voiceOut.stream.getAudioTracks();
    if (!voiceTrack) throw new Error("the agent's voice has no audio track to play");
    loopback = await webrtcLoopback(voiceTrack);
    const echoCancelled = await connectedWithin(loopback.connection, LOOPBACK_CONNECT_MS);

    if (echoCancelled) {
      element.style.display = "none";
      element.srcObject = new MediaStream([loopback.track]);
      document.body.appendChild(element);
      await element.play();
    } else {
      console.warn(`[voice] the audio loopback did not connect (${loopback.connection.connectionState}); playing without echo cancellation`);
      loopback.close();
      playoutNode.connect(playback.destination);
    }
    await Promise.all([capture.resume(), playback.resume()]);

    const [firstMicrophone] = stream.getAudioTracks();
    if (!firstMicrophone) throw new Error("The microphone gave no audio track.");
    let microphoneTrack = firstMicrophone;
    const command = (message: PlayoutCommand, transfer: Transferable[] = []) =>
      playoutNode.port.postMessage(message, transfer);

    return {
      get microphone() {
        return microphoneTrack;
      },
      agentVoice: voiceTrack,
      echoCancelled,
      play(pcm) {
        const samples = int16ToFloat(pcm);
        command({ type: "audio", samples }, [samples.buffer]);
      },
      flush: () => command({ type: "flush" }),
      clear: () => command({ type: "clear" }),
      async switchMicrophone(nextId) {
        const next = await microphone(nextId);
        const [track] = next.getAudioTracks();
        if (!track) throw new Error("The selected microphone gave no audio track.");
        track.enabled = microphoneTrack.enabled;
        source.disconnect();
        for (const old of stream.getTracks()) old.stop();
        stream = next;
        source = capture.createMediaStreamSource(next);
        source.connect(captureNode);
        microphoneTrack = track;
        return track;
      },
      close,
    };
  } catch (error) {
    // KEEP-JUSTIFIED: releasing what opened before the failure; the setup error is what the
    // caller needs, and a second error about the cleanup would bury it.
    await close().catch(() => undefined);
    throw error;
  }
};

/** The audio inputs; with `requestPermission`, asks once so the browser names them. */
export async function listBrowserMicrophones(requestPermission: boolean): Promise<MediaDeviceInfo[]> {
  const listed = await navigator.mediaDevices.enumerateDevices();
  const unnamed = listed.some((device) => device.kind === "audioinput" && !device.label);
  if (!requestPermission || !unnamed) return listed;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  return navigator.mediaDevices.enumerateDevices();
}
