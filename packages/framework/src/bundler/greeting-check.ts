import type { tts } from "@livekit/agents";
import type { AgentSession } from "../agent-session.js";
import type { AgentFirstTurn } from "../config.js";
import type { TtsDescriptor } from "../providers.js";
import type { VoiceAgentBundle } from "../voice-host.js";

/**
 * The artifact's answer to "can this agent greet a caller": build the agent as a call does, run
 * its opening, and say it in the agent's own voice until the first audio frame arrives.
 *
 * A hosted platform runs it once after each activation, before it shows the version as live
 * (`CURB_READINESS_GREETING=1` beside `CURB_READINESS_PROBE=1`). The render check proves the bundle loads; it says nothing
 * about the model key being set or the voice answering, and a version that loads but cannot
 * speak is the failure callers meet as silence. Nothing joins a room and nothing is recorded:
 * the check is a conversation with no caller.
 *
 * What the check says is never printed: a greeting is the customer's content. What it prints
 * is which step failed and the provider's own error, which is the agent's to read in its logs.
 */

/** How long the whole check may take: the model's greeting and the voice's first frame. */
export const GREETING_CHECK_TIMEOUT_MS = 45_000;

export type GreetingCheckStep = "agent" | "greeting" | "voice";

export type GreetingCheckResult =
  | { ok: true; /** From the start of the greeting to the voice's first frame. */ firstAudioMs: number }
  | { ok: false; step: GreetingCheckStep; message: string };

export type GreetingCheckSeams = {
  /** The bundle a call takes: rejects when the agent's model has no key. */
  createBundle: () => Promise<VoiceAgentBundle>;
  /** The prompt a call opens with for `firstTurn: "agent"`. */
  firstTurnPrompt: () => Promise<string>;
  buildTts: (descriptor: TtsDescriptor) => Promise<tts.TTS>;
  now?: () => number;
  timeoutMs?: number;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What the agent says first on a call. A fixed line (`firstTurn: { say }`) needs no model; a
 * greeting the model writes (`firstTurn: "agent"`) and an agent the caller speaks to first both
 * run the opening prompt, so a missing or refused model key fails here and not on a caller.
 */
async function openingLine(
  session: AgentSession,
  firstTurn: AgentFirstTurn | undefined,
  prompt: () => Promise<string>,
): Promise<string> {
  if (firstTurn !== "agent") {
    const line = session.open();
    if (line !== null) return line;
  }
  let reply = "";
  for await (const event of session.runTurnStream(await prompt(), { spoken: true, kind: "synthetic" })) {
    if (event.type === "error" && event.error.kind !== "step_limit") throw new Error(event.error.message);
    if (event.type === "done") reply = event.reply;
  }
  if (!reply.trim()) throw new Error("the model answered the opening with no words to say");
  return reply;
}

/** Resolves when the voice delivers its first frame of `text`. */
async function firstFrame(voice: tts.TTS, text: string): Promise<void> {
  const stream = voice.synthesize(text);
  try {
    for await (const audio of stream) {
      if (audio.frame.data.length > 0) return;
    }
    throw new Error("the voice ended without audio");
  } finally {
    stream.close();
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no first audio within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function runGreetingCheck(seams: GreetingCheckSeams): Promise<GreetingCheckResult> {
  const now = seams.now ?? (() => performance.now());
  let step: GreetingCheckStep = "agent";
  let voice: tts.TTS | null = null;
  const run = async (): Promise<number> => {
    const bundle = await seams.createBundle();
    if (bundle.runtime.settings.s2s()) {
      // A speech-to-speech model greets in its own voice over a live connection; the bundle
      // above already refused a missing key for it, which is as far as a check with no room goes.
      return 0;
    }
    step = "greeting";
    const started = now();
    const line = await openingLine(bundle.session, bundle.definition.firstTurn, seams.firstTurnPrompt);
    step = "voice";
    voice = await seams.buildTts(bundle.runtime.settings.current().tts);
    await firstFrame(voice, line);
    return Math.round(now() - started);
  };
  try {
    const firstAudioMs = await withDeadline(run(), seams.timeoutMs ?? GREETING_CHECK_TIMEOUT_MS);
    return { ok: true, firstAudioMs };
  } catch (error) {
    return { ok: false, step, message: message(error) };
  } finally {
    await (voice as tts.TTS | null)?.close().catch(() => {
      // KEEP-JUSTIFIED: the check has its answer; a voice that fails to close has no one to tell.
    });
  }
}

/** The check against this artifact's own agent, for the generated entry. */
export async function runHostedGreetingCheck(): Promise<GreetingCheckResult> {
  const [{ createProbeAgentBundle }, { buildVoiceTts }] = await Promise.all([
    import("../voice-host.js"),
    import("../server/voice/providers.js"),
  ]);
  return runGreetingCheck({
    createBundle: () => createProbeAgentBundle(),
    firstTurnPrompt: async () =>
      (await import("../server/voice/livekit-host/call-opening.js")).AGENT_FIRST_TURN_PROMPT,
    buildTts: (descriptor) => buildVoiceTts({ descriptor }),
  });
}
