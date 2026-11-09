import { describe, expect, it, vi } from "vitest";
import { connectedWithin } from "./local-voice-media.js";

/** The part of a peer connection the wait reads. */
function fakeConnection(state: RTCPeerConnectionState) {
  const connection = new EventTarget() as EventTarget & { connectionState: RTCPeerConnectionState };
  connection.connectionState = state;
  return {
    connection: connection as unknown as RTCPeerConnection,
    become(next: RTCPeerConnectionState) {
      connection.connectionState = next;
      connection.dispatchEvent(new Event("connectionstatechange"));
    },
  };
}

describe("connectedWithin", () => {
  it("answers at once for a connection already up", async () => {
    await expect(connectedWithin(fakeConnection("connected").connection, 1000)).resolves.toBe(true);
  });

  it("answers true when it connects in time", async () => {
    const fake = fakeConnection("connecting");
    const answer = connectedWithin(fake.connection, 1000);
    fake.become("connected");
    await expect(answer).resolves.toBe(true);
  });

  it("answers false as soon as it fails", async () => {
    const fake = fakeConnection("connecting");
    const answer = connectedWithin(fake.connection, 1000);
    fake.become("failed");
    await expect(answer).resolves.toBe(false);
  });

  it("answers false when it never gets anywhere, which is a page with no ICE candidates", async () => {
    vi.useFakeTimers();
    try {
      const answer = connectedWithin(fakeConnection("new").connection, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(answer).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
