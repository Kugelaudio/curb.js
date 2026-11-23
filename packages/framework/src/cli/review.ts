import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  callersFor,
  converse,
  groupFindings,
  inParallel,
  judge,
  loadCalls,
  projectHost,
  saveRun,
  simulatedCaller,
  startCall,
  testModel,
  type ConversationRecord,
  type Finding,
  type ScenarioCaller,
  type TestHost,
  type TestModel,
} from "../testing/index.js";
import { conversationsFile } from "./conversations.js";
import { routeConsoleToStderr } from "./headless-project.js";
import { coverageOf } from "./review-coverage.js";
import { NOT_ASKED, REVIEW_FINDINGS, calledFor, cutOffSimulation, findingsOf, formatReview, recordsTools, reviewAsks, type ReviewReport } from "./review-report.js";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./scenarios/run.js";
import { sumUsage } from "./scenarios/usage.js";
import { parseOptions, projectFindings, throttledBy } from "./test.js";

/** Conversations of the `curb dev` store that are reviewed when no path is given. */
const DEFAULT_LAST = 20;

/** Calls simulated when no path is given and `curb dev` has recorded none, and the caller turns
 * each may take: enough for most calls to end on their own, few enough for a round to stay short. */
export const SIMULATED_CALLS = 20;
export const SIMULATED_MAX_TURNS = 8;
/** The name simulated calls are saved under: `curb review` names them "simulated run <n>". */
export const SIMULATED_NAME = "simulated";

export const REVIEW_USAGE = `Usage: curb review [<file or folder>...] [options]

Reads many calls and reports what goes wrong on them, as patterns: what the agent does wrong
in one sentence, on how many calls, with quotes from them, and a scenario that would reproduce
it, its caller written from one of the pattern's calls. The judge of curb test answers its
questions about each call, a few calls at a time, and one more request sorts the findings into
patterns. The findings the project's scenarios give (findings) are asked too. Then it says what
callers called about, by topic, and which scenario covers each. The agent is not run.

Without a path, the last ${DEFAULT_LAST} conversations of curb dev are reviewed. When curb dev has recorded
none yet (a new agent), ${SIMULATED_CALLS} simulated calls are played instead: callers written from what the
agent offers (its prompt, skills and tools), most wanting what it is for, a few hard to serve and
a few wanting what it cannot do, at most ${SIMULATED_MAX_TURNS} caller turns each. They are saved as a run
(.curb/test-runs/<id>.json) and reviewed as real calls are; the report's first line says so.

A path is a file, or a folder whose .json, .jsonl, .md and .txt files are read. A file is one of:
  - a saved test run (.curb/test-runs/<id>.json)
  - a Calls export from the KugelAudio dashboard (JSON Lines, one call per line); a line that
    carries toolCalls is also asked claimed_without_tool and wrong_tool_use
  - the output of curb conversations --json
  - a text or Markdown file with one call, whose lines start with "Caller:" and "Agent:"

The calls are sent to the judge's model: by default a model of the agent's own LLM provider,
with the keys from the project's .env.

  --last <n>             without a path: the last n conversations of curb dev (default ${DEFAULT_LAST})
  --judge-model <id>     the judge's model, as for curb test: a model of the agent's provider,
                         or <provider>:<model> with openai, anthropic or kugelaudio
  --concurrency <k>      calls judged at a time (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})
  --json                 print one JSON object instead:
                         { simulated?: { calls, maxTurns, savedTo },
                           calls: { reviewed, withoutFindings, withFindings, notJudged, skipped },
                           patterns: [{ title, calls, share, findings, kinds, examples: [{ call,
                           kind, turn, quote, reason }], scenario }], coverage: { topics: [{
                           topic, calls, share, scenarios }], unclear }, notAsked, notJudged,
                           notes, judgeModel, judgePromptVersion, usage, exitCode }

Exit code 0 when calls were reviewed, with or without findings; 1 when no call could be read
or none could be judged.`;

const FLAGS = ["--json"];
const VALUES: Readonly<Record<string, string>> = { "--last": "<n>", "--judge-model": "<id>", "--concurrency": "<k>" };

