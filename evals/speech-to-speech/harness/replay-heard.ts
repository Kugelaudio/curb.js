/**
 * What the speech model's hearing alone costs: every voice conversation of a results file played
 * again in text, with the caller lines as the model's transcript heard them, and scored like any
 * other. Text on the lines as said versus text on the lines as heard isolates recognition; heard
 * text versus voice is what the rest of the call (hand-over, the model's own words) costs.
 *
 *   cd agents/clinic && npx curb run ../../harness/replay-heard.ts <results dir with clinic.voice.json> [--out dir]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { converse, inParallel, scriptedCaller, startCall } from "curb/testing";
import { agentCases, runnerOptions, writeScores } from "./cli.js";
import { scoreTurns, type CaseScore } from "./score.js";

const from = process.argv[2];
if (!from) throw new Error("usage: replay-heard.ts <results dir> [--out dir]");
const options = runnerOptions(process.argv.slice(3));
const { cases, language } = await agentCases({ ...options, filter: null });
const voice = JSON.parse(readFileSync(join(from, `${options.agent}.voice.json`), "utf8")) as CaseScore[];

const plays = voice.flatMap((call) => {
  const spec = cases.find((candidate) => candidate.name === call.case);
  const lines = (call.heard ?? []).map((line) => line.heard?.trim() || "...");
  return spec && lines.length > 0 ? [{ spec, run: call.run, lines }] : [];
});
console.error(`${options.agent}: ${plays.length} voice conversation(s) replayed in text as heard`);

const scores = await inParallel(
  plays,
  async ({ spec, run, lines }) => {
    try {
      const call = await startCall(spec.fakes ? { fakes: spec.fakes } : {});
      const record = await converse(call, scriptedCaller(lines), { maxTurns: lines.length });
      call.close();
      const error = record.ending.by === "error" && record.ending.providerError ? (record.ending.reason ?? "provider error") : null;
      return scoreTurns(spec, record.turns, { agent: options.agent, language, path: "text", run, latenciesMs: [], error });
    } catch (caught) {
      return scoreTurns(spec, [], { agent: options.agent, language, path: "text", run, latenciesMs: [], error: String(caught) });
    }
  },
  { concurrency: options.concurrency },
);
console.error(`scores: ${writeScores(options, "text", scores)}`);
