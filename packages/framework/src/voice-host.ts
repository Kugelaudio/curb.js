import type { AgentLlmClient, AgentLlmStreamStep } from "./agent-session.js";
import { AgentAuthoringError, type AuthoringDiagnostic } from "./authoring.js";
import {
  type AiSdkAgentOptions,
  assertLlmCredential,
  llmCredentialDiagnostic,
  missingLlmCredential,
  runAiSdkAgent,
  streamAiSdkAgent,
} from "./llm/ai-sdk.js";
import type { AgentSiteRuntime } from "./runtime.js";
import {
  createAgentSession,
  getHostedAgent,
  type HostedSession,
} from "./server/bootstrap.js";
import { Throttle, withRetries, withStreamRetries, type RetryOptions } from "./llm/resilience.js";
import { s2sCredentialDiagnostic } from "./s2s-diagnostics.js";
import { detachConversationRecorder } from "./server/conversation-store.js";
import { VOICE_STYLE } from "./voice-style.js";

/** A fresh curb runtime/session plus the authored definition. */
export type VoiceAgentBundle = HostedSession;

/**
 * Build the curb half of one voice conversation. The framework's voice host
 * supplies the LiveKit Agent/AgentSession; this factory supplies the React
 * runtime, LLM transport, tools, and transcript they drive.
 *
 * The LLM is whatever the rendered tree says at the moment of each turn
 * (`<Agent llm>`, the active `<Skill llm>`), so a changed prop applies to the next turn.
 *
 * Rejects with an `AgentAuthoringError` naming the variable when the LLM the session starts
 * on has no key in this process: such a session could only apologise on every turn.
 */
export async function createVoiceAgentBundle(agentId?: string, wrap?: LlmTransportWrap): Promise<VoiceAgentBundle> {
  return readyForCall(await buildBundle(agentId, wrap));
}

/** The two LLM transports a session runs on: one whole step, and one streamed step. */
export type LlmTransports = { llm: AgentLlmClient; streamLlm: AgentLlmStreamStep };

/** What the transports of a bundle are built with: who hears each request's tokens, and how
 * often the provider SDK retries by itself (see `AiSdkAgentOptions`). */
export type LlmTransportOptions = Pick<AiSdkAgentOptions, "onUsage" | "maxRetries">;

/**
 * What a host puts around a bundle's LLM transports (`curb test` waits out a rate limit and
 * counts tokens). `transports(options)` builds the pair on the conversation's effective llm;
 * the wrap returns the pair the session uses. With `llmTimeoutMs` it also says how long the
 * session waits for one request, when the wrap holds each attempt to a deadline of its own.
 */
export type LlmTransportWrap = (
  transports: (options?: LlmTransportOptions) => LlmTransports,
) => LlmTransports & { llmTimeoutMs?: number };

/**
 * How long one LLM request of a live call waits for its provider's rate limit to lift before the
 * turn fails. A caller is on the line, so this is seconds, not the minutes a test run waits: a
 * rate limit that names no pause is tried again after about 2, 4 and 8 seconds, and one that names
 * a longer pause than is left fails at once. The turn's own deadline (`AGENT_LLM_TIMEOUT_MS`) still
 * holds over all of it.
 */
export const LIVE_RATE_LIMIT_PATIENCE_MS = 15_000;

/**
 * The LLM transports of a live call (every bundle a host builds without a wrap of its own): a
 * request the provider rate limits is sent again after the pause it asks for, so a short burst of
 * 429s (several calls on one key, a speech model's back office asking at once) does not end a turn
 * in the fallback line. The provider SDK's own retries are off, since they do not wait out a rate
 * limit; other errors a retry can get past are tried as often as the SDK did. `retry` stands in for
 * the clock (a `throttle` on a clock of its own), the waiting and the dice in tests.
 */
export function liveTransportWrap(retry: Pick<RetryOptions, "sleep" | "random" | "throttle"> = {}): LlmTransportWrap {
  return (transports) => {
    const { llm, streamLlm } = transports({ maxRetries: 0 });
    // One call's requests share what the provider said about its limit.
    const options: RetryOptions = { throttle: new Throttle(), ...retry, attempts: 3, rateLimitPatienceMs: LIVE_RATE_LIMIT_PATIENCE_MS };
    return { llm: withRetries(llm, options), streamLlm: withStreamRetries(streamLlm, options) };
  };
}

