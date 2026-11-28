import type { tts } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { kugelaudio, openai } from "../../../providers.js";
import type { TransferAudioSink } from "../livekit-host/transfer-audio.js";
import { fallbackVoices, sayUnavailableLine, type FallbackVoice } from "./unavailable-line.js";

function fakeSink() {
  const sink = {
    captureFrame: vi.fn(async () => {}),
    waitForPlayout: vi.fn(async () => {}),
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

const voice = (name: string, made: ReturnType<typeof engine>): FallbackVoice => ({ name, open: async () => made.tts, owned: true });

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
    const cannot: FallbackVoice = { name: "no key", open: () => Promise.reject(new Error("needs KUGELAUDIO_API_KEY")), owned: true };

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

  it("puts a TTS on the model's own key last, behind KugelAudio's voice for the agent's language", () => {
    const voices = fallbackVoices({ s2s: live, descriptor: openai.tts(), language: "de", env: { OPENAI_API_KEY: "sk-shared", KUGELAUDIO_API_KEY: "ka" } });
    expect(voices.map((v) => v.name)).toEqual(["the KugelAudio TTS", "the agent's openai TTS"]);
  });

  it("keeps the agent's own voice first when its key is not the model's", () => {
    const voices = fallbackVoices({ s2s: live, descriptor: kugelaudio.tts(), language: "en", env: { OPENAI_API_KEY: "sk", KUGELAUDIO_API_KEY: "ka" } });
    expect(voices.map((v) => v.name)).toEqual(["the agent's kugelaudio TTS"]);
  });

  it("compares the keys, not their names: a model key under another name is still the same key", () => {
    const voices = fallbackVoices({
      s2s: openai.live({ apiKeyEnv: "VOICE_KEY" }),
      descriptor: kugelaudio.tts(),
      language: "en",
      env: { VOICE_KEY: "same", KUGELAUDIO_API_KEY: "same" },
    });
    expect(voices.map((v) => v.name)).toEqual(["the agent's kugelaudio TTS"]);
  });

  it("has no KugelAudio voice to add without its key", () => {
    const voices = fallbackVoices({ s2s: live, descriptor: openai.tts(), language: "en", env: { OPENAI_API_KEY: "sk" } });
    expect(voices.map((v) => v.name)).toEqual(["the agent's openai TTS"]);
  });
});
