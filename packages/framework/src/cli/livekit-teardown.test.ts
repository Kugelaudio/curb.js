import { describe, expect, it } from "vitest";
import { isLivekitTeardownFault } from "./livekit-teardown.js";

describe("isLivekitTeardownFault", () => {
  it("recognises the rtc-node disconnect abort that kills the dev server", () => {
    const fault = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
      stack:
        "AbortError: This operation was aborted\n    at Room.cleanupOnDisconnect (/x/node_modules/@livekit/rtc-node/src/room.ts:470:31)",
    });
    expect(isLivekitTeardownFault(fault)).toBe(true);
  });

  it("recognises a send on a closed engine", () => {
    const fault = Object.assign(new Error("engine: connection error: engine is closed"), {
      stack: "Error\n    at LocalParticipant.sendStreamHeader (/x/node_modules/@livekit/rtc-node/src/participant.ts:549:13)",
    });
    expect(isLivekitTeardownFault(fault)).toBe(true);
  });

  it("does NOT swallow an abort from anywhere else", () => {
    // Matching on the name alone would absorb every legitimate abort in the
    // process — a fetch timeout, a cancelled read — and turn the dev server
    // into something that hides bugs instead of surfacing them.
    const fault = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
      stack: "AbortError\n    at fetchWithTimeout (/x/src/server/http.ts:12:3)",
    });
    expect(isLivekitTeardownFault(fault)).toBe(false);
  });

  it("does not treat an ordinary crash as teardown noise", () => {
    expect(
      isLivekitTeardownFault(new TypeError("Cannot read properties of undefined")),
    ).toBe(false);
    expect(isLivekitTeardownFault("boom")).toBe(false);
    expect(isLivekitTeardownFault(undefined)).toBe(false);
  });
});
