import type { AudioFrame } from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";
import type { TransferAudioSink } from "../livekit-host/transfer-audio.js";
import { sayUnavailableLine } from "./unavailable-line.js";

const frame = {} as AudioFrame;

function fakeSink() {
  const frames: AudioFrame[] = [];
  const sink = {
    captureFrame: vi.fn(async (next: AudioFrame) => void frames.push(next)),
    waitForPlayout: vi.fn(async () => {}),
    clearQueue: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies TransferAudioSink;
  return { sink, frames };
}

async function* spoken(count: number) {
  for (let i = 0; i < count; i += 1) yield frame;
}

describe("the line a caller hears when the model cannot take the call", () => {
  it("is synthesized, played to its end on the agent's track, and the track closed", async () => {
    const { sink, frames } = fakeSink();
    const synthesize = vi.fn(() => spoken(3));
    const log = vi.fn();

    await sayUnavailableLine({ line: "Please try again later.", publish: async () => sink, synthesize, log });

    expect(synthesize).toHaveBeenCalledExactlyOnceWith("Please try again later.");
    expect(frames).toHaveLength(3);
    expect(sink.waitForPlayout).toHaveBeenCalledOnce();
    expect(sink.close).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("a voice that fails is logged, not thrown, and the track still closes", async () => {
    const { sink } = fakeSink();
    const log = vi.fn();
    const synthesize = async function* (): AsyncGenerator<AudioFrame> {
      throw new Error("TTS refused: 402");
    };

    await sayUnavailableLine({ line: "x", publish: async () => sink, synthesize, log });

    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("TTS refused: 402"));
    expect(sink.close).toHaveBeenCalledOnce();
  });

  it("a track that cannot be published is logged, not thrown", async () => {
    const log = vi.fn();
    await sayUnavailableLine({ line: "x", publish: () => Promise.reject(new Error("no room")), synthesize: () => spoken(1), log });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no room"));
  });

  it("gives up at its deadline, so a stuck voice does not hold the call open", async () => {
    const { sink } = fakeSink();
    const log = vi.fn();
    sink.waitForPlayout.mockImplementation(() => new Promise(() => {}));

    await sayUnavailableLine({ line: "x", publish: async () => sink, synthesize: () => spoken(1), log, timeoutMs: 20 });

    expect(log).toHaveBeenCalledExactlyOnceWith("the line to the caller took too long, ending the call");
    expect(sink.clearQueue).toHaveBeenCalled();
    expect(sink.close).toHaveBeenCalledOnce();
  });
});
