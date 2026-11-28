import type { tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { describe, expect, it, vi } from "vitest";
import { AGENT_LANGUAGES, fallbackReplies } from "../../../llm/localized.js";
import { kugelaudio, openai } from "../../../providers.js";
import { TRANSFER_AUDIO_SAMPLE_RATE, type TransferAudioSink } from "../livekit-host/transfer-audio.js";
import { mulawToLinear, RECORDED_LINE_SAMPLE_RATE, recordedLine } from "./recorded-line.js";
import { fallbackVoices, recordedVoice, sayUnavailableLine, ttsVoice } from "./unavailable-line.js";

function fakeSink() {
  const sink = {
    captureFrame: vi.fn(async (_frame: AudioFrame) => {}),
    waitForPlayout: vi.fn(async () => true),
    clearQueue: vi.fn(),
    close: vi.fn(async () => {}),
  } satisfies TransferAudioSink;
  return sink;
}

/** A TTS engine that says each line as `frames` 48 kHz frames, or fails before any with `fails`. */
function engine({ frames = 2, fails }: { frames?: number; fails?: string } = {}) {
  const said: string[] = [];
  const close = vi.fn(async () => {});
  const synthesize = (text: string) => {
    said.push(text);
    const stream = (async function* () {
      if (fails) throw new Error(fails);
      for (let i = 0; i < frames; i += 1) yield { frame: { sampleRate: 48_000 } };
    })();
    return Object.assign(stream, { error: null, close: () => {} });
  };
  return { said, close, tts: { synthesize, close } as unknown as tts.TTS };
}

const voice = (name: string, made: ReturnType<typeof engine>) => ttsVoice(name, async () => made.tts, true);

describe("the line a caller hears when the model cannot take the call", () => {
  it("is said in the first voice, played to its end on the agent's track, and everything closed", async () => {
    const sink = fakeSink();
    const first = engine({ frames: 3 });
    const log = vi.fn();

    const played = await sayUnavailableLine({ line: "Please try again later.", voices: [voice("a", first)], publish: async () => sink, log });

    expect(played).toBe(true);
    expect(first.said).toEqual(["Please try again later."]);
    expect(sink.captureFrame).toHaveBeenCalledTimes(3);
    expect(sink.waitForPlayout).toHaveBeenCalledOnce();
    expect(sink.clearQueue).not.toHaveBeenCalled();
    expect(sink.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("a voice refused before its first audio hands over to the next, and the track is published once", async () => {
    const sink = fakeSink();
    const publish = vi.fn(async () => sink);
    const refused = engine({ fails: "HTTP 401: invalid key" });
    const next = engine();
    const log = vi.fn();

    const played = await sayUnavailableLine({ line: "x", voices: [voice("refused", refused), voice("next", next)], publish, log });

    expect(played).toBe(true);
    expect(next.said).toEqual(["x"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("refused could not tell the caller"));
    expect(refused.close).toHaveBeenCalledOnce();
  });

  it("with no voice that can say it, publishes nothing and reports it was not heard", async () => {
    const publish = vi.fn(async () => fakeSink());
    const log = vi.fn();
    const cannot = ttsVoice("no key", () => Promise.reject(new Error("needs KUGELAUDIO_API_KEY")), true);

    expect(await sayUnavailableLine({ line: "x", voices: [cannot], publish, log })).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith("no voice could tell the caller the call cannot go on");
  });

  it("a track that cannot be published is logged, not thrown, and the line was not heard", async () => {
    const log = vi.fn();
    const played = await sayUnavailableLine({ line: "x", voices: [voice("a", engine())], publish: () => Promise.reject(new Error("no room")), log });
    expect(played).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no room"));
  });

  it("a line the track did not play to its end was not heard", async () => {
    const sink = fakeSink();
    sink.waitForPlayout.mockResolvedValue(false);
    const log = vi.fn();
    const played = await sayUnavailableLine({ line: "x", voices: [voice("a", engine())], publish: async () => sink, log });
    expect(played).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith("the line to the caller did not play to its end");
    expect(sink.clearQueue).toHaveBeenCalled();
  });

  it("gives up at its deadline, so a stuck voice does not hold the call open", async () => {
    const sink = fakeSink();
    const log = vi.fn();
    sink.waitForPlayout.mockImplementation(() => new Promise(() => {}));

    const played = await sayUnavailableLine({ line: "x", voices: [voice("a", engine())], publish: async () => sink, log, timeoutMs: 20 });

    expect(played).toBe(false);
    expect(log).toHaveBeenCalledExactlyOnceWith("the line to the caller took too long, ending the call");
    expect(sink.clearQueue).toHaveBeenCalled();
    expect(sink.close).toHaveBeenCalledOnce();
  });
});

describe("the voices the line may be said in", () => {
  const live = openai.live();

  it("puts a TTS on the model's own key last, behind KugelAudio's voice and the recorded line", () => {
    const voices = fallbackVoices({ s2s: live, descriptor: openai.tts(), language: "de", env: { OPENAI_API_KEY: "sk-shared", KUGELAUDIO_API_KEY: "ka" } });
    expect(voices.map((v) => v.name)).toEqual(["the KugelAudio TTS", "the recorded line", "the agent's openai TTS"]);
  });

  it("keeps the agent's own voice first when its key is not the model's", () => {
    const voices = fallbackVoices({ s2s: live, descriptor: kugelaudio.tts(), language: "en", env: { OPENAI_API_KEY: "sk", KUGELAUDIO_API_KEY: "ka" } });
    expect(voices.map((v) => v.name)).toEqual(["the agent's kugelaudio TTS", "the recorded line"]);
  });

  it("compares the keys, not their names: a model key under another name is still the same key", () => {
    const voices = fallbackVoices({
      s2s: openai.live({ apiKeyEnv: "VOICE_KEY" }),
      descriptor: kugelaudio.tts(),
      language: "en",
      env: { VOICE_KEY: "same", KUGELAUDIO_API_KEY: "same" },
    });
    expect(voices.map((v) => v.name)).toEqual(["the recorded line", "the agent's kugelaudio TTS"]);
  });

  it("with only the model's key, says the recorded line before the TTS on that key", () => {
    const voices = fallbackVoices({ s2s: live, descriptor: openai.tts(), language: "en", env: { OPENAI_API_KEY: "sk" } });
    expect(voices.map((v) => v.name)).toEqual(["the recorded line", "the agent's openai TTS"]);
  });
});

describe("the recorded line, which needs no key", () => {
  it.each(AGENT_LANGUAGES)("in %s says the current refused line, a few seconds long", (language) => {
    // A failure here means a `refused` line changed: run scripts/render-recorded-lines.ts.
    const { line, samples } = recordedLine(language);
    expect(line).toBe(fallbackReplies(language).refused);
    expect(samples.length / RECORDED_LINE_SAMPLE_RATE).toBeGreaterThan(2);
    expect(samples.length / RECORDED_LINE_SAMPLE_RATE).toBeLessThan(9);
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(8000);
  });

  it("decodes G.711 mu-law", () => {
    expect([0xff, 0x80, 0x00, 0xf0, 0x70].map(mulawToLinear)).toEqual([0, 32124, -32124, 120, -120]);
  });

  it("plays at the call tracks' rate, all of it, and dials nothing", async () => {
    const sink = fakeSink();
    const line = fallbackReplies("de").refused;
    const played = await sayUnavailableLine({ line, voices: [recordedVoice("de")], publish: async () => sink, log: vi.fn() });
    expect(played).toBe(true);
    const frames = sink.captureFrame.mock.calls.map(([frame]) => frame);
    expect(new Set(frames.map((frame) => frame.sampleRate))).toEqual(new Set([TRANSFER_AUDIO_SAMPLE_RATE]));
    const seconds = frames.reduce((total, frame) => total + frame.samplesPerChannel, 0) / TRANSFER_AUDIO_SAMPLE_RATE;
    expect(seconds).toBeCloseTo(recordedLine("de").samples.length / RECORDED_LINE_SAMPLE_RATE, 1);
  });

  it("does not stand in for other words, and hands over to the next voice", async () => {
    const next = engine();
    const log = vi.fn();
    const played = await sayUnavailableLine({ line: "Something else.", voices: [recordedVoice("en"), voice("next", next)], publish: async () => fakeSink(), log });
    expect(played).toBe(true);
    expect(next.said).toEqual(["Something else."]);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("the recorded line could not tell the caller"));
  });
});
