import type { AgentLlmClient } from "../agent-session.js";
import type { AgentRunRequest } from "../llm/types.js";
import type { CallerBehaviour, ScenarioCaller, ScenarioTurn } from "./scenario.js";

/**
 * The simulated caller: one prompt with a fixed contract, on a small model. It answers the
 * agent's last reply toward its goal, one spoken line at a time, and it ends the call itself,
 * with a marker that says whether its goal was met and why. Who ended a call, and whether the
 * caller was done by then, is read from that marker and from `end_call`, never from the words
 * of a goodbye.
 */

/** Changes whenever the caller's prompt or its markers change, so results can be told apart. */
export const CALLER_PROMPT_VERSION = "3";

/** How long the caller or the judge may take for one answer. The host that sends their
 * requests holds each attempt to it (`host.ts`), so waiting for a rate limit is not
 * counted against it. */
export const ANSWER_TIMEOUT_MS = 60_000;

/** How the caller says it is done with the call: its goal met or not, and why. */
export type CallerEnd = {
  /** Whether the caller says its goal was met; null when its marker did not say. */
  goalMet: boolean | null;
  reason: string;
};

/** The caller's next line. `line` is empty when it hangs up without another word; `end` is set
 * when the line carries the caller's hang-up marker. */
export type CallerLine = { line: string; hangsUp: boolean; end: CallerEnd | null };

/** What the caller says about a call the agent ended: it was done (`end`), or it still wanted
 * something (`wanted`). Null when its answer said neither. */
export type CallerAfterHangUp = { done: true; end: CallerEnd } | { done: false; wanted: string } | null;

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

/**
 * Ask the caller, after the agent ended the call on a line of the caller's that carried no
 * hang-up marker, whether it was done. Its answer is one marker; anything else is null.
 */
export async function askCallerAfterHangUp(params: {
  llm: AgentLlmClient;
  caller: ScenarioCaller;
  language: string;
  turns: readonly ScenarioTurn[];
}): Promise<CallerAfterHangUp> {
  const view = [
    ...callerView(params.turns).slice(0, -2),
    "",
    "The agent has just ended the call. Answer with exactly one marker and nothing else:",
    "[hang up: met - <why>] if your goal was confirmed done and you wanted nothing more,",
    "[hang up: not met - <why>] if your goal was not reached and you had given up on it,",
    "[still wanted: <what>] if you still wanted something from this call.",
  ];
  const response = await params.llm(request("phone call", callerPrompt(params.caller, params.language), view));
  return parseCallerAfterHangUp(response.text);
}

/** One LLM request with no tools and no transcript: the whole task is in the context lines. */
export function request(title: string, systemPrompt: string, view: string[]): AgentRunRequest {
  return {
    systemPrompt,
    skillTitle: title,
    stateSnapshot: view,
    tools: [],
    messages: [],
  };
}

/** The one rule each behaviour adds to the caller's prompt. */
const BEHAVIOUR_RULES: Record<CallerBehaviour, string> = {
  everything_at_once: "In your first line, say everything you know that the agent could need, in one breath.",
  changes_mind:
    "Once, after the agent has taken a detail down, change your mind about something your goal leaves open (an option, a time of day), then stay with the new choice.",
  off_topic: "Once, drift off with a remark or a question that has nothing to do with your goal, then come back to it.",
  impatient: "You are in a hurry and say so. Push when the agent asks for more than one thing at a time or repeats itself.",
  asks_to_repeat: "Once, say you did not catch what the agent said and ask it to say it again.",
};

/**
 * The caller's prompt: who it is and what it wants, then the contract every simulated caller
 * holds to. It knows only the scenario's facts and never invents one, gives them as they are
 * needed, leaves the agent's job to the agent, and ends the call only once its goal is
 * confirmed done or clearly out of reach, with a marker that says which.
 */
export function callerPrompt(caller: ScenarioCaller, language: string): string {
  const behaviours = caller.behaviours ?? [];
  const disclosure = behaviours.includes("everything_at_once")
    ? "Answer what the agent just said or asked."
    : "Answer what the agent just said or asked. Give a detail when it is asked for or needed for your goal, never everything at once.";
  return [
    "You are the caller on a phone call with a company's voice agent. You are a person, not an assistant, and you stay in that role for the whole call.",
    "",
    `Your goal for this call: ${caller.goal}`,
    caller.knows?.trim()
      ? `Everything you know and can tell the agent: ${caller.knows.trim()}`
      : "You have no details beyond your goal.",
    ...(caller.persona?.trim() ? [`Who you are: ${caller.persona.trim()}`] : []),
    `You speak ${languageName(language)}.`,
    "",
    "How you talk:",
    "- One short line per turn, the way people talk on the phone: usually one sentence, at most two. No lists, no markdown, no stage directions.",
    `- ${disclosure}`,
    "- You know only what is written above. Never make up a name, a number, a date, an address or any other fact. Asked for something you were not given, say you do not have it.",
    "- Do not do the agent's job: do not tell it what to do next or how to behave, do not sum the call up for it, and never mention that this is a test.",
    ...behaviours.map((behaviour) => `- ${BEHAVIOUR_RULES[behaviour]}`),
    "",
    "How the call ends:",
    "- Stay on the call until the agent has confirmed that your goal is done, or it is clear that it cannot be done on this call. A promise to do it later is not a confirmation.",
    "- Then say a short goodbye and end that same line with a marker, which is not spoken: [hang up: met - <why>] when your goal was confirmed done, [hang up: not met - <why>] when it was not.",
    "- Never hang up in reply to a question of the agent's (\"shall I book it?\"): answer it first, and end the call on a later line.",
    "- If the agent has said goodbye and you have nothing left to say, answer with the marker alone.",
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

/** The caller's hang-up marker, with or without what it says about the goal. */
const HANG_UP = /\[\s*hang(?:s|ing)?[\s-]*up\s*(?:[:|,-]\s*([^\]]*))?\]/i;
const STILL_WANTED = /\[\s*still\s+want(?:ed|s)?\s*[:|,-]?\s*([^\]]*)\]/i;

/** What a hang-up marker's text says: "met - why", "not met - why", or nothing. */
function callerEnd(said: string | undefined): CallerEnd {
  const text = (said ?? "").trim();
  const verdict = /^(?:goal\s+)?(not\s+met|unmet|met)\b[\s:,.–—-]*(.*)$/is.exec(text);
  if (!verdict) return { goalMet: null, reason: text };
  return { goalMet: verdict[1]!.toLowerCase() === "met", reason: verdict[2]!.trim() };
}

/** The caller's answer as a line: no role prefix, no wrapping quotes, nothing after a line the
 * model wrote for the agent, and the hang-up marker taken out and read. */
export function parseCallerLine(text: string): CallerLine {
  const ownPart = text.split(/\n\s*agent\s*:/i)[0] ?? "";
  const marker = HANG_UP.exec(text);
  const line = ownPart
    .replace(HANG_UP, " ")
    .trim()
    .replace(/^(?:you|caller|me)\s*:\s*/i, "")
    .replace(/^["“„](.*)["”“]$/s, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return { line, hangsUp: marker !== null, end: marker ? callerEnd(marker[1]) : null };
}

/** The caller's answer to "the agent ended the call": the one marker it holds, or null. */
export function parseCallerAfterHangUp(text: string): CallerAfterHangUp {
  const wanted = STILL_WANTED.exec(text);
  if (wanted) return { done: false, wanted: wanted[1]!.trim() };
  const marker = HANG_UP.exec(text);
  return marker ? { done: true, end: callerEnd(marker[1]) } : null;
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
