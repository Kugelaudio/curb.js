/**
 * `curb/orchestration`: server-only building blocks around the framework's voice session,
 * for scripts that drive an agent themselves (`createVoiceAgentBundle` and friends). The framework runs the voice session on every route and loads no
 * project orchestration code. Keep these out of the browser-facing `curb` entrypoint: they
 * depend on native LiveKit and Node.js modules.
 */

export { AutoSubscribe, defineAgent, llm, voice } from "@livekit/agents";
export * as silero from "@livekit/agents-plugin-silero";
export { RoomEvent } from "@livekit/rtc-node";
export type { AudioFrame } from "@livekit/rtc-node";
export type { AgentFirstTurn } from "./config.js";
export type { ProviderSettings, SessionSettings } from "./session-settings.js";
export type { AgentTurnStreamEvent } from "./llm/types.js";
export { createVoiceAgentBundle } from "./voice-host.js";
export type { VoiceAgentBundle } from "./voice-host.js";
export type { AgentSessionBundle } from "./server/connection.js";
export {
  buildVoiceProviders,
  buildVoiceStt,
  buildVoiceTts,
  describeMissingVoiceEnv,
  VoiceProviderError,
} from "./server/voice/providers.js";
export type {
  LoadModule as VoiceProviderModuleLoader,
  SttProviderId,
  TtsProviderId,
  VoiceProviders,
  VoiceProviderSettings,
} from "./server/voice/providers.js";
export { createProviderSwitch } from "./server/voice/livekit-host/provider-swap.js";
export type {
  ProviderSwitch,
  SwapAgentFactory,
  SwapSession,
} from "./server/voice/livekit-host/provider-swap.js";
export { ConversationClips } from "./server/voice/livekit-host/clip-store.js";
export { attachClientMessages } from "./server/voice/livekit-host/messages.js";
export type { ClientBridgeTarget, ClientMessageBridge } from "./server/voice/livekit-host/messages.js";
export { serveCall } from "./hosted/serve-call.js";
export type { ServedCall } from "./hosted/serve-call.js";
export { createEndCallHangup } from "./server/voice/end-call.js";
export type {
  EndCallHangup,
  EndCallHangupOptions,
  SpokenReply,
} from "./server/voice/end-call.js";
export type {
  VoiceOrchestrationModule,
  VoiceSessionHandle,
  VoiceSessionStartOptions,
} from "./server/voice/orchestration.js";
export { END_CALL_TOOL_NAME, SKIP_TURN_TOOL_NAME } from "./types.js";
