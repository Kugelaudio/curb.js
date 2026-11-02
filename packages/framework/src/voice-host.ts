import { AgentAuthoringError, type AuthoringDiagnostic } from "./authoring.js";
import {
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
export async function createVoiceAgentBundle(agentId?: string): Promise<VoiceAgentBundle> {
  return readyForCall(await buildBundle(agentId));
}

/**
 * A hosted runner's warmup: the bundle without the LLM key check. The platform saves its
 * snapshot from a runner booted without secrets and hands the keys over with the call, so the
 * key is checked when a call takes the bundle ({@link readyForCall}), not here.
 */
export function createWarmAgentBundle(agentId?: string): Promise<VoiceAgentBundle> {
  return buildBundle(agentId);
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
): Promise<VoiceAgentBundle & { missingLlmKey: AuthoringDiagnostic | null }> {
  const bundle = await buildBundle(agentId);
  const s2s = bundle.runtime.settings.s2s();
  return {
    ...bundle,
    missingLlmKey:
      llmCredentialDiagnostic(bundle.runtime.settings.current().llm) ?? (s2s ? s2sCredentialDiagnostic(s2s, process.env) : null),
  };
}

async function buildBundle(agentId: string | undefined): Promise<VoiceAgentBundle> {
  const hosted = await getHostedAgent(agentId);
  // Bound once the session exists; no turn can run before that.
  let runtime: AgentSiteRuntime | null = null;
  const llm = () => {
    if (!runtime) throw new Error("curb: an LLM turn ran before its runtime was built.");
    return runtime.settings.current().llm;
  };
  const bundle = await createAgentSession(
    (request) => runAiSdkAgent(request, { llm: llm() }),
    (request) => streamAiSdkAgent(request, { llm: llm() }),
    hosted.id,
    { spokenStyleSuffix: VOICE_STYLE.join("\n") },
  );
  runtime = bundle.runtime;
  // Outside settings changes may switch the LLM; one whose key this process lacks is refused.
  // Only `llm` can change a provider (a voice or language change keeps the props' provider).
  runtime.settings.setCredentialCheck((descriptor) =>
    descriptor.kind === "llm" ? missingLlmCredential(descriptor) : null,
  );
  return bundle;
}