/**
 * A hosted runner's warmup: the bundle without the LLM key check. The platform saves its
 * snapshot from a runner booted without secrets and hands the keys over with the call, so the
 * key is checked when a call takes the bundle ({@link readyForCall}), not here.
 */
export function createWarmAgentBundle(agentId?: string): Promise<VoiceAgentBundle> {
  return buildBundle(agentId);
}

/**
 * The platform's greeting check (`CURB_READINESS_PROBE=greeting`): the bundle a call takes, key
 * check included, recording nothing. The check is a conversation with no caller, so it leaves
 * no conversation behind.
 */
export async function createProbeAgentBundle(agentId?: string): Promise<VoiceAgentBundle> {
  return readyForCall(await buildBundle(agentId, undefined, { recordConversation: false }));
}

/** `bundle`, once its LLM has a key in this process; rejects naming the key otherwise. */
export async function readyForCall(bundle: VoiceAgentBundle): Promise<VoiceAgentBundle> {
  try {
    assertLlmCredential(bundle.runtime.settings.current().llm);
    const s2s = bundle.runtime.settings.s2s();
    const missingKey = s2s ? s2sCredentialDiagnostic(s2s, process.env) : null;
    if (missingKey) throw new AgentAuthoringError(missingKey);
  } catch (error) {
    // The session never starts: end the recording it was given before saying why.
    await detachConversationRecorder(bundle.session);
    throw error;
  }
  return bundle;
}

/**
 * `curb dev`'s preview only: the same bundle even when its LLM has no key in this process,
 * with the diagnostic naming that key. The page renders the agent's context from it (prompt,
 * skills, tools, which need no model) and shows the diagnostic as a banner, and sends it no
 * turn; the voice host refuses a call on it.
 */
export async function createPreviewAgentBundle(
  agentId?: string,
  options?: { recordConversation?: boolean },
): Promise<VoiceAgentBundle & { missingLlmKey: AuthoringDiagnostic | null }> {
  const bundle = await buildBundle(agentId, undefined, options);
  const s2s = bundle.runtime.settings.s2s();
  return {
    ...bundle,
    missingLlmKey:
      llmCredentialDiagnostic(bundle.runtime.settings.current().llm) ?? (s2s ? s2sCredentialDiagnostic(s2s, process.env) : null),
  };
}

async function buildBundle(
  agentId: string | undefined,
  wrap?: LlmTransportWrap,
  options?: { recordConversation?: boolean },
): Promise<VoiceAgentBundle> {
  const hosted = await getHostedAgent(agentId);
  // Bound once the session exists; no turn can run before that.
  let runtime: AgentSiteRuntime | null = null;
  const llm = () => {
    if (!runtime) throw new Error("curb: an LLM turn ran before its runtime was built.");
    return runtime.settings.current().llm;
  };
  const transports = (options: LlmTransportOptions = {}): LlmTransports => ({
    llm: (request) => runAiSdkAgent(request, { llm: llm(), ...options }),
    streamLlm: (request) => streamAiSdkAgent(request, { llm: llm(), ...options }),
  });
  const used: ReturnType<LlmTransportWrap> = (wrap ?? liveTransportWrap())(transports);
  const bundle = await createAgentSession(used.llm, used.streamLlm, hosted.id, {
    spokenStyleSuffix: VOICE_STYLE.join("\n"),
    llmTimeoutMs: used.llmTimeoutMs,
    // A spoken turn that says it is doing something a tool does gets one more step to call it.
    checkFollowThrough: true,
    recordConversation: options?.recordConversation,
  });
  runtime = bundle.runtime;
  // Outside settings changes may switch the LLM; one whose key this process lacks is refused.
  // Only `llm` can change a provider (a voice or language change keeps the props' provider).
  runtime.settings.setCredentialCheck((descriptor) =>
    descriptor.kind === "llm" ? missingLlmCredential(descriptor) : null,
  );
  return bundle;
}