/** The options `curb review` takes, as public-api.txt lists them. */
export const REVIEW_OPTIONS: readonly string[] = [...FLAGS, ...Object.keys(VALUES)];

export type ReviewArgs = { paths: string[]; json: boolean; last?: number; judgeModel?: string; concurrency?: number };

/** `curb review` arguments: every argument that is no option is a file or a folder. */
export function parseReviewArgs(args: readonly string[]): ReviewArgs {
  const { words, values, flags, wrong, number, concurrency } = parseOptions("curb review", REVIEW_USAGE, args, FLAGS, VALUES);
  const last = number("--last", (value) => Number.isInteger(value) && value >= 1, "a whole number of 1 or more");
  if (last !== undefined && words.length > 0) throw wrong("--last", "selects conversations of curb dev, and takes no file or folder beside it.");
  return { paths: words, json: flags.has("--json"), last, judgeModel: values.get("--judge-model"), concurrency: concurrency() };
}

/** The calls of what `paths` name, files or folders, as `loadCalls` reads them. */
export function readCallFiles(projectRoot: string, paths: readonly string[]) {
  return loadCalls(paths, { root: projectRoot });
}

/** The last `last` conversations of the project's `curb dev` store; none when it records none. */
function readStoredCalls(projectRoot: string, last: number, env: NodeJS.ProcessEnv): { calls: ConversationRecord[]; skipped: number; ignored?: string[] } {
  const file = conversationsFile(env);
  const path = file === null ? null : resolve(projectRoot, file);
  // A project that never talked has no store yet, or an empty one.
  if (path === null || !existsSync(path) || statSync(path).size === 0) return { calls: [], skipped: 0 };
  const { calls, skipped } = loadCalls(path, { last, root: projectRoot });
  return { calls, skipped };
}

/**
 * `curb review <args>` in the project at `projectRoot` (its .env already loaded). Writes the
 * report to `out` and returns the exit code. Progress and framework logs go to stderr, so
 * stdout carries only the report (one JSON object with --json).
 */
