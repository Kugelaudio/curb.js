import type { AgentLlmClient } from "../agent-session.js";
import type { AgentRunRequest } from "../llm/types.js";
import type { ScenarioEndedBy } from "./checks.js";
import type { ScenarioCaller, ScenarioTurn } from "./scenario.js";

/**
 * The simulated caller and the judge: two small prompts on the agent's own LLM provider. The
 * caller answers the agent's last reply toward its goal, one spoken line at a time; the judge
 * reads the finished call once and says whether the goal was reached, and why.
 */

/** How long the caller or the judge may take for one answer. */
const ANSWER_TIMEOUT_MS = 60_000;

/** What the caller answers instead of a line once the call is over for it. */
export const HANG_UP = "[hang up]";

/** The caller's next line. `line` is empty when it hangs up without another word. */
export type CallerLine = { line: string; hangsUp: boolean };

/** The judge's verdict on the caller's goal. */
export type GoalVerdict = { reached: boolean; reason: string };

/** Ask the simulated caller for its next line. Throws when it gives neither a line nor a hang-up. */
export async function nextCallerLine(params: {
  llm: AgentLlmClient;
  caller: ScenarioCaller;
  /** The language the caller speaks (BCP 47). */
  language: string;
  turns: readonly ScenarioTurn[];
}): Promise<CallerLine> {
  const response = await params.llm(
    request("phone call", callerPrompt(params.caller, params.language), callerView(params.turns)),
  );
  const answer = parseCallerLine(response.text);
  if (!answer.line && !answer.hangsUp) {
    throw new Error(`the simulated caller answered with no line: ${JSON.stringify(response.text.slice(0, 200))}`);
  }
  return answer;
}

/** Ask the judge whether the caller reached its goal. Throws when its answer cannot be read. */
export async function judgeGoal(params: {
  llm: AgentLlmClient;
  caller: ScenarioCaller;
  turns: readonly ScenarioTurn[];
  endedBy: ScenarioEndedBy;
}): Promise<GoalVerdict> {
  const response = await params.llm(
    request("call review", judgePrompt(params.caller.goal), judgeView(params.caller, params.turns, params.endedBy)),
  );
  const verdict = parseVerdict(response.text);
  if (!verdict) throw new Error(`the judge's answer could not be read: ${JSON.stringify(response.text.slice(0, 200))}`);
  return verdict;
}

/** One LLM request with no tools and no transcript: the whole task is in the context lines. */
function request(title: string, systemPrompt: string, view: string[]): AgentRunRequest {
  return {
    systemPrompt,
    skillTitle: title,
    stateSnapshot: view,
    tools: [],
    messages: [],
    signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
  };
}

export function callerPrompt(caller: ScenarioCaller, language: string): string {
  return [
    "You are the caller on a phone call with a company's voice agent. You are a person, not an assistant, and you stay in that role for the whole call.",
    "",
    `Your goal for this call: ${caller.goal}`,
    caller.knows?.trim()
      ? `What you know and can tell the agent when it asks: ${caller.knows.trim()}`
      : "You have no details beyond your goal. If the agent asks for one, say you do not have it at hand.",
    `You speak ${languageName(language)}.`,
    "",
    "How you talk:",
    "- One short line per turn, the way people talk on the phone: usually one sentence, at most two. No lists, no markdown, no stage directions.",
    "- Answer what the agent just said or asked. Give a detail when it is asked for or needed for your goal, not everything at once.",
    "- Never make up facts you were not given. If you are asked for something you do not know, say so.",
    "- Do not do the agent's job for it, do not tell it how to behave, and never mention that this is a test.",
    "- When your goal is reached, or the agent clearly cannot help, say a short goodbye.",
    `- Once the call is over for you and the goodbyes are said, answer with exactly ${HANG_UP} instead of a line.`,
  ].join("\n");
}

