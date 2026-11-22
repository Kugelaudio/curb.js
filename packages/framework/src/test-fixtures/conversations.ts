import type { AgentLlmClient } from "../agent-session.js";
import type { AgentRunRequest } from "../llm/types.js";
import type { ConversationRecord, SavedConversation, ScenarioRecord } from "../testing/record.js";
import type { ScenarioToolCall, ScenarioTurn } from "../testing/scenario.js";

/**
 * Test helpers for everything that reads a finished conversation: a turn and a conversation
 * record with plain defaults, and a judge LLM that answers from a table.
 */

export function turn(overrides: Partial<ScenarioTurn> & { turn: number }): ScenarioTurn {
  return {
    caller: `line ${overrides.turn}`,
    reply: "Sure.",
    fallback: null,
    confirmation: null,
    toolCalls: [],
    errors: [],
    contextDiff: [],
    skillPath: "",
    skipped: false,
    endedCall: false,
    steps: 1,
    ...overrides,
  };
}

export const ran = (name: string, input: Record<string, unknown> = {}, message?: string): ScenarioToolCall => ({
  name,
  input,
  ok: true,
  result: { ok: true, ...(message === undefined ? {} : { message }) },
});

export const refused = (name: string, message: string): ScenarioToolCall => ({
  name,
  input: {},
  ok: false,
  result: { ok: false, message },
});

/** A simulated conversation's record; `overrides.ending` is merged into a caller hang-up. */
export function record(
  turns: ScenarioTurn[],
  overrides: Partial<Omit<ScenarioRecord, "ending">> & { ending?: Partial<ScenarioRecord["ending"]> } = {},
): ScenarioRecord {
  const { ending, ...rest } = overrides;
  return {
    format: "curb.conversation",
    version: 1,
    source: "scenario",
    scenario: { name: "books", file: "src/agent/books.scenario.ts", mode: "simulated", run: 1 },
    caller: { goal: "Book a haircut", knows: "Name Alex Example, phone 0151 2345678" },
    experiments: {},
    startedAt: "2030-01-01T00:00:00.000Z",
    durationMs: 1000,
    turns,
    ending: { by: "caller", unsaid: [], maxTurns: 12, caller: { done: true, goalMet: true, reason: "booked" }, ...ending },
    endState: null,
    unusedFakes: [],
    usage: null,
    ...rest,
  };
}

/** A saved conversation with the outcome a test needs and nothing else assessed. */
export function saved(
  run: number,
  outcome: SavedConversation["assessment"]["outcome"],
  overrides: Partial<SavedConversation> = {},
): SavedConversation {
  const base = record([turn({ turn: 1 })]);
  return {
    ...base,
    scenario: { ...base.scenario, run },
    assessment: {
      outcome,
      ...(outcome === "error" ? { error: { kind: "provider" as const, message: "HTTP 529: overloaded" } } : {}),
      checks: [{ name: "the caller reaches its goal", pass: outcome === "pass" }],
      notes: [],
      judge: null,
    },
    ...overrides,
  };
}

export const isJudgeRequest = (request: AgentRunRequest) => request.systemPrompt.startsWith("You review");

type Answer = "yes" | "no" | "unknown" | { answer: "yes" | "no" | "unknown"; turn?: number; quote?: string; earlier_turn?: number; reason?: string };

/** What a judge answers to the questions `answers` names; every other question it was asked gets no. */
export function judgeAnswer(request: AgentRunRequest, answers: Record<string, Answer> = {}): string {
  const asked = [...request.systemPrompt.matchAll(/^- ([a-z_0-9]+): /gm)].map((match) => match[1]!);
  return JSON.stringify({
    answers: asked.map((id) => {
      const given = answers[id] ?? "no";
      return typeof given === "string" ? { id, answer: given, turn: null, quote: "", reason: `${id}: ${given}` } : { id, reason: `${id}: ${given.answer}`, ...given };
    }),
  });
}

/** A judge LLM: yes to the goal and no to everything else, unless `answers` says otherwise. */
export function judge(answers: Record<string, Answer> = {}): AgentLlmClient & { requests: AgentRunRequest[] } {
  const requests: AgentRunRequest[] = [];
  const llm: AgentLlmClient = async (request) => {
    requests.push(request);
    return { text: judgeAnswer(request, { goal: "yes", ...answers }), toolCalls: [] };
  };
  return Object.assign(llm, { requests });
}
