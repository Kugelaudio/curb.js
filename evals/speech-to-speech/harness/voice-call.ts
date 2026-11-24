/**
 * One voice call of an agent served by `curb server`, played the way the preview page plays it:
 * the conversation's WebSocket asks for a call (`voice_start`), and the local call's WebSocket
 * carries the caller's microphone (16 kHz PCM, paced in real time, silence between lines) and the
 * agent's voice back (24 kHz PCM), with the playout reports a page sends. Nothing in the agent's
 * call is stubbed: the speech model hears audio and speaks, and Curb runs its turns behind it.
 *
 * What it measures that a recording does not hold: what the model heard the caller say, and how
 * long the caller waited after their last word for the agent's first audible sound.
 */

import WebSocket from "ws";
import type { Caller, ScenarioTurn } from "curb/testing";
import { CALLER_SAMPLE_RATE, callerSpeech } from "./caller-voice.js";

const FRAME_MS = 20;
const FRAME_BYTES = (CALLER_SAMPLE_RATE / 1000) * FRAME_MS * 2;
const AGENT_SAMPLE_RATE = 24_000;
/** Peak below this (of 32767) is silence: a model may stream silent frames before it speaks. */
const AUDIBLE_PEAK = 600;
/** The agent is done answering once it was quiet this long and no turn of Curb's runs. */
const REPLY_QUIET_MS = 4_500;
/** A reply that has not started this long after the caller's line is no reply. */
const NO_REPLY_MS = 25_000;
/** How much of the agent's reply plays before an interrupting caller starts talking. */
const INTERRUPT_AFTER_MS = 1_200;

export type VoiceTurnTiming = {
  turn: number;
  /** The caller's line as sent, and as the model's transcript heard it (null: nothing heard). */
  said: string;
  heard: string | null;
  /** From the end of the caller's speech to the agent's first audible audio; null when it never spoke. */
  latencyMs: number | null;
  /** When Curb ran a turn behind the model: from the end of the caller's speech to the first audio
   * after that turn finished, the answer itself rather than a filler. Null when no turn ran. */
  answerMs: number | null;
  interrupted: boolean;
};

export type VoiceCallResult = {
  timings: VoiceTurnTiming[];
  /** Everything the agent said, in order, as its transcript streamed it. */
  agentLines: string[];
  /** The opening's latency from the call's start to its first audible audio. */
  openingMs: number | null;
  endedBy: "agent" | "caller" | "max_turns" | "error";
  error?: string;
  durationMs: number;
};

