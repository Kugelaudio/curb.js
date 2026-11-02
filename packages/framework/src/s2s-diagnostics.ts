/**
 * What `<Agent s2s>` asks of a project: the model's key, and no speech providers.
 *
 * The model hears and speaks by itself, so `stt` and `tts` beside it change nothing a caller
 * hears, which nothing shows until someone wonders why a voice setting does nothing.
 */

import { AUTHORING_DIAGNOSTIC_CODES, AgentAuthoringError, type AuthoringDiagnostic } from "./authoring.js";
import { OPENAI_API_KEY, type Env } from "./provider-keys.js";
import type { S2sDescriptor } from "./providers.js";
import { providerPropsFromTree } from "./session-settings.js";
import type { SemanticNode } from "./types.js";

/** Why no call can start on this model, or null when it can. */
export function s2sCredentialDiagnostic(descriptor: S2sDescriptor, env: Env): AuthoringDiagnostic | null {
  if (OPENAI_API_KEY.read(env)) return null;
  return {
    code: AUTHORING_DIAGNOSTIC_CODES.invalidProp,
    severity: "error",
    message: `The agent's s2s is ${descriptor.provider}, which needs ${OPENAI_API_KEY.name}, and this process does not have it. No session can start without it.`,
    location: { source: "src/agent/agent.tsx", component: "Agent" },
    fix: `Set ${OPENAI_API_KEY.name} in the project's .env (see .env.example). An empty value counts as unset.`,
  };
}

/** One warning for each place that sets `stt` or `tts` on an agent with `s2s`. */
export function diagnoseS2s(options: {
  agentId: string;
  /** The agent rendered with every skill loaded. */
  tree: SemanticNode;
  /** Every skill path; each is checked as the active skill. */
  skillPaths: readonly string[];
}): AuthoringDiagnostic[] {
  const { agentId, tree, skillPaths } = options;
  const atAgent = providerProps(tree, "");
  if (!atAgent?.s2s) return [];
  const finding = (component: string, location: Record<string, string>): AuthoringDiagnostic => ({
    code: AUTHORING_DIAGNOSTIC_CODES.s2sSpeechProviderIgnored,
    severity: "warning",
    message: `<${component}> sets stt or tts, but the agent's s2s model hears and speaks by itself, so a call uses neither.`,
    location: { agentId, component, ...location },
    fix: `Remove stt and tts from <${component}>.`,
  });
  const set = (props: ReturnType<typeof providerProps>) => [props?.stt, props?.tts].filter(Boolean).map((slot) => JSON.stringify(slot)).join();
  const agentSpeech = set(atAgent);
  return [
    ...(agentSpeech ? [finding("Agent", {})] : []),
    ...skillPaths.flatMap((path) => {
      const speech = set(providerProps(tree, path));
      return speech && speech !== agentSpeech ? [finding(`Skill path=${JSON.stringify(path)}`, { skillPath: path })] : [];
    }),
  ];
}

/** A refused provider prop has its own diagnostic (`diagnoseVoiceLanguage`). */
function providerProps(tree: SemanticNode, path: string) {
  try {
    return providerPropsFromTree(tree, path);
  } catch (error) {
    if (error instanceof AgentAuthoringError) return null;
    throw error;
  }
}
