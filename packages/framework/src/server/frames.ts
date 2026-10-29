import type { AgentSession } from "../agent-session.js";
import type { DiscoveredAgent } from "../agent.node.js";
import { experimentDeclarations } from "../experiments.js";
import type { AgentSiteRuntime } from "../runtime.js";
import type { PreviewAgent, ServerMessage } from "./protocol.js";

/**
 * Pure mappers from runtime/session state to the server→client frames. Kept
 * free of any socket or IO so they can be unit-tested against the demo runtime
 * with a mock LLM.
 */

export function contextFrame(runtime: AgentSiteRuntime): Extract<ServerMessage, { type: "context" }> {
  const snapshot = runtime.snapshot();
  return {
    type: "context",
    context: snapshot.context,
    stateSnapshot: snapshot.stateSnapshot,
    agentContext: snapshot.agentContext,
    events: snapshot.events,
  };
}

/** A discovered agent as the preview shows it: its text and plain data, never a module. */
export function previewAgent(agent: DiscoveredAgent): PreviewAgent {
  const experiments = experimentDeclarations(agent.definition.experiments);
  return {
    id: agent.id,
    source: agent.source,
    preview: agent.definition.preview ?? {},
    skills: agent.routes.map((route) => ({
      path: route.path,
      ...(route.meta === undefined ? {} : { meta: route.meta }),
      source: route.source ?? "",
    })),
    ...(experiments.length === 0 ? {} : { experiments }),
  };
}

export function messagesFrame(session: AgentSession): Extract<ServerMessage, { type: "messages" }> {
  return { type: "messages", messages: session.messages };
}

export function llmTraceFrame(session: AgentSession): Extract<ServerMessage, { type: "llm_trace" }> {
  return { type: "llm_trace", calls: session.llmTrace };
}

export function runningFrame(session: AgentSession): Extract<ServerMessage, { type: "running" }> {
  return { type: "running", value: session.isRunning };
}

export function errorFrame(
  scope: Extract<ServerMessage, { type: "error" }>["scope"],
  message: string,
): Extract<ServerMessage, { type: "error" }> {
  return { type: "error", scope, message };
}
