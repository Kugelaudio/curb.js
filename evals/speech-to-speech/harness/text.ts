/**
 * The text path: every case of the agent in the project directory, played in text with
 * `curb/testing` (`startCall`, then `converse` with the case's caller), and scored.
 *
 * On an agent with `s2s`, `startCall` hands each caller line to the agent's back office as the
 * speech model would, so this measures what `llm` does with the words, without the speech model:
 * the baseline the voice path is compared with.
 *
 *   cd agents/clinic && npx curb run ../../harness/text.ts [--runs 3] [--filter <name|kind>]
 */

import { converse, inParallel, saveRun, startCall, type Call } from "curb/testing";
import { agentCases, callerOf, runnerOptions, writeScores } from "./cli.js";
import { checksOfScore, scoreTurns, type CaseScore } from "./score.js";
import type { EvalCaseSpec } from "./spec.js";

const options = runnerOptions(process.argv.slice(2));
const { cases, language } = await agentCases(options);
const plays = cases.flatMap((spec) => Array.from({ length: options.runs }, (_, index) => ({ spec, run: index + 1 })));
console.error(`${options.agent}: ${cases.length} case(s) x ${options.runs} run(s), text`);

/** `call`, with how long each caller turn took. */
function timed(call: Call, latencies: number[]): Call {
  return new Proxy(call, {
    get(target, key) {
      if (key === "say") {
        return async (text: string) => {
          const started = performance.now();
          const turn = await target.say(text);
          latencies.push(Math.round(performance.now() - started));
          return turn;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function play({ spec, run }: { spec: EvalCaseSpec; run: number }) {
  const latencies: number[] = [];
  try {
    const call = await startCall(spec.fakes ? { fakes: spec.fakes } : {});
    const record = await converse(timed(call, latencies), callerOf(spec, options), { maxTurns: spec.maxTurns ?? (spec.turns?.length ?? 10) });
    call.close();
    const providerError = record.ending.by === "error" && record.ending.providerError === true;
    const score = scoreTurns(spec, record.turns, {
      agent: options.agent,
      language,
      path: "text",
      run,
      latenciesMs: latencies,
      error: providerError ? (record.ending.reason ?? "provider error") : null,
    });
    console.error(`  ${score.toolsOk && score.skillFound !== false && score.navigationOk !== false ? "pass" : "FAIL"}  ${spec.name} (run ${run})`);
    return { record: { ...record, scenario: { name: spec.name, file: "src/agent/eval.scenario.ts", mode: spec.turns ? ("scripted" as const) : ("simulated" as const), run } }, score };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ERROR ${spec.name} (run ${run}): ${message}`);
    return { record: null, score: scoreTurns(spec, [], { agent: options.agent, language, path: "text", run, latenciesMs: latencies, error: message }) };
  }
}

const results = await inParallel(plays, play, { concurrency: options.concurrency });
const scores: CaseScore[] = results.map((result) => result.score);
const saved = results.flatMap((result) => (result.record ? [{ record: result.record, checks: checksOfScore(result.score) }] : []));
if (saved.length > 0) {
  const { path } = saveRun(saved.map((item) => item.record), { name: `s2s eval text ${options.agent}`, checks: saved.map((item) => item.checks) });
  console.error(`conversations: ${path}`);
}
console.error(`scores: ${writeScores(options, "text", scores)}`);
