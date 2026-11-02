/**
 * What differs between speech-to-speech models: the one place that knows a provider or protocol.
 *
 * Every model gets the same call (`call.ts`) and hands work over in the way its protocol has. OpenAI
 * Live delegates, by itself, to the client. Realtime has no such thing, so it gets one tool, whose
 * call is the same handover: the model still picks no tool of the agent's and fills no arguments.
 */

import { llm } from "@livekit/agents";
import { GPTLiveModel, type GPTLiveSession } from "@livekit/agents/llm/openai_realtime/gpt_live_model";
import { RealtimeModel } from "@livekit/agents/llm/openai_realtime/realtime_model";
import { z } from "zod";
import { OPENAI_API_KEY, type Env } from "../../../provider-keys.js";
import type { S2sDescriptor } from "../../../providers.js";
import type { VoiceBackChannel } from "./back-office.js";

/** What a model tells the call, and what the call gives it. */
export type S2sHooks = {
  delegated: (id: string, words: string) => void;
  asked: (request: string) => Promise<string>;
  /** Have the model speak now, from these instructions. */
  say: (instructions: string) => void;
  /** The model keeps dropping the call: end it. */
  lost: () => void;
};

export type S2sVoice = {
  model: GPTLiveModel | RealtimeModel;
  tools: llm.ToolContext | undefined;
  /** Curb's way to tell the model something it did not ask for. */
  channel: () => VoiceBackChannel | null;
};

/** Reconnects a call survives within `RECONNECT_WINDOW_MS`. */
const MAX_RECONNECTS = 3;
const RECONNECT_WINDOW_MS = 60_000;

function endpoint(descriptor: S2sDescriptor, env: Env): { apiKey: string; baseURL?: string } {
  const apiKey = OPENAI_API_KEY.read(env);
  if (!apiKey) throw new Error(`curb: <Agent s2s> on ${descriptor.provider} has no key: run curb check.`);
  const { baseURL } = descriptor.options;
  return { apiKey, ...(baseURL ? { baseURL } : {}) };
}

export function s2sVoice(descriptor: S2sDescriptor, env: Env, hooks: S2sHooks): S2sVoice {
  const connection = endpoint(descriptor, env);
  const { model, voice } = descriptor.options;
  const named = { ...(model ? { model } : {}), ...(voice ? { voice } : {}) };

  if (descriptor.protocol === "realtime") {
    const tools = new llm.ToolContext({
      ask_back_office: llm.tool({
        description: "Hand over anything that needs the back office, and the end of the call when the caller is finished. It answers with what to tell the caller.",
        parameters: z.object({ request: z.string().describe("What the caller wants.") }),
        execute: ({ request }) => hooks.asked(request),
      }),
    });
    return {
      model: new RealtimeModel({ ...connection, ...named }),
      tools,
      channel: () => ({ appendCommentary: (text) => hooks.say(`Tell the caller, in your own words: ${text}`) }),
    };
  }

  let live: GPTLiveSession | null = null;
  const attach = (session: GPTLiveSession) => {
    live = session;
    session.on("delegation_created", ({ id, pendingTranscript }) => hooks.delegated(id, pendingTranscript));
    // LiveKit clears its retries whenever a session starts, so a session that starts and fails
    // reconnects with no limit and no backoff while the caller hears nothing.
    const reconnects: number[] = [];
    session.on("session_reconnected", () => {
      const now = Date.now();
      reconnects.push(now);
      if (reconnects.filter((at) => now - at < RECONNECT_WINDOW_MS).length > MAX_RECONNECTS) hooks.lost();
    });
  };
  class AttachedLiveModel extends GPTLiveModel {
    override session(): GPTLiveSession {
      const session = super.session();
      attach(session);
      return session;
    }
  }
  return {
    model: new AttachedLiveModel({ ...connection, ...named, delegation: "client" }),
    tools: undefined,
    channel: () => live,
  };
}
