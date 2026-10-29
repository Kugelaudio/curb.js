import { describe, expect, it } from "vitest";
import { LivekitVoiceClient } from "./livekit-voice-client.js";
import { joinFailureMessage, microphoneDevices } from "./call-state.js";

function mediaDevice(
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = "audioinput",
): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "group",
    kind,
    label,
    toJSON: () => ({}),
  };
}

describe("microphoneDevices", () => {
  it("keeps unique audio inputs and supplies labels before permission", () => {
    expect(
      microphoneDevices([
        mediaDevice("default", ""),
        mediaDevice("usb", "USB microphone"),
        mediaDevice("usb", "duplicate"),
        mediaDevice("camera", "Camera", "videoinput"),
      ]),
    ).toEqual([
      { deviceId: "default", label: "Microphone 1" },
      { deviceId: "usb", label: "USB microphone" },
    ]);
  });
});

describe("recordings", () => {
  // The conversation player re-reads them on every render of the page and restarts when the
  // array changes, so a conversation without a recording must get the same empty array each
  // time, or the page renders without end.
  it("returns the same array for a conversation without recordings", () => {
    const client = new LivekitVoiceClient();
    expect(client.getRecordings("conversation-1")).toBe(client.getRecordings("conversation-1"));
    expect(client.getRecordings(null)).toBe(client.getRecordings(null));
    expect(client.getRecordings(null)).toEqual([]);
  });
});

describe("muting the microphone", () => {
  // A mute button answers one question — "can the agent hear me" — so the state
  // behind it must never claim a mute that did not happen, and must never carry
  // one into a call the caller thinks is fresh.
  it("remembers a mute set before the call connects", async () => {
    const client = new LivekitVoiceClient();
    expect(client.getState().micMuted).toBe(false);

    await client.setMicMuted(true);

    // No room yet, so this is intent rather than a published mute: the call must
    // open muted instead of opening a live mic under a muted-looking button.
    expect(client.getState().micMuted).toBe(true);
    client.dispose();
  });

  it("clears the mute when the call ends", async () => {
    const client = new LivekitVoiceClient();
    await client.setMicMuted(true);

    client.stop();

    // Carrying it into the NEXT call would open it silent with a live-looking
    // UI, and the caller would find out by talking to nobody.
    expect(client.getState().micMuted).toBe(false);
    client.dispose();
  });
});

describe("joinFailureMessage", () => {
  it("says how to allow a microphone the browser blocked", () => {
    const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    expect(joinFailureMessage(denied, "http://127.0.0.1:4000")).toBe(
      "This browser blocked the microphone. Allow it for this page (the icon left of the address bar) and press " +
        "Start call again, or open http://127.0.0.1:4000 in Chrome or Safari. You can also type to your agent here.",
    );
    expect(joinFailureMessage(new Error("Permission denied"), "")).toMatch(/^This browser blocked the microphone/);
  });
  it("names a missing microphone, and keeps any other cause", () => {
    expect(joinFailureMessage(Object.assign(new Error("x"), { name: "NotFoundError" }))).toMatch(/^No microphone found/);
    expect(joinFailureMessage(new Error("timeout"))).toBe("Could not join the voice session: timeout");
  });
});