export type VoiceCallOptions = {
  port: number;
  language: string;
  caller: Caller;
  /** Caller turns (1-based) whose line starts while the agent is still speaking. */
  interrupt?: ReadonlySet<number>;
  maxTurns?: number;
  log?: (line: string) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function peakOf(pcm: Buffer): number {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  return peak;
}

export async function playVoiceCall(options: VoiceCallOptions): Promise<VoiceCallResult> {
  const log = options.log ?? (() => undefined);
  const maxTurns = options.maxTurns ?? 12;
  const started = Date.now();
  const control = new WebSocket(`ws://127.0.0.1:${options.port}/`);
  let running = false;
  let agentState = "listening";
  const runningStoppedAt: number[] = [];
  let callLive = false;
  let callEnded = false;
  let audio: WebSocket | null = null;

  // The agent's side as the page sees it.
  const agentLines: string[] = [];
  let agentText = "";
  let lastAudibleAt = 0;
  let firstAudibleSince: (since: number) => number | null = () => null;
  const audibleAt: number[] = [];
  let segmentStart = 0;
  let segmentMs = 0;
  const heardFinals: string[] = [];

  // The microphone: real-time 20 ms frames, speech when queued, else silence.
  let speech: Buffer | null = null;
  let speechOffset = 0;
  let speechDone: (() => void) | null = null;
  let micTimer: ReturnType<typeof setInterval> | null = null;
  let micFrames = 0;
  const micStart = () => {
    const t0 = Date.now();
    micTimer = setInterval(() => {
      const owed = Math.floor((Date.now() - t0) / FRAME_MS) - micFrames;
      for (let i = 0; i < owed; i += 1) {
        micFrames += 1;
        let frame = Buffer.alloc(FRAME_BYTES);
        if (speech) {
          speech.copy(frame, 0, speechOffset, Math.min(speechOffset + FRAME_BYTES, speech.length));
          speechOffset += FRAME_BYTES;
          if (speechOffset >= speech.length) {
            speech = null;
            const done = speechDone;
            speechDone = null;
            done?.();
          }
        }
        if (audio?.readyState === WebSocket.OPEN) audio.send(frame, { binary: true });
        frame = Buffer.alloc(0);
      }
    }, 10);
  };
  const speak = (pcm: Buffer) =>
    new Promise<number>((resolve) => {
      speech = pcm;
      speechOffset = 0;
      speechDone = () => resolve(Date.now());
    });

  const flushAgentText = () => {
    const text = agentText.trim();
    if (text) agentLines.push(text);
    agentText = "";
    return text;
  };

  firstAudibleSince = (since) => audibleAt.find((at) => at >= since) ?? null;

  const opened = new Promise<{ url: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no voice_session within 20 s")), 20_000);
    control.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type: string; value?: boolean; live?: boolean; url?: string; message?: string; scope?: string };
      if (process.env.EVAL_VOICE_DEBUG && frame.type !== "messages" && frame.type !== "context" && frame.type !== "llm_trace") log(`frame ${frame.type} ${JSON.stringify(frame).slice(0, 120)}`);
      if (frame.type === "running") {
        if (running && frame.value !== true) runningStoppedAt.push(Date.now());
        running = frame.value === true;
      }
      else if (frame.type === "voice_session") {
        if (frame.live && frame.url) {
          callLive = true;
          clearTimeout(timer);
          resolve({ url: frame.url });
        } else if (callLive) {
          callEnded = true;
          log("call ended by the agent");
        }
      } else if (frame.type === "error") {
        log(`server error (${frame.scope}): ${frame.message}`);
        if (!callLive) {
          clearTimeout(timer);
          reject(new Error(`${frame.scope}: ${frame.message}`));
        }
      } else if (frame.type === "missing_keys" || frame.type === "agent_unavailable") {
        clearTimeout(timer);
        reject(new Error(`${frame.type}: ${JSON.stringify(frame).slice(0, 400)}`));
      }
    });
    control.on("open", () => control.send(JSON.stringify({ type: "voice_start" })));
    control.on("error", (error) => reject(error));
  });

  const timings: VoiceTurnTiming[] = [];
  let endedBy: VoiceCallResult["endedBy"] = "caller";
  let error: string | undefined;
  let openingMs: number | null = null;
  try {
    const { url } = await opened;
    audio = new WebSocket(`ws://127.0.0.1:${options.port}${url}`);
    await new Promise<void>((resolve, reject) => {
      audio!.once("open", () => resolve());
      audio!.once("error", reject);
    });
    audio.on("message", (data, isBinary) => {
      if (isBinary) {
        const pcm = data as Buffer;
        const now = Date.now();
        if (segmentMs === 0) segmentStart = now;
        segmentMs += (pcm.length / 2 / AGENT_SAMPLE_RATE) * 1000;
        if (peakOf(pcm) >= AUDIBLE_PEAK) {
          // When this frame plays: the segment's start plus what came before it.
          const playsAt = Math.max(now, segmentStart + segmentMs - (pcm.length / 2 / AGENT_SAMPLE_RATE) * 1000);
          if (audibleAt.length === 0 || playsAt - audibleAt[audibleAt.length - 1]! > 200) audibleAt.push(playsAt);
          lastAudibleAt = Math.max(lastAudibleAt, segmentStart + segmentMs);
        }
        return;
      }
      const message = JSON.parse(data.toString()) as { type: string; text?: string; final?: boolean; state?: string };
      if (process.env.EVAL_VOICE_DEBUG && message.type !== "agent_text") log(`audio ${JSON.stringify(message).slice(0, 120)}`);
      if (message.type === "agent_state") agentState = message.state ?? agentState;
      if (message.type === "agent_text") agentText += message.text ?? "";
      else if (message.type === "agent_text_end") flushAgentText();
      else if (message.type === "caller_text" && message.final && message.text) heardFinals.push(message.text);
      else if (message.type === "audio_flush") {
        // Played to its end, in real time, as a page plays it.
        const playedMs = segmentMs;
        const wait = Math.max(0, segmentStart + segmentMs - Date.now());
        segmentMs = 0;
        setTimeout(() => audio?.readyState === WebSocket.OPEN && audio.send(JSON.stringify({ type: "playout_done", playedMs })), wait);
      } else if (message.type === "audio_clear") {
        const playedMs = Math.min(segmentMs, Math.max(0, Date.now() - segmentStart));
        lastAudibleAt = Math.min(lastAudibleAt, Date.now());
        segmentMs = 0;
        audio?.send(JSON.stringify({ type: "playout_cleared", playedMs }));
      }
    });
    audio.on("close", () => {
      callEnded = true;
    });
    micStart();

    /** Wait until the agent has answered and gone quiet (or the call ended). */
    const agentDone = async (since: number): Promise<void> => {
      const deadline = since + NO_REPLY_MS;
      while (!callEnded) {
        const now = Date.now();
        const spoke = firstAudibleSince(since) !== null;
        if (!spoke && now > deadline) return;
        if (spoke && !running && agentState !== "speaking" && now - Math.max(lastAudibleAt, since) >= REPLY_QUIET_MS) return;
        if (spoke && now - Math.max(lastAudibleAt, since) >= NO_REPLY_MS) return;
        await sleep(100);
      }
    };

    /** Wait until the agent's reply started and played `ms` (or the call ended, or no reply came). */
    const agentPlayed = async (since: number, ms: number): Promise<void> => {
      const deadline = since + NO_REPLY_MS;
      while (!callEnded && Date.now() < deadline) {
        const first = firstAudibleSince(since);
        if (first !== null && Date.now() - first >= ms) return;
        await sleep(50);
      }
    };

    // The opening: the agent speaks first, or the caller does.
    await agentDone(started);
    openingMs = firstAudibleSince(started) === null ? null : firstAudibleSince(started)! - started;
    flushAgentText();

    const turns: ScenarioTurn[] = [];
    if (agentLines.length > 0) turns.push(turnOf(0, null, agentLines.join(" ")));
    for (let number = 1; number <= maxTurns + 1; number += 1) {
      if (callEnded) {
        endedBy = "agent";
        break;
      }
      if (number > maxTurns) {
        endedBy = "max_turns";
        break;
      }
      const answer = await options.caller(turns, { language: options.language, hungUp: false });
      const line = typeof answer === "string" ? answer : answer?.line ?? null;
      if (line === null) {
        endedBy = "caller";
        break;
      }
      const spoken = line.replace(/\[hang up:[^\]]*\]/gi, "").trim();
      const interrupt = options.interrupt?.has(number) === true;
      const pcm = await callerSpeech(spoken || line, options.language);
      const linesBefore = agentLines.length;
      const finalsBefore = heardFinals.length;
      log(`caller ${number}: ${spoken}${interrupt ? " (talking over the agent)" : ""}`);
      const endedAt = await speak(pcm);
      // The next line talks over this reply: wait only until it has played a while.
      if (options.interrupt?.has(number + 1) === true) await agentPlayed(endedAt, INTERRUPT_AFTER_MS);
      else await agentDone(endedAt);
      flushAgentText();
      const first = firstAudibleSince(endedAt);
      const stopped = runningStoppedAt.filter((at) => at >= endedAt - 2_000).at(-1);
      const answerAt = stopped === undefined ? null : firstAudibleSince(stopped);
      const reply = agentLines.slice(linesBefore).join(" ");
      log(`agent  ${number}: ${reply}`);
      timings.push({
        turn: number,
        said: spoken,
        heard: heardFinals.slice(finalsBefore).join(" ") || null,
        latencyMs: first === null ? null : first - endedAt,
        answerMs: answerAt === null ? null : answerAt - endedAt,
        interrupted: interrupt,
      });
      turns.push(turnOf(number, spoken, reply));
      if (/\[hang up:/i.test(line)) {
        endedBy = "caller";
        break;
      }
    }
  } catch (caught) {
    endedBy = "error";
    error = caught instanceof Error ? caught.message : String(caught);
    log(`call failed: ${error}`);
  } finally {
    if (micTimer) clearInterval(micTimer);
    if (control.readyState === WebSocket.OPEN) {
      control.send(JSON.stringify({ type: "voice_stop" }));
      await sleep(1_000);
      control.close();
    }
    audio?.close();
  }
  return { timings, agentLines, openingMs, endedBy, ...(error ? { error } : {}), durationMs: Date.now() - started };
}

/** A turn as a caller reads it: the line, and the agent's words after it. */
function turnOf(turn: number, caller: string | null, reply: string): ScenarioTurn {
  return { turn, caller, reply, fallback: null, confirmation: null, toolCalls: [], errors: [], contextDiff: [], skillPath: "", skipped: false, endedCall: false, steps: 0 };
}