/** The call as the caller heard it: the agent's words and its own lines, never tool calls. */
function callerView(turns: readonly ScenarioTurn[]): string[] {
  const heard = turns.flatMap((turn) => [
    ...(turn.caller === null ? [] : [`You: ${turn.caller}`]),
    `Agent: ${turn.reply || "(silence)"}`,
  ]);
  if (heard.length === 0) return ["The call has just connected and the agent waits for you to speak.", "", "Your first line:"];
  return ["The call so far:", ...heard, "", "Your next line:"];
}

export function judgePrompt(goal: string): string {
  return [
    "You review a recorded phone call between a caller and a company's voice agent.",
    `Decide whether the caller reached this goal by the end of the call: ${goal}`,
    "Reached means what the goal asks for happened during the call: the agent did it, or confirmed it was done (a successful tool call counts). A goal that was only discussed, promised for later, or still open when the call ended is not reached.",
    "Judge only from the transcript.",
    "Answer with one line: PASS: <one sentence why> when the goal was reached, otherwise FAIL: <one sentence why>.",
  ].join("\n");
}

/** Longest tool input the judge is shown, in characters. */
const MAX_JUDGED_INPUT = 300;

function judgeView(caller: ScenarioCaller, turns: readonly ScenarioTurn[], endedBy: ScenarioEndedBy): string[] {
  const lines = turns.flatMap((turn) => [
    ...(turn.caller === null ? [] : [`Caller: ${turn.caller}`]),
    ...turn.toolCalls.map((call) => {
      const input = JSON.stringify(call.input);
      const shown = input.length > MAX_JUDGED_INPUT ? `${input.slice(0, MAX_JUDGED_INPUT)}…` : input;
      const status = call.ok ? "ok" : call.heldFor !== undefined ? "held for the caller's yes, not run" : "refused";
      return `(The agent called the tool ${call.name}: ${status}. Input: ${shown})`;
    }),
    `Agent: ${turn.reply || "(silence)"}`,
  ]);
  return [
    `The caller's goal: ${caller.goal}`,
    ...(caller.knows?.trim() ? [`What the caller could tell the agent: ${caller.knows.trim()}`] : []),
    "",
    "Transcript:",
    ...lines,
    `(${ENDINGS[endedBy]})`,
  ];
}

const ENDINGS: Record<ScenarioEndedBy, string> = {
  agent: "The agent ended the call.",
  caller: "The caller hung up.",
  script: "The caller had nothing more to say.",
  max_turns: "The call was cut off at its turn limit.",
  error: "The call broke off on an error.",
  simulator: "The call broke off.",
};

/** The caller's answer as a line: no role prefix, no wrapping quotes, nothing after a line the
 * model wrote for the agent, and the hang-up marker taken out. */
export function parseCallerLine(text: string): CallerLine {
  const hangUp = /\[\s*hang(?:s|ing)?[\s-]*up\s*\]/i;
  const ownPart = text.split(/\n\s*agent\s*:/i)[0] ?? "";
  const line = ownPart
    .replace(hangUp, " ")
    .trim()
    .replace(/^(?:you|caller|me)\s*:\s*/i, "")
    .replace(/^["“„](.*)["”“]$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return { line, hangsUp: hangUp.test(text) };
}

/** The first line that starts with PASS or FAIL (in capitals, as asked), with its reason; null
 * when no line does. A reason on the line after the verdict counts too. */
export function parseVerdict(text: string): GoalVerdict | null {
  const lines = text.split("\n").map((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    const match = /^[\s*_#>`-]*(PASS|FAIL)\b[\s*_`]*[:\-–—]?\s*(.*)$/.exec(line);
    if (!match) continue;
    const reason = match[2]!.trim() || lines.slice(index + 1).find(Boolean) || "(the judge gave no reason)";
    return { reached: match[1] === "PASS", reason };
  }
  return null;
}

/** "German" for "de"; the code itself when the runtime does not know the language. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    // KEEP-JUSTIFIED: scenario() already refused malformed codes; an unnamed one stays a code.
    return code;
  }
}
