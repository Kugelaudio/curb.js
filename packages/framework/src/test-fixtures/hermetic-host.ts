import type { AgentLlmClient, AgentLlmStreamStep, AgentRunRequest, AgentRunResponse } from "curb";
import { createVoiceAgentBundle } from "curb/orchestration";
import type { TestHost } from "curb/testing";

/**
 * A hermetic host built from public exports only: the fixture project's agent (AGENT_PROJECT_DIR
 * in vitest.config.ts) on the bundle path a call uses, with `agent` answering its LLM requests,
 * and `model` answering every request of a model to think with. Nothing leaves the machine. It
 * stands where a provider would: the harnesses that use it import nothing but `curb/testing`.
 */
export function hermeticHost(params: {
  agent: (request: AgentRunRequest) => AgentRunResponse;
  model?: (system: string, input: string) => string;
  /** The agent's model as reports name it. */
  label?: string;
}): TestHost {
  const llm: AgentLlmClient = async (request) => params.agent(request);
  const streamLlm: AgentLlmStreamStep = async function* (request) {
    const response = params.agent(request);
    if (response.text) yield { delta: response.text, text: response.text };
    for (const call of response.toolCalls) yield { type: "tool-input-start", toolName: call.name };
    return response;
  };
  return {
    async createBundle() {
      // The agent's provider wants a key before a call takes the agent; no request reaches it.
      process.env.KUGELAUDIO_API_KEY ||= "hermetic-key";
      const { runtime, session, definition } = await createVoiceAgentBundle(undefined, () => ({ llm, streamLlm }));
      return { runtime, session, firstTurn: definition.firstTurn };
    },
    simulator: () => async (request) => ({ text: params.model?.(request.systemPrompt, request.stateSnapshot.join("\n")) ?? "", toolCalls: [] }),
    models: () => ({ agent: params.label ?? "hermetic:agent", caller: "hermetic:model", judge: "hermetic:model" }),
  };
}

/** What the caller said last in a request of the agent's. */
export function lastCallerLine(request: AgentRunRequest): string {
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  return last?.role === "user" ? last.content : "";
}
