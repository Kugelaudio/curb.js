import { describe, expect, it } from "vitest";
import type { tts } from "@livekit/agents";
import type { VoiceAgentBundle } from "../voice-host.js";
import { runGreetingCheck, type GreetingCheckSeams } from "./greeting-check.js";

/**
 * The greeting check against a fake session and voice: which step fails, and that a pass means a
 * frame of audio arrived. The model and the voice are the parts a hermetic suite cannot own.
 */

type TurnEvent = { type: "error"; error: { kind: string; message: string } } | { type: "done"; reply: string };

function bundle(options: {
  firstTurn?: "agent" | { say: string };
  turn?: TurnEvent[];
  s2s?: boolean;
}): VoiceAgentBundle & { prompts: string[] } {
  const prompts: string[] = [];
  const session = {
    open: () => (options.firstTurn && options.firstTurn !== "agent" ? options.firstTurn.say : null),
    async *runTurnStream(text: string) {
      prompts.push(text);
      yield* options.turn ?? [{ type: "done", reply: "Hello, how can I help?" }];
    },
  };
  return {
    prompts,
    session,
    definition: { firstTurn: options.firstTurn },
    runtime: {
      settings: {
        s2s: () => (options.s2s ? { provider: "kugelaudio" } : null),
        current: () => ({ tts: { provider: "kugelaudio", options: {} } }),
      },
    },
  } as unknown as VoiceAgentBundle & { prompts: string[] };
}

function voice(frames: number[], spoken: string[] = []): tts.TTS {
  return {
    synthesize(text: string) {
      spoken.push(text);
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          for (const length of frames) yield { frame: { data: new Int16Array(length) } };
        },
      };
    },
    close: async () => {},
  } as unknown as tts.TTS;
}

const seams = (made: VoiceAgentBundle, tts: tts.TTS, extra: Partial<GreetingCheckSeams> = {}): GreetingCheckSeams => ({
  createBundle: async () => made,
  firstTurnPrompt: async () => "OPENING PROMPT",
  buildTts: async () => tts,
  ...extra,
});

describe("runGreetingCheck", () => {
  it("passes when the model's greeting reaches the voice's first frame", async () => {
    const spoken: string[] = [];
    const made = bundle({ firstTurn: "agent" });
    const result = await runGreetingCheck(seams(made, voice([0, 480], spoken)));
    expect(result.ok).toBe(true);
    expect(made.prompts).toEqual(["OPENING PROMPT"]);
    expect(spoken).toEqual(["Hello, how can I help?"]);
  });

  it("says a fixed opening line without a model call", async () => {
    const spoken: string[] = [];
    const made = bundle({ firstTurn: { say: "Praxis Doe, guten Tag." } });
    expect((await runGreetingCheck(seams(made, voice([480], spoken)))).ok).toBe(true);
    expect(made.prompts).toEqual([]);
    expect(spoken).toEqual(["Praxis Doe, guten Tag."]);
  });

  it("asks no greeting of an agent whose caller speaks first", async () => {
    const spoken: string[] = [];
    const made = bundle({});
    expect(await runGreetingCheck(seams(made, voice([], spoken)))).toEqual({ ok: true, callerSpeaksFirst: true });
    expect(made.prompts).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it("fails at the agent when the bundle refuses a missing model key", async () => {
    const result = await runGreetingCheck(
      seams(bundle({}), voice([480]), { createBundle: async () => Promise.reject(new Error("ANTHROPIC_API_KEY is not set")) }),
    );
    expect(result).toEqual({ ok: false, step: "agent", message: "ANTHROPIC_API_KEY is not set" });
  });

  it("fails at the greeting when the model's turn errors or says nothing", async () => {
    const errored = bundle({ firstTurn: "agent", turn: [{ type: "error", error: { kind: "failed", message: "401 invalid x-api-key" } }] });
    expect(await runGreetingCheck(seams(errored, voice([480])))).toEqual({
      ok: false, step: "greeting", message: "401 invalid x-api-key",
    });
    const silent = bundle({ firstTurn: "agent", turn: [{ type: "done", reply: "  " }] });
    expect(await runGreetingCheck(seams(silent, voice([480])))).toMatchObject({ ok: false, step: "greeting" });
  });

  it("fails at the voice when it ends without audio or cannot be built", async () => {
    expect(await runGreetingCheck(seams(bundle({ firstTurn: "agent" }), voice([0])))).toEqual({
      ok: false, step: "voice", message: "the voice ended without audio",
    });
    const unbuilt = seams(bundle({ firstTurn: "agent" }), voice([480]), {
      buildTts: async () => Promise.reject(new Error("CARTESIA_API_KEY is not set")),
    });
    expect(await runGreetingCheck(unbuilt)).toMatchObject({ ok: false, step: "voice" });
  });

  it("fails when no first audio arrives in time", async () => {
    const hung = { synthesize: () => ({ close() {}, [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }), close: async () => {} };
    const result = await runGreetingCheck(
      seams(bundle({ firstTurn: "agent" }), hung as unknown as tts.TTS, { timeoutMs: 20 }),
    );
    expect(result).toMatchObject({ ok: false, step: "voice", message: "no first audio within 20 ms" });
  });

  it("leaves a speech-to-speech agent to the key check, with no greeting", async () => {
    const made = bundle({ firstTurn: "agent", s2s: true });
    expect((await runGreetingCheck(seams(made, voice([])))).ok).toBe(true);
    expect(made.prompts).toEqual([]);
  });
});
