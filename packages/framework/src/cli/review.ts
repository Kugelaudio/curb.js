import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { groupFindings, inParallel, judge, loadCalls, projectHost, testModel, type ConversationRecord, type Finding, type TestHost } from "../testing/index.js";
import { conversationsFile } from "./conversations.js";
import { routeConsoleToStderr } from "./headless-project.js";
import { NOT_ASKED, REVIEW_FINDINGS, findingsOf, formatReview, recordsTools, reviewAsks, type ReviewReport } from "./review-report.js";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./scenarios/run.js";
import { runUsage } from "./scenarios/usage.js";
import { parseOptions, throttledBy } from "./test.js";

/** Conversations of the `curb dev` store that are reviewed when no path is given. */
const DEFAULT_LAST = 20;

export const REVIEW_USAGE = `Usage: curb review [<file or folder>...] [options]

Reads many calls and reports what goes wrong on them, as patterns: what the agent does wrong
in one sentence, on how many calls, with quotes from them, and a scenario that would reproduce
it. The judge of curb test answers its questions about each call, a few calls at a time, and
one more request sorts the findings into patterns. The agent is not run.

Without a path, the last ${DEFAULT_LAST} conversations of curb dev are reviewed. A path is a file, or a
folder whose .json, .jsonl, .md and .txt files are read. A file is one of:
  - a saved test run (.curb/test-runs/<id>.json)
  - a Calls export from the KugelAudio dashboard (JSON Lines, one call per line)
  - the output of curb conversations --json
  - a text or Markdown file with one call, whose lines start with "Caller:" and "Agent:"

The calls are sent to the judge's model: by default a model of the agent's own LLM provider,
with the keys from the project's .env.

  --last <n>             without a path: the last n conversations of curb dev (default ${DEFAULT_LAST})
  --judge-model <id>     the judge's model, as for curb test: a model of the agent's provider,
                         or <provider>:<model> with openai, anthropic or kugelaudio
  --concurrency <k>      calls judged at a time (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})
  --json                 print one JSON object instead:
                         { calls: { reviewed, withoutFindings, withFindings, notJudged, skipped },
                           patterns: [{ title, calls, share, findings, kinds, examples: [{ call,
                           kind, turn, quote, reason }], scenario }], notAsked, notJudged, notes,
                           judgeModel, judgePromptVersion, usage, exitCode }

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
  if (calls.length === 0) {
    const where = given ? `${run.paths.join(", ")} hold${run.paths.length === 1 ? "s" : ""} no call with a transcript` : "curb dev has recorded no conversation here yet";
    throw new Error(
      `[CURB_REVIEW_NO_CALLS] Nothing to review: ${where}.\n` +
        `Fix: npx curb review <file or folder>, with ${loadCalls.shapes}. Without a path, talk to the agent in the preview first (npm run dev).`,
    );
  }

  const restoreConsole = routeConsoleToStderr();
  try {
    const host = options.host ?? projectHost();
    const before = host.throttle?.stats();
    // One model for every request: a model without a key is refused here, before any call.
    const model = await testModel({ host, role: "judge", ...(run.judgeModel === undefined ? {} : { model: run.judgeModel }) });
    const judgeModel = model.model;
    let concurrency = run.concurrency ?? DEFAULT_CONCURRENCY;
    progress(`Judging ${calls.length} call(s)${judgeModel ? ` on ${judgeModel}` : ""}, ${concurrency} at a time.`);

    let done = 0;
    const every = Math.max(1, Math.ceil(calls.length / 10));
    // Per call: its findings, or why it could not be judged. A call that could not is no reason to stop.
    const results = await inParallel(
      calls,
      async (call): Promise<Finding[] | { call: string; reason: string }> => {
        // A review judges what was said, not a goal written down for a test.
        const result = await judge({ ...call, caller: null }, { ...reviewAsks(call), model }).then(
          (answers) => findingsOf(call, answers),
          (error: unknown) => ({ call: call.id!, reason: error instanceof Error ? error.message : String(error) }),
        );
        done += 1;
        if (done % every === 0 && done < calls.length) progress(`Judged ${done} of ${calls.length} call(s).`);
        return result;
      },
      { concurrency, host, onSlowDown: (lowered) => void (concurrency = lowered) },
    );
    const judged = results.filter((result): result is Finding[] => Array.isArray(result));
    const notJudged = results.flatMap((result) => (Array.isArray(result) ? [] : [result]));
    const withFindings = judged.filter((ofCall) => ofCall.length > 0).length;
    const found = judged.flat();
    if (found.length > 0) progress(`Sorting ${found.length} finding(s) into patterns.`);
    const { patterns, notes } = await groupFindings(found, { model, calls: judged.length, kinds: REVIEW_FINDINGS });

    const notAsked = (lacks: (call: ConversationRecord) => boolean, { questions, of }: (typeof NOT_ASKED)[keyof typeof NOT_ASKED]) => {
      const count = calls.filter(lacks).length;
      return count > 0 ? [{ questions: [...questions], calls: count, why: of }] : [];
    };
    const throttled = throttledBy(host, before, concurrency);
    const report: ReviewReport = {
      calls: { reviewed: calls.length, withoutFindings: judged.length - withFindings, withFindings, notJudged: notJudged.length, skipped },
      patterns,
      notAsked: [...notAsked((call) => !recordsTools(call), NOT_ASKED.tools), ...notAsked((call) => call.ending.by === null, NOT_ASKED.ending)],
      notJudged,
      notes: [...(ignored.length > 0 ? [`Left out ${ignored.length} file(s) that hold no calls in a shape curb review reads: ${ignored.join(", ")}.`] : []), ...notes],
      judgeModel,
      judgePromptVersion: judge.promptVersion,
      usage: runUsage({ agent: null, caller: null, judge: model.usage() }),
      ...(throttled ? { throttled } : {}),
      exitCode: judged.length > 0 ? 0 : 1,
    };
    out(run.json ? `${JSON.stringify(report)}\n` : formatReview(report));
    return report.exitCode;
  } finally {
    restoreConsole();
  }
}
