import type { AgentRunRequest, AgentRunResponse } from "../../llm/types.js";
import type { ToolDefinition } from "../../types.js";
import type { ConsultDecision } from "./warm-state.js";

/**
 * The model's reading of one reply in a warm transfer's consultation: a structured decision, so
 * nothing is read from the words themselves. The request carries the consultation so far and one
 * tool, {@link CONSULT_DECISION_TOOL}; the decision is that tool's `decision`, from a fixed enum.
 * A reply without a valid call of it reads as `unclear`, which `warm-state.ts` counts.
 */

export const CONSULT_DECISION_TOOL = "decide_transfer";

const DECISIONS: readonly ConsultDecision[] = ["yes", "no", "unclear", "voicemail"];

const TITLE = "warm transfer consultation";

const INSTRUCTION = [
  "You are on a phone call for an agent who wants to put a caller through to the person you called.",
  "You told the person who is calling and why, and asked whether they can take the call now.",
  `Read the consultation below and call ${CONSULT_DECISION_TOOL} once with what the person's latest reply means. Never answer with text.`,
  "decision:",
  "- yes: they agree to take the call now, in any words.",
  "- no: they cannot or will not take it now.",
  "- voicemail: a mailbox, an answering machine or a recorded announcement answered, not a person.",
  "- unclear: anything else, such as a greeting, a question or a reply you cannot place.",
  "say: the one short sentence you say to the person next, in the language they speak.",
  "- yes: that you are putting the caller through now.",
  "- no: thank them and say goodbye.",
  "- unclear: answer their question if they asked one, then ask again whether they can take the call now.",
  "- voicemail: leave it empty.",
].join("\n");

const DECISION_TOOL: ToolDefinition = {
  id: CONSULT_DECISION_TOOL,
  name: CONSULT_DECISION_TOOL,
  description: "Record what the person's latest reply means and what you say to them next.",
  scope: "runtime",
  inputSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: [...DECISIONS],
        description: "What the latest reply means.",
      },
      say: {
        type: "string",
        description: "The one sentence you say to the person next; empty for voicemail.",
      },
    },
    required: ["decision", "say"],
    additionalProperties: false,
  },
};

/** One line of the consultation: the agent's, or the person's at the transfer number. */
export type ConsultTurn = { speaker: "agent" | "target"; text: string };

/** What the model decided about the latest reply, and the line it says next, when it wrote one. */
export type ConsultReading = { decision: ConsultDecision; say?: string };

/** The request that reads the person's latest reply: the instruction, the consultation and the tool. */
export function consultDecisionRequest(turns: readonly ConsultTurn[]): AgentRunRequest {
  return {
    systemPrompt: INSTRUCTION,
    skillTitle: TITLE,
    stateSnapshot: turns.map((turn) => `${turn.speaker === "agent" ? "you" : "person"}: ${turn.text}`),
    tools: [DECISION_TOOL],
    messages: [],
  };
}

/** Whether `request` is the consultation's decision, for a transport that answers it differently
 * (a smaller model, a test double). */
export function isConsultDecisionRequest(request: AgentRunRequest): boolean {
  return request.skillTitle === TITLE && request.systemPrompt === INSTRUCTION;
}

/** The decision in the model's response, from its call of the tool; null when it made no valid call. */
export function readConsultDecision(response: AgentRunResponse): ConsultReading | null {
  for (const call of response.toolCalls) {
    if (call.name !== CONSULT_DECISION_TOOL || call.error !== undefined) continue;
    const decision = DECISIONS.find((known) => known === call.input.decision);
    if (decision === undefined) continue;
    const say = typeof call.input.say === "string" ? call.input.say.trim() : "";
    return say ? { decision, say } : { decision };
  }
  return null;
}
