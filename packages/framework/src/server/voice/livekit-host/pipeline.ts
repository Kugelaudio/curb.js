import type { voice } from "@livekit/agents";
import { CurbVoiceAgent } from "./curb-agent.js";

/** What LiveKit's `voice.AgentSession` is built with. */
export type VoiceSessionOptions = NonNullable<ConstructorParameters<typeof voice.AgentSession>[0]>;

/** One call's running session, as `VoicePipeline.onSession` receives it. */
export type VoicePipelineCall = {
  session: voice.AgentSession;
  roomName: string;
  /** `voice.AgentSessionEventTypes`, so `src/agent/` needs no runtime import from LiveKit. */
  events: typeof voice.AgentSessionEventTypes;
};

/**
 * A project's changes to the LiveKit pipeline: `defineAgent({ pipeline })`. They apply to every
 * call on every route, and the agent changes also to the agent a mid-call provider swap builds.
 */
export type VoicePipeline = {
  /** Edit the options the session is built with: turn handling, interruptions, providers. */
  session?: (defaults: VoiceSessionOptions) => VoiceSessionOptions;
  /** Subclass the agent to replace its `sttNode`, `llmNode` or `ttsNode`. */
  agent?: (Base: typeof CurbVoiceAgent) => typeof CurbVoiceAgent;
  /** Called once per call, before the session starts: subscribe to its events here. */
  onSession?: (call: VoicePipelineCall) => void;
};

export function voiceSessionOptions(
  defaults: VoiceSessionOptions,
  pipeline: VoicePipeline | undefined,
): VoiceSessionOptions {
  return pipeline?.session?.(defaults) ?? defaults;
}

export function voiceAgentClass(pipeline: VoicePipeline | undefined): typeof CurbVoiceAgent {
  return pipeline?.agent?.(CurbVoiceAgent) ?? CurbVoiceAgent;
}
