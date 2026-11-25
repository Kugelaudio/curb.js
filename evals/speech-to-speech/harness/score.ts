/**
 * How one conversation did against its case, from the turns alone, so a text conversation and a
 * recorded voice call are scored by the same code.
 */

import type { ScenarioCheck, ScenarioToolCall, ScenarioTurn } from "curb/testing";
import { FRAMEWORK_TOOLS, argErrors, argsMatch, type EvalCaseSpec } from "./spec.js";

export type EvalPath = "text" | "voice";

export type CaseScore = {
  agent: string;
  case: string;
  kind: EvalCaseSpec["kind"];
  language: string;
  path: EvalPath;
  run: number;
  /** The conversation could not be scored (a provider error, a call that never connected). */
  error: string | null;
  /** Skills in the order they were read. */
  read: string[];
  /** The first skill read is the one the request needs; null when the case needs none. */
  skillFound: boolean | null;
  /** Every skill of the path was read, and none the call did not need; null when the case has no path. */
  navigationOk: boolean | null;
  /** Business tool names: expected and called (true positive), called and not expected, expected and not called. */
  tp: string[];
  fp: string[];
  fn: string[];
  /** Expected tools that were called, but never with the arguments the case names. */
  argErrors: string[];
  /** Tools the case forbids that ran. */
  forbiddenRan: string[];
  /** Every expected tool ran with its arguments, no other business tool was called, nothing forbidden ran. */
  toolsOk: boolean;
  /** Caller turns the conversation took. */
  callerTurns: number;
  /** Per caller turn: from the caller's line to the agent's reply (text: the turn's duration;
   * voice: end of the caller's speech to the agent's first audible audio). */
  latenciesMs: number[];
  /** Voice only: per caller turn on which Curb ran a turn, from the end of the caller's speech to
   * the answer (the first audio after that turn finished). */
  answerMs?: number[];
  /** Voice only: per caller turn, what was said and what the model's transcript heard. */
  heard?: Array<{ said: string; heard: string | null }>;
  transcript: string;
};

/** Whether a call ran: it was not refused and not left waiting for a yes. */
const ran = (call: ScenarioToolCall) => call.ok || (call.result !== null && call.heldFor === undefined);

export function scoreTurns(
  spec: EvalCaseSpec,
  turns: readonly ScenarioTurn[],
  meta: { agent: string; language: string; path: EvalPath; run: number; latenciesMs: number[]; answerMs?: number[]; callerTurns?: number; heard?: CaseScore["heard"]; error?: string | null },
): CaseScore {
  const calls = turns.flatMap((turn) => turn.toolCalls);
  const read = calls.filter((call) => call.name === "read_skill").map((call) => String(call.input.skill ?? ""));
  const business = calls.filter((call) => !FRAMEWORK_TOOLS.has(call.name));
  const called = [...new Set(business.map((call) => call.name))];
  const expected = [...new Set(spec.tools.map((tool) => tool.tool))];
  const tp = expected.filter((tool) => called.includes(tool));
  const fp = called.filter((tool) => !expected.includes(tool) && !(spec.allowed ?? []).includes(tool));
  const fn = expected.filter((tool) => !called.includes(tool));
  const wrongArgs = spec.tools.flatMap((want) => {
    const of = business.filter((call) => call.name === want.tool);
    if (of.length === 0 || of.some((call) => argsMatch(call.input, want.args))) return [];
    const closest = of[of.length - 1]!;
    return [`${want.tool} ${argErrors(closest.input, want.args).join("; ")}`];
  });
  const forbiddenRan = (spec.forbidden ?? []).filter((tool) => business.some((call) => call.name === tool && ran(call)));
  // Navigation is scored on cases that move between skills: every skill of the path reached, and
  // no detour into a skill the call did not need. Which skill came first is `skillFound`.
  const path = spec.path ?? [];
  const avoid = spec.avoidSkills ?? [];
  const needed = new Set([...path, ...(spec.firstSkill ? [spec.firstSkill] : [])]);
  return {
    agent: meta.agent,
    case: spec.name,
    kind: spec.kind,
    language: meta.language,
    path: meta.path,
    run: meta.run,
    error: meta.error ?? null,
    read,
    skillFound: spec.firstSkill === null ? null : read[0] === spec.firstSkill,
    navigationOk:
      path.length === 0 && avoid.length === 0
        ? null
        : path.every((skill) => read.includes(skill)) && !read.some((skill) => avoid.includes(skill) || !needed.has(skill)),
    tp,
    fp,
    fn,
    argErrors: wrongArgs,
    forbiddenRan,
    toolsOk: fn.length === 0 && fp.length === 0 && wrongArgs.length === 0 && forbiddenRan.length === 0,
    callerTurns: meta.callerTurns ?? turns.filter((turn) => turn.caller !== null).length,
    latenciesMs: meta.latenciesMs,
    ...(meta.heard ? { heard: meta.heard } : {}),
    ...(meta.answerMs ? { answerMs: meta.answerMs } : {}),
    transcript: transcriptOf(turns),
  };
}

/** The score as Curb checks, for `saveRun` and `report`. */
export function checksOfScore(score: CaseScore): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];
  if (score.skillFound !== null) checks.push({ name: "finds the skill", pass: score.skillFound, detail: `read: ${score.read.join(" > ") || "none"}` });
  if (score.navigationOk !== null) checks.push({ name: "navigates the skills", pass: score.navigationOk, detail: `read: ${score.read.join(" > ") || "none"}` });
  checks.push({
    name: "calls the right tools",
    pass: score.toolsOk,
    detail: [
      score.fn.length ? `missing ${score.fn.join(", ")}` : "",
      score.fp.length ? `unexpected ${score.fp.join(", ")}` : "",
      score.argErrors.length ? `arguments ${score.argErrors.join(" | ")}` : "",
      score.forbiddenRan.length ? `forbidden ran ${score.forbiddenRan.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ") || "all as expected",
  });
  return checks;
}

export function transcriptOf(turns: readonly ScenarioTurn[]): string {
  return turns
    .flatMap((turn) => [
      ...(turn.caller !== null ? [`caller: ${turn.caller}`] : []),
      ...turn.toolCalls.map((call) => `  [${call.name}${call.heldFor ? " held" : call.ok ? "" : " refused"}] ${JSON.stringify(call.input)}${call.result?.message ? ` -> ${String(call.result.message).slice(0, 160)}` : ""}`),
      ...(turn.reply ? [`agent:  ${turn.reply}`] : []),
    ])
    .join("\n");
}