export async function reviewCommand(
  args: readonly string[],
  projectRoot: string,
  options: { host?: TestHost; out?: (text: string) => void; progress?: (line: string) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const progress = options.progress ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const run = parseReviewArgs(args);
  const given = run.paths.length > 0;
  // Read before the host is made: it turns conversation recording off for this process.
  const { calls, skipped, ignored = [] } = given ? readCallFiles(projectRoot, run.paths) : readStoredCalls(projectRoot, run.last ?? DEFAULT_LAST, options.env ?? process.env);
  // Two sources may name a call alike, and the report counts calls by their id.
  const named = new Map<string, number>();
  for (const call of calls) {
    const id = call.id ?? "call";
    const times = (named.get(id) ?? 0) + 1;
    named.set(id, times);
    call.id = times > 1 ? `${id} (${times})` : id;
  }
  // A new agent has no recorded conversation yet: its calls are simulated instead.
  const simulate = calls.length === 0 && !given;
  if (calls.length === 0 && given) {
    throw new Error(
      `[CURB_REVIEW_NO_CALLS] Nothing to review: ${run.paths.join(", ")} hold${run.paths.length === 1 ? "s" : ""} no call with a transcript.\n` +
        `Fix: npx curb review <file or folder>, with ${loadCalls.shapes}. Without a path, curb review reviews the conversations of the preview (npm run dev), or simulates calls when there are none.`,
    );
  }

  const restoreConsole = routeConsoleToStderr();
  try {
    // The findings the project's scenarios give are asked of every call too.
    const own = await projectFindings(projectRoot);
    const host = options.host ?? projectHost();
    const before = host.throttle?.stats();
    // One model for every request: a model without a key is refused here, before any call.
    const model = await testModel({ host, role: "judge", ...(run.judgeModel === undefined ? {} : { model: run.judgeModel }) });
    const judgeModel = model.model;
    let concurrency = run.concurrency ?? DEFAULT_CONCURRENCY;
    const slowDown = (lowered: number) => void (concurrency = lowered);

    // Per call: its findings and what the caller called for, or why it could not be judged. A
    // call that could not is no reason to stop.
    type Judged = { findings: Finding[]; calledFor: string | null };
    type NotJudged = { call: string; reason: string };
    const judgeCall = (call: ConversationRecord): Promise<Judged | NotJudged> => {
      // A review judges what was said, not a goal written down for a test.
      const asks = reviewAsks(call);
      return judge({ ...call, caller: null }, { ...asks, findings: { ...asks.findings, ...own.findings }, model }).then(
        (answers): Judged => ({ findings: findingsOf(call, answers), calledFor: calledFor(answers) }),
        (error: unknown) => ({ call: call.id!, reason: error instanceof Error ? error.message : String(error) }),
      );
    };

    let results: Array<Judged | NotJudged>;
    let simulated: ReviewReport["simulated"];
    let callerUsage: ReturnType<TestModel["usage"]> = null;
    if (simulate) {
      const played = await simulateCalls({ host, projectRoot, model, concurrency, onSlowDown: slowDown, judgeCall, progress });
      calls.push(...played.calls);
      results = played.results;
      simulated = { calls: played.calls.length, maxTurns: SIMULATED_MAX_TURNS, savedTo: played.savedTo };
      callerUsage = played.callerUsage;
    } else {
      progress(`Judging ${calls.length} call(s)${judgeModel ? ` on ${judgeModel}` : ""}, ${concurrency} at a time.`);
      let done = 0;
      const every = Math.max(1, Math.ceil(calls.length / 10));
      results = await inParallel(
        calls,
        async (call) => {
          const result = await judgeCall(call);
          done += 1;
          if (done % every === 0 && done < calls.length) progress(`Judged ${done} of ${calls.length} call(s).`);
          return result;
        },
        { concurrency, host, onSlowDown: slowDown },
      );
    }
    const judged = results.filter((result): result is Judged => "findings" in result);
    const notJudged = results.flatMap((result) => ("findings" in result ? [] : [result]));
    const withFindings = judged.filter((ofCall) => ofCall.findings.length > 0).length;
    const found = judged.flatMap((ofCall) => ofCall.findings);
    if (found.length > 0) progress(`Sorting ${found.length} finding(s) into patterns.`);
    // Each draft's caller is written from a call of its pattern, so it keeps that call's order
    // numbers and the like. Sorting the findings and what callers called about wait on nothing
    // of each other's, so they are asked at once.
    const [{ patterns, notes }, covered] = await Promise.all([
      groupFindings(found, { model, calls: judged.length, kinds: { ...REVIEW_FINDINGS, ...own.findings }, records: calls }),
      coverageOf({ reasons: judged.map((ofCall) => ofCall.calledFor), scenarios: own.scenarios, model }),
    ]);

    const notAsked = (lacks: (call: ConversationRecord) => boolean, { questions, of }: (typeof NOT_ASKED)[keyof typeof NOT_ASKED]) => {
      const count = calls.filter(lacks).length;
      return count > 0 ? [{ questions: [...questions], calls: count, why: of }] : [];
    };
    const throttled = throttledBy(host, before, concurrency);
    const report: ReviewReport = {
      ...(simulated ? { simulated } : {}),
      calls: { reviewed: results.length, withoutFindings: judged.length - withFindings, withFindings, notJudged: notJudged.length, skipped },
      patterns,
      coverage: covered.coverage,
      notAsked: [
        ...notAsked((call) => !recordsTools(call), NOT_ASKED.tools),
        ...notAsked((call) => call.ending.by === null, NOT_ASKED.ending),
        ...notAsked(cutOffSimulation, NOT_ASKED.turnLimit),
      ],
      notJudged,
      notes: [...(ignored.length > 0 ? [`Left out ${ignored.length} file(s) that hold no calls in a shape curb review reads: ${ignored.join(", ")}.`] : []), ...own.notes, ...notes, ...(covered.note ? [covered.note] : [])],
      judgeModel,
      judgePromptVersion: judge.promptVersion,
      // The agent's and the caller's tokens only where this review played the calls.
      usage: sumUsage([...(simulate ? calls.map((call) => (call.usage ? { agent: call.usage.agent } : null)) : []), { caller: callerUsage, judge: model.usage() }]),
      ...(throttled ? { throttled } : {}),
      exitCode: judged.length > 0 ? 0 : 1,
    };
    out(run.json ? `${JSON.stringify(report)}\n` : formatReview(report));
    return report.exitCode;
  } finally {
    restoreConsole();
  }
}

/**
 * The calls of an agent that has had none, simulated: `callersFor` writes {@link SIMULATED_CALLS}
 * callers from what the agent offers, each is played (`startCall`, `simulatedCaller`, `converse`,
 * at most {@link SIMULATED_MAX_TURNS} caller turns) `concurrency` at a time on the host's one
 * throttle, and each is handed to `judgeCall` as soon as it ends, so the judge works while the
 * other calls play. A call that broke off on the provider or the simulated caller says nothing
 * about the agent and is not judged. The calls are saved as a run (`saveRun`), which
 * `curb review <run>` and `curb test --rejudge <run>` read again.
 */
async function simulateCalls<R>(params: {
  host: TestHost;
  projectRoot: string;
  model: TestModel;
  concurrency: number;
  onSlowDown: (concurrency: number) => void;
  judgeCall: (call: ConversationRecord) => Promise<R>;
  progress: (line: string) => void;
}): Promise<{ calls: ConversationRecord[]; results: Array<R | { call: string; reason: string }>; savedTo: string; callerUsage: ReturnType<TestModel["usage"]> }> {
  const { host, model, progress } = params;
  progress(`curb dev has recorded no conversation here yet, so ${SIMULATED_CALLS} calls are simulated instead.`);
  progress(`Writing ${SIMULATED_CALLS} callers from what the agent offers${model.model ? ` on ${model.model}` : ""}.`);
  let callers: ScenarioCaller[];
  try {
    callers = await callersFor({ count: SIMULATED_CALLS, model, host });
  } catch (error) {
    throw new Error(
      `[CURB_REVIEW_NO_CALLERS] curb dev has recorded no conversation here yet, and no callers could be written to simulate calls: ${error instanceof Error ? error.message : String(error)}\n` +
        "Fix: run npx curb review again; or talk to the agent in the preview (npm run dev), or pass a file of calls: npx curb review <file or folder>.",
    );
  }
  const callerModel = await testModel({ host, role: "caller" });
  progress(`Playing ${callers.length} simulated call(s), ${params.concurrency} at a time, at most ${SIMULATED_MAX_TURNS} caller turns each; each is judged as soon as it ends.`);

  type NotJudged = { call: string; reason: string };
  const judging: Array<Promise<R | NotJudged>> = [];
  let agentModel: string | null = null;
  let done = 0;
  const every = Math.max(1, Math.ceil(callers.length / 10));
  const played = await inParallel(
    callers,
    async (definition, index): Promise<ConversationRecord | null> => {
      const id = `${SIMULATED_NAME} run ${index + 1}`;
      let record: ConversationRecord | null = null;
      try {
        const call = await startCall({ host });
        agentModel ??= call.model;
        record = await converse(call, simulatedCaller(definition, { model: callerModel }), { maxTurns: SIMULATED_MAX_TURNS });
        record = { ...record, id, scenario: { name: SIMULATED_NAME, file: "", mode: "simulated", run: index + 1 } };
      } catch (error) {
        judging[index] = Promise.resolve({ call: id, reason: `the call could not be played: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (record) {
        const brokeOff = record.ending.by === "simulator" || (record.ending.by === "error" && record.ending.providerError === true);
        // Not awaited: the slot goes to the next call while the judge reads this one.
        judging[index] = brokeOff ? Promise.resolve({ call: id, reason: `the call broke off: ${record.ending.reason ?? record.ending.by}` }) : params.judgeCall(record);
      }
      done += 1;
      if (done % every === 0 && done < callers.length) progress(`Played ${done} of ${callers.length} call(s).`);
      return record;
    },
    { concurrency: params.concurrency, host, onSlowDown: params.onSlowDown },
  );
  const calls = played.filter((record): record is ConversationRecord => record !== null);
  const { path } = saveRun(calls, { name: SIMULATED_NAME, root: params.projectRoot, models: { agent: agentModel, caller: callerModel.model, judge: model.model } });
  progress(`Saved the ${calls.length} simulated call(s) to ${path}.`);
  return { calls, results: await Promise.all(judging), savedTo: path, callerUsage: callerModel.usage() };
}
