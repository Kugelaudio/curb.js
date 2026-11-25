/** What both runners share: their options, the agent's cases, and where results go. */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { testModel, type Caller, type TestModel } from "curb/testing";
import { simulatedCaller, scriptedCaller } from "curb/testing";
import type { CaseScore } from "./score.js";
import { casesIn, lineOf, type EvalCaseSpec } from "./spec.js";

export type RunnerOptions = {
  agent: string;
  runs: number;
  filter: string | null;
  out: string;
  concurrency: number;
  callerModel: string | undefined;
  /** Voice: the first eval's caller timing and number reading (see `voice-call.ts`). */
  legacyCaller: boolean;
};

export function runnerOptions(argv: readonly string[]): RunnerOptions {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  return {
    agent: basename(process.cwd()),
    runs: Number(value("--runs") ?? 1),
    filter: value("--filter") ?? null,
    out: resolve(value("--out") ?? join(process.cwd(), "..", "..", ".results", "latest")),
    concurrency: Number(value("--concurrency") ?? 3),
    callerModel: value("--caller-model") ?? process.env.EVAL_CALLER_MODEL,
    legacyCaller: argv.includes("--legacy-caller"),
  };
}

/** The agent's cases, from its `src/agent/eval.scenario.ts`, and the language it speaks. */
export async function agentCases(options: RunnerOptions): Promise<{ cases: EvalCaseSpec[]; language: string }> {
  const module = (await import(pathToFileURL(resolve("src/agent/eval.scenario.ts")).href)) as Record<string, unknown>;
  const language = typeof module.language === "string" ? module.language : "en";
  const cases = casesIn(module).filter((spec) => !options.filter || spec.name.includes(options.filter) || spec.kind === options.filter);
  return { cases, language };
}

let callerModel: Promise<TestModel> | null = null;

/** The case's caller, speaking the case file's `language` unless the case says otherwise. */
export function callerOf(spec: EvalCaseSpec, options: RunnerOptions, language: string): Caller {
  if (spec.turns) return scriptedCaller(spec.turns.map(lineOf));
  callerModel ??= testModel({ role: "caller", ...(options.callerModel ? { model: options.callerModel } : {}) });
  const model = (system: string, input: string) => callerModel!.then((use) => use(system, input));
  return simulatedCaller({ language, ...spec.caller! }, { model });
}

/** Caller turns (1-based) whose line talks over the agent. */
export function interruptTurns(spec: EvalCaseSpec): Set<number> {
  return new Set((spec.turns ?? []).flatMap((entry, index) => (typeof entry === "object" && entry.interrupt ? [index + 1] : [])));
}

export function writeScores(options: RunnerOptions, path: string, scores: readonly CaseScore[]): string {
  mkdirSync(options.out, { recursive: true });
  const file = join(options.out, `${options.agent}.${path}.json`);
  writeFileSync(file, `${JSON.stringify(scores, null, 2)}\n`);
  return file;
}
