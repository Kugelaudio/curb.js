/**
 * The voice path: every case of the agent in the project directory as a real voice call. It
 * starts `curb server` for the project, plays each case through a local call (`voice-call.ts`),
 * reads the call back from the server's conversation store with `loadCalls`, and scores it like
 * a text conversation. Calls run one at a time per agent, so each store entry is one case.
 *
 *   cd agents/clinic && npx curb run ../../harness/voice.ts [--runs 1] [--filter <name|kind>]
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { loadCalls, saveRun, type ConversationRecord } from "curb/testing";
import { agentCases, callerOf, interruptTurns, runnerOptions, writeScores } from "./cli.js";
import { lineOf } from "./spec.js";
import { checksOfScore, scoreTurns, type CaseScore } from "./score.js";
import { playVoiceCall } from "./voice-call.js";

const options = runnerOptions(process.argv.slice(2));
const { cases, language } = await agentCases(options);
console.error(`${options.agent}: ${cases.length} case(s) x ${options.runs} run(s), voice`);

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });

/** A diagnostic log of Curb's back office, when the framework writes one (`S2S_DEBUG_LOG`), one file per agent. */
const debugLog = process.env.S2S_DEBUG_LOG ? `${process.env.S2S_DEBUG_LOG}.${options.agent}.jsonl` : null;
const store = join(mkdtempSync(join(tmpdir(), `s2s-eval-${options.agent}-`)), "conversations.jsonl");
const port = await freePort();
const curbBin = join(dirname(createRequire(resolve("package.json")).resolve("curb/package.json")), "bin", "curb.js");
const server = spawn(process.execPath, [curbBin, "server", "--port", String(port)], {
  env: { ...process.env, KUGEL_CONVERSATIONS_DB: store, ...(debugLog ? { S2S_DEBUG_LOG: debugLog } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));
await new Promise<void>((ready, fail) => {
  const timer = setTimeout(() => fail(new Error(`curb server did not start:\n${serverLog.slice(-2000)}`)), 60_000);
  const poll = setInterval(() => {
    if (/Ready in/.test(serverLog)) {
      clearTimeout(timer);
      clearInterval(poll);
      ready();
    }
  }, 200);
  server.on("exit", (code) => fail(new Error(`curb server exited ${code}:\n${serverLog.slice(-2000)}`)));
});

const scores: CaseScore[] = [];
const records: ConversationRecord[] = [];
const checks = [];
try {
  for (const spec of cases) {
    for (let run = 1; run <= options.runs; run += 1) {
      const before = loadedCount();
      const log = (line: string) => console.error(`    ${new Date().toISOString().slice(11, 19)} ${line}`);
      console.error(`  ${spec.name} (run ${run})`);
      if (debugLog) appendFileSync(debugLog, `${JSON.stringify({ at: Date.now(), e: "case", agent: options.agent, case: spec.name, run })}\n`);
      const call = await playVoiceCall({
        port,
        language,
        caller: callerOf(spec, options, language),
        interrupt: interruptTurns(spec),
        maxTurns: spec.maxTurns ?? (spec.turns?.length ?? 10),
        caller_setup: options.legacyCaller ? "legacy" : "clean",
        prefetch: (spec.turns ?? []).map(lineOf),
        log,
      });
      // The store is written as the call goes; give its last lines a moment.
      await new Promise((settle) => setTimeout(settle, 1_500));
      const recorded = loadedCount() > before ? loadCalls(store, { last: 1 }).calls[0] : undefined;
      const meta = {
        agent: options.agent,
        language,
        path: "voice" as const,
        run,
        latenciesMs: call.timings.flatMap((timing) => (timing.latencyMs === null ? [] : [timing.latencyMs])),
        answerMs: call.timings.flatMap((timing) => (timing.answerMs === null ? [] : [timing.answerMs])),
        callerTurns: call.timings.length,
        heard: call.timings.map(({ said, heard }) => ({ said, heard })),
        error: call.error ?? (recorded ? null : "the call left no conversation in the store"),
      };
      const score = scoreTurns(spec, recorded?.turns ?? [], meta);
      scores.push(score);
      if (recorded) {
        records.push({ ...recorded, scenario: { name: spec.name, file: "src/agent/eval.scenario.ts", mode: spec.turns ? "scripted" : "simulated", run } });
        checks.push(checksOfScore(score));
      }
      const silent = call.timings.filter((timing) => timing.latencyMs === null).length;
      console.error(`  ${score.error ? "ERROR" : score.toolsOk && score.skillFound !== false && score.navigationOk !== false ? "pass " : "FAIL "} ${spec.name}${silent ? ` (${silent} turn(s) without a reply)` : ""}`);
    }
  }
} finally {
  server.kill("SIGTERM");
}
if (records.length > 0) {
  const { path } = saveRun(records, { name: `s2s eval voice ${options.agent}`, checks });
  console.error(`conversations: ${path}`);
}
console.error(`scores: ${writeScores(options, "voice", scores)}`);

function loadedCount(): number {
  try {
    return loadCalls(store).calls.length;
  } catch {
    return 0;
  }
}
