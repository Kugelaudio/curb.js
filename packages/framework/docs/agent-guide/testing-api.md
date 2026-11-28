# Testing

`curb/testing` is everything to test an agent and improve it from real calls, in text, in three
layers. Layer 3 is the ready-made path: `scenario` files that `curb test` runs, as in the
[Testing guide](./testing.md). Layers 1 and 2 are the plain functions it is built from, the same
exports `curb test` and `curb review` use, for a test of your own in any test runner or script.

| Layer | Export | What it does |
|---|---|---|
| 1 | [`startCall`](#startcall) | A call of the agent in text, driven turn by turn |
| 1 | [`loadCalls`](#loadcalls), [`loadRun`](#saverun-and-loadrun), [`saveRun`](#saverun-and-loadrun) | Conversations as records: read from files, saved as a run |
| 1 | [`testModel`](#testmodel) | A model to think with |
| 1 | [`inParallel`](#inparallel) | Many at once, slowing down on a rate limit |
| 1 | [`report`](#report), [`passRate`](#passrate) | Results for the terminal, Markdown, CI and JSON, and the exit code |
| 1 | [`projectHost`](#projecthost) | What all of them run on |
| 2 | [`simulatedCaller`](#simulatedcaller), [`scriptedCaller`](#scriptedcaller), [`personas`](#personas) | Callers |
| 2 | [`callerFromCall`](#callerfromcall), [`replayCall`](#replaycall) | A real call as a test |
| 2 | [`callersFor`](#callersfor) | Callers for an agent that has had no calls yet |
| 2 | [`converse`](#converse) | A whole conversation between a caller and the agent |
| 2 | [`builtInChecks`](#builtinchecks), [`checksOf`](#checksof) | Checks of one conversation |
| 2 | [`judge`](#judge), [`ask`](#ask), [`FINDINGS`](#findings) | The judge, with a turn and a quote checked against the call |
| 2 | [`judgeAgreement`](#judgeagreement) | How far to trust the judge on your findings |
| 2 | [`styleNumbers`](#stylenumbers), [`groupFindings`](#groupfindings) | Numbers and patterns across many conversations |
| 2 | [`compareRuns`](#compareruns), [`compare`](#compare) | Did a change help: two runs, or two sets of calls side by side |
| 2 | [`affectedScenarios`](#affectedscenarios) | Which scenarios a change can affect |
| 3 | `scenario` | Declares a conversation for `curb test` |
| 3 | `runHook`, `buildCallEvent` | Run one of the agent's hooks in this process |

[Build your own tests](./testing-foundation.md) shows the three layers in worked examples.

Every function of layers 1 and 2 runs the project's own agent on its own LLM provider, with the
keys from the project's `.env` or `npx curb login`. Run a script of your own with
[`npx curb run`](./cli/run.md); in a test runner such as vitest, `startCall` prepares the project
itself.

## `startCall`

```ts
startCall(options?: { fakes?, client?, experiments?, host? }): Promise<Call>
```

```ts
import { startCall } from "curb/testing";
import { expect, it } from "vitest";

it("books a haircut", async () => {
  const call = await startCall({ fakes: { book: { ok: true, message: "Booked." } } });
  const turn = await call.say("A haircut tomorrow at ten, please. I'm Alex Example.");
  expect(turn.toolCalls.map((tool) => tool.name)).toContain("book");
  expect(call.state("calendar")).toMatchObject({ appointments: [{ service: "haircut" }] });
  call.close();
});
```

Starts a call of the project's agent through the same session, skills, tools and spoken-reply rules
as a phone call, `end_call` included; the agent's greeting or fixed line is played first. Text only:
audio, timing and interruptions are not part of it. When no `curb` command prepared the project,
the first call does: the root from the working directory, its `.env`, the key of `npx curb login`.
Conversation recording is off, and the framework's own log lines go to stderr.

| Option | What it does |
|---|---|
| `fakes` | Tools that must not run for real, as in a scenario |
| `client` | Page info the call starts with |
| `experiments` | The variant per experiment, `{ greeting: "casual" }`, or a function of the agent's experiments (`[{ name, variants: [{ name, weight }] }]`) that returns them. An experiment left out draws its variant as a call would |
| `start` | `{ skills, info }`: call info set and skills opened before the opening and turn 1, as in a scenario ([Starting inside a skill](./testing.md#starting-inside-a-skill)). A skill that is not one of the agent's, or more skills than the agent keeps loaded, is refused |
| `spoken` | `false` plays every turn as typed text, without the spoken-reply rules, as a host's `user_text` does without a live call. Default: `true` |
| `host` | What the agent runs on. Default: [`projectHost()`](#projecthost) |

| `Call` | What it is |
|---|---|
| `opening` | The agent's opening as turn 0, or `null` when the caller speaks first |
| `say(text)` | Plays one caller line and resolves with the turn: `reply`, `toolCalls` (each with `input`, `ok`, `result`, `faked`), `errors`, `endedCall` and the rest of a `ScenarioTurn`. Rejects once the call has ended |
| `turns` | Every turn so far |
| `state(store)` | The data of a `createAgentStore` store now, by its key |
| `context` | The agent's rendered context now, line by line: its knowledge, the skills it can open (`available_skill: ...`) and its tools |
| `systemPrompt` | The system prompt the agent's model receives on the caller's next turn: the agent's `<SystemPrompt>` and, unless `spoken: false`, the framework's spoken-reply rules |
| `ended` | The agent hung up, or the call was closed |
| `experiments`, `language`, `model` | The call's variants, the agent's language, the agent's model as `provider:model` |
| `record()` | The call as a [conversation record](./test-runs.md#a-conversation-record), `source: "call"` |
| `close()` | Ends the call; its record and state stay readable |

## `loadCalls`

```ts
loadCalls(paths: string | string[], options?: { last?: number; root?: string }): { calls: ConversationRecord[]; skipped: number; ignored: string[] }
```

```ts
const { calls } = loadCalls("exports/");
```

Reads calls from the files `curb review` reads as conversation records: a saved test run, a Calls
export of the KugelAudio dashboard, the output of `curb conversations --json`, a text or Markdown
transcript, and the `curb dev` store itself (`.data/conversations.jsonl`, of which `last` keeps the
newest). A folder's `.json`, `.jsonl`, `.md` and `.txt` files are read; a relative path is read from
`root`, the project by default. `skipped` counts calls without a transcript, `ignored` names files in
a folder that hold none of the shapes. A record says what its source does not know: `ending.by` is
`null` when the source does not say who ended the call, and `recordsToolCalls: false` when it holds
no tool calls. A Calls export line that carries `toolCalls` holds them: each is read into the agent
turn it happened in, by its time in the call ([the fields](./cli/review.md#calls-of-a-hosted-agent)).
A tool call's `result` becomes the turn's `{ ok, message, data }`, whether the line holds it whole
or as the `{ message, data }` of a hosted call's record beside the tool call's `ok`; it is there
for calls of an agent built with Curb v1.25.0 or later. A line's `durationSeconds`, or its
`durationMs`, is the record's `durationMs`.

## `saveRun` and `loadRun`

```ts
saveRun(records: ConversationRecord[], options?: { name?, checks?, root?, ... }): { run: TestRun; path: string }
loadRun(which?: string, options?: { root?: string }): TestRun
```

```ts
const { path } = saveRun(records, { name: "nightly", checks });
```

`saveRun` saves conversations as a [run](./test-runs.md), `.curb/test-runs/<id>.json`, which
`curb test --rejudge` checks again and `curb review` reads. Conversations without a scenario are
saved under `name` (default `conversations`); `checks`, one list per conversation, is saved as each
one's assessment. Any other field of the run file can be given, and an earlier run's `id` replaces
its file. The run records the agent's version: the project's git commit, whether its files
differed from it, and a hash of the agent's sources. `loadRun` reads one back: `latest` (the
default), a run's id, or a file.

## `testModel`

```ts
testModel(options?: { model?: string; role?: "caller" | "judge"; host?: TestHost }): Promise<TestModel>
```

```ts
const model = await testModel();
const verdict = await model("Does the agent sound like a person? Answer yes or no.", transcript);
```

A model to think with, as a function from a system prompt and an input to the model's text. Without
`model` it is the small model of the agent's provider that `curb test` uses; `model` names another as
`--judge-model` does, `<provider>:<id>` or a model of the agent's provider. Requests share the
host's retries and rate limit, and `usage()` returns the tokens they used. `model.model` names it as
`provider:model`. It rejects, naming the variable, when the model has no key. `role` says which
part it plays for the host.

## `inParallel`

```ts
inParallel(items, fn: (item, index) => Promise<R>, options: { concurrency: number; host?; onSlowDown? }): Promise<R[]>
```

Runs `fn` on every item, `concurrency` at a time, and resolves with the results in the items'
order. A rate limit of the provider is no failure: every request waits it out, and from then on half
as many items run at once, down to one (`onSlowDown` hears the new number). It rejects with the
first error `fn` throws; catch inside `fn` to keep going.

## `report`

```ts
report(groups: ReportGroup[], options?: { title?, json?, markdown?, out?, env? }): 0 | 1 | 2
```

```ts
process.exitCode = report(cases.map((testCase, index) => ({ name: testCase.name, checks: checks[index] })), { markdown: "report.md" });
```

Prints named groups, each with its `checks`, `findings` and `notes`, and returns the exit code: 0
when every group passed, 1 when a check failed, 2 when none failed but a group has an `error`. A
check marked `reportOnly: true` or `notJudged: true` fails nothing. With `json` it prints one JSON
object instead; `markdown` also writes the report as Markdown, and when `GITHUB_STEP_SUMMARY` is set
the Markdown is appended to the job summary.

## `passRate`

```ts
passRate(results: Array<"pass" | "fail" | "error" | ScenarioCheck[]>): { runs, passed, failed, errors, passRate, reliability, errorRate }
```

The pass rate of runs, each given as its outcome or its checks. Errors are left out of the rate;
`reliability` is the rate to the power of the runs, the chance that all of them pass.

## `projectHost`

```ts
projectHost(): TestHost
```

The host every function here runs on when given none: the project's agent, built the way a call
builds it, and its LLM provider, with one rate limit for all their requests. A hermetic test passes
a `host` of its own: `createBundle()` builds the agent, `simulator(llm, role, onUsage, model?)`
returns the client a `testModel` sends to, `models()` names them, and `throttle` is shared.

## `simulatedCaller`

```ts
simulatedCaller(caller: { goal, knows?, language?, persona?, behaviours? }, options?: { model? }): Caller
```

The caller of a scenario's `caller`: a model that answers the agent toward its goal, says only what
`knows` holds, and hangs up with a marker that says whether its goal was met. `model` defaults to
`testModel({ role: "caller" })`. `simulatedCaller.promptVersion` is the version of its prompt.

A `Caller` is any function from the turns so far to the next line, or `null` to hang up. It may
answer `{ line, end: { done, goalMet, reason } }` to say how the call ended for it; after the agent
hung up it is called once more with `hungUp: true` to say whether it was done.

```ts
const caller: Caller = async (turns) => (turns.length < 4 ? await model(myPrompt, turns.at(-1)?.reply ?? "") : null);
```

## `scriptedCaller`

```ts
scriptedCaller(lines: string[]): Caller
```

Says `lines`, one per turn, as a scenario's `turns` does.

## `callerFromCall`

```ts
callerFromCall(record: ConversationRecord, options?: { model? }): Promise<{ goal: string; knows: string; persona?: string }>
```

```ts
const { calls } = loadCalls("exports/calls.jsonl");
const caller = await callerFromCall(calls[0]!);
// { goal: "Find out where order 10422 is and have it sent to the office", knows: "Order 10422. Name Sam Example, phone 0151 0000000." }
```

A simulated caller who wants what the caller of a recorded call wanted, for a scenario's `caller` or
`simulatedCaller`, from one request to `model` (default `testModel()`). It keeps the details the
agent's data needs to find what the caller meant: order, booking and ticket numbers, product names,
dates and times. It replaces personal data with invented data: people's names, phone numbers, email
addresses and street addresses. A model can miss one, so read the caller before you commit it. An
answer that cannot be read is asked for once more; a second one rejects.

## `replayCall`

```ts
replayCall(record: ConversationRecord): Caller
```

The caller of a recorded call again, word for word: a [`scriptedCaller`](#scriptedcaller) of its
caller lines, for a test where the exact words matter. These are the real caller's words, names and
numbers included: a scenario that holds them needs the same care as the export it came from.

## `callersFor`

```ts
callersFor(options?: { count?: number; model?; host? }): Promise<ScenarioCaller[]>
```

```ts
import { callersFor, converse, inParallel, simulatedCaller, startCall } from "curb/testing";

const callers = await callersFor({ count: 10 });
// [{ goal: "Move my appointment on Friday to next week", knows: "Name Alex Example, appointment 4471" },
//  { goal: "Book a haircut, then change it to a beard trim", knows: "Name Sam Example", persona: "Not sure what they want", behaviours: ["changes_mind"] }, ...]
const records = await inParallel(callers, async (caller) => converse(await startCall(), simulatedCaller(caller), { maxTurns: 8 }), { concurrency: 4 });
```

Simulated callers for an agent that has had no calls yet, each `{ goal, knows, persona?, behaviours? }`
for [`simulatedCaller`](#simulatedcaller) or a scenario's `caller`. A call ([`startCall`](#startcall),
closed again) shows what the agent offers on its first turn: its `systemPrompt`, its opening, its
`context` with the skills it can open, and its tools with their descriptions. Then one request to
`model` (default `testModel()`) writes `count` callers (default 20, at most 50):

- most want what the agent is for, spread across its skills and tools;
- about one in five wants that too but is hard to serve: in a hurry, unclear, telling everything at
  once or changing their mind, with a `persona` and `behaviours` to match;
- two or three (one below eight callers) want something the agent cannot do, to see that it says so
  instead of pretending.

Names, phone numbers and addresses are invented; order numbers, services and the like come from the
agent's own demo data where its prompt or tools show it, so its tools find them. They are written in
the language the agent speaks. An entry that cannot run (no goal) is left out and an unknown
behaviour dropped, so fewer than `count` may come back. An answer that holds no caller is asked for
once more; a second one rejects. [`curb review`](./cli/review.md#a-new-agent-simulated-calls) plays
these callers on an agent with no recorded calls.

## `converse`

```ts
converse(call: Call, caller: Caller, options?: { maxTurns?: number; onTurn? }): Promise<ConversationRecord>
```

```ts
const record = await converse(await startCall(), simulatedCaller({ goal: "Book a haircut" }));
```

Plays a whole conversation and returns its record. It ends when the agent or the caller hangs up,
a scripted caller is out of lines, `maxTurns` caller turns were said (default: the script's lines,
else 12), a turn reports an error, or the caller throws.

## `builtInChecks`

```ts
builtInChecks(record: ConversationRecord): ScenarioCheck[]
```

The fixed checks every scenario gets: no turn errors, no empty reply, no fallback line, no repeated
sentence, a clean end, and for a caller that says whether it was done, that the agent did not hang up
on it.

## `checksOf`

```ts
checksOf(record: ConversationRecord, options?: { model? }): ScenarioExpectContext
```

```ts
const { called, said, stateMatches } = checksOf(record);
const checks = [called("book", { service: "haircut" }), said(/tomorrow/i)];
```

The helpers of a scenario's [`expect`](#expect) over a finished conversation, with the same
behaviour: `called`, `calledInOrder`, `notCalled`, `said`, `endedCall`, `stateMatches`, `state`,
`check`, `note`, `context`, `transcript` and `transcriptText`. `ask` and `model` ask
`options.model` (a `testModel`, or any function of its shape); without one they reject, saying so.

## `judge`

```ts
judge(record: ConversationRecord, options?: { findings?, expectations?, model? }): Promise<Judgement>
```

One request to a model that answers questions about the conversation with yes, no or unknown, the
turn that shows it and a quote of that turn, checked against the transcript. It asks whether a
simulated caller reached its goal, each of `findings` (default [`FINDINGS`](#findings)), and each of
`expectations`, a list of sentences or an object of id to sentence. A built-in finding is asked in
its own detailed words; one of yours as its sentence, after the expectations. The result holds every
`answers` entry, the `findings` (each `{ call, kind, turn, quote, reason }`), the `promptVersion`
and the `model`. It rejects in one line when the model cannot be asked or its answer cannot be read
twice. `judge.promptVersion` is the version of its prompt.

```ts
const result = await judge(record, { findings: { ...FINDINGS, canned_closing: "The agent ends a reply with a stock line." } });
```

## `ask`

```ts
ask(record: ConversationRecord, question: string, options?: { model? }): Promise<ScenarioCheck>
```

One question of your own: a check that passes on a yes and fails on a no, with the judge's
`evidence`. An unknown, and a model that cannot be asked, give a check that is `notJudged`: `report`
shows it as `skip`, and it neither passes nor fails.

## `judgeAgreement`

```ts
judgeAgreement(params: { records, labels, findings?, model? }): Promise<JudgeAgreement>
```

```ts
const result = await judgeAgreement({ records: calls, labels: { "c-104": { canned_closing: true }, "c-221": { canned_closing: false } }, findings: { ...FINDINGS, ...naturalness } });
// { findings: [{ id: "canned_closing", withIt: { caught: 1, calls: 1 }, withoutIt: { flagged: 0, calls: 1 }, disagreements: [] }], notJudged: [], model }
```

How far the judge agrees with a person. `labels` maps a record's id (as a report names it: its `id`,
else `<scenario> run <n>`) to findings by id: `true` when the call has it, `false` when it does not.
Every labelled record is judged with `findings` (default [`FINDINGS`](#findings)), which must hold
each labelled finding. Per finding it returns how many calls with it the judge caught, how many
without it it flagged, and the ids of the calls where it disagreed with the label; `notJudged` names
the calls the judge could not be asked about. A label for a record that is not given, or for a
finding that is not asked, throws before any request. The recipe is in
[Build your own tests](./testing-foundation.md#how-far-to-trust-the-judge).

## `FINDINGS`

What the built-in judge looks for, by id, in one sentence each: `asked_again`,
`claimed_without_tool`, `ignored_caller`, `incoherent`, `wrong_tool_use` and `ended_early`. Spread
it, add to it or leave some out in `judge({ findings })`.

## `styleNumbers`

```ts
styleNumbers(records: ConversationRecord[], limits?: StyleLimits)
```

The style numbers of [`curb test`](./testing.md), counted from the transcripts: words per reply,
the share of replies that end on a question or repeat an opening or a closing, the same goodbye,
model steps per turn, refused tool calls per conversation. Each limit set is in `limits`, with
whether it held.

## `groupFindings`

```ts
groupFindings(findings: Finding[], options: { calls: number; model?; kinds?; records? }): Promise<{ patterns; notes }>
```

What `curb review` does with the findings of many calls: one request sorts them into patterns, and
code counts them. Each pattern has a `title`, the distinct `calls` and their `share` of `calls`,
`kinds`, up to three `examples` from different calls, and a `scenario` draft that reproduces it.
`kinds` says what each kind means; default `FINDINGS`.

The model is told to merge one mistake that was found as different kinds. Two patterns it still
split are merged in code when at least four in five calls of the one with fewer calls are calls of
the other, and at least half the words of the shorter title (words of four letters or more, other
than words like "agent", "caller" and "call") are in the other title; the pattern with more calls
keeps its title. With `records`, the calls the findings are about, each draft's caller is written
from the pattern's first example call by [`callerFromCall`](#callerfromcall), one request per
pattern, and the draft names that call as `from`. A call a simulated caller played (`source: "call"`,
with its `caller`, as `converse` returns it) gives that caller as it is, with no request. Without
`records` the model invents the caller.

## `compareRuns`

```ts
compareRuns(before: TestRun, after: TestRun): RunComparison
```

```ts
const comparison = compareRuns(loadRun("20261027T101502118Z-k3f9"), loadRun("latest"));
// { before, after, scenarios: [{ name, file, before: { passed: 1, completed: 5, passRate: 0.2 }, after: { passed: 5, completed: 5, passRate: 1 }, verdict: "better", p: 0.0476 }] }
```

Two saved runs side by side, for every scenario both played (by file and name): its passed and
completed runs in each (errors are left out, as in a pass rate) and a verdict. `curb test` prints it
on its own after a run ([`curb test`](./cli/test.md#since-the-last-version)). The verdict says no
more than the counts carry:

| `verdict` | When |
|---|---|
| `too_few_runs` | Even every run failing before and passing after would not be a clear difference, as with three runs a side or a side with no completed run |
| `better`, `worse` | Fisher's exact test (two-sided) puts the difference below p = 0.1: chance makes one as large less than one time in ten |
| `no_clear_change` | Anything else. `p` is the test's p-value, `null` with too few runs |

## `compare`

```ts
compare(recordsA: ConversationRecord[], recordsB: ConversationRecord[], question: string, options?: { model? }): Promise<SideBySide>
```

```ts
const result = await compare(before, after, "Which agent sounds more like a person on the phone?");
// { a: 1, b: 6, ties: 1, pairs: [{ a: "...", b: "...", winner: "b", reason: "..." }, ...] }
```

A blind side-by-side judgement: for each pair `recordsA[i]` and `recordsB[i]` (as many pairs as the
shorter list holds), one request asks `model` (default `testModel()`) the question, with the two calls
shown in a random order, so the judge cannot learn which side is which. It returns the wins of A and
of B, the ties, and every pair's winner with the model's reason. An answer that cannot be read is
asked for once more; a second one rejects.

## `affectedScenarios`

```ts
affectedScenarios(changed: string[], scenarios: { name, file }[], options?: { root?, runs?, before? }): AffectedScenario[]
```

```ts
const files = execFileSync("git", ["diff", "--name-only", "origin/main..."], { encoding: "utf8" }).split("\n").filter(Boolean);
affectedScenarios(files, [{ name: "orders", file: "src/agent/orders/orders.scenario.ts" }, { name: "greets", file: "src/agent/greets.scenario.ts" }]);
// [{ name: "orders", file: "...", affected: true, why: "it sits in src/agent/orders, which changed" },
//  { name: "greets", file: "...", affected: false, why: "its saved runs opened no skill" }]
```

For each scenario, whether a change that touched `changed` (paths relative to the project) can affect
it, and why: the choice [`curb test --changed`](./cli/test.md#only-what-a-change-affects) makes, from
any list of files, for a CI rule of your own. A file in a skill's folder affects the scenarios in that
folder, those whose saved runs opened the skill or one under it, and those no saved run played;
`agent.tsx`, any other file under `src/` or `context/`, and `package.json` affect every one; tests and
files outside those affect none. `runs` are the saved runs that say which skills each scenario opened
(default: every run in the project's `.curb/test-runs/`), `root` the project (default: the one this
process runs). `before(file)` returns a file as it was before the change, null when it did not exist:
with it, a changed `skill.tsx` whose `meta` is the same affects only its skill; without it, every
scenario, since `meta` is how every conversation is offered the skill.

## `scenario`

```ts
// src/agent/claims.scenario.ts
import { personas, scenario } from "curb/testing";

export default scenario({
  caller: { goal: "Report a broken windscreen", knows: "Policy number 12345678", ...personas.rushed },
  fakes: { open_claim: { ok: true, message: "Claim 42 is open." } },
  runs: 5,
  expectations: ["The agent tells the caller the claim number."],
  expect: ({ called }) => [called("open_claim")],
});
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `name` | `string` | the file name | Shown in the report, matched by `curb test <filter>` |
| `caller` | `{ goal, knows?, language?, persona?, behaviours? }` or `Caller` | | A simulated caller, or a caller of your own. Give this or `turns` |
| `turns` | `string[]` | | Scripted caller lines. Give this or `caller` |
| `maxTurns` | `number` | 12 for a simulated caller | The most caller turns, at most 100 for a simulated caller |
| `client` | object | | Page info the call starts with |
| `experiments` | object | | The variant, by experiment name. An experiment left out is covered by repeated runs |
| `fakes` | list or object | | Tools that must not run for real: a list of [`fake(tool, result)`](#fake), or an object of tool name to result. A result is what its calls get, or a function of the input that returns one. A tool without a fake runs for real on every run, so fake one that sends, books or charges |
| `runs` | `number` | 1 | How often the scenario runs, 1 to 100. `curb test --runs` overrides it. Its tools without a fake run that many times |
| `minPassRate` | `number` | 1 | The share of completed runs that must pass, above 0 and at most 1 |
| `expectations` | `string[]` | | Sentences about the call that a judge answers with yes, no or unknown. A no fails the run. At most 12 |
| `findings` | `Record<string, string>` | none | Findings of your own, by id, one sentence each, asked with the built-in ones. At most 12 |
| `failOn` | `(JudgeFinding \| string)[]` | none | Judge findings that fail a run when found: built-in ones and those of `findings` |
| `style` | `StyleLimits` | none | The highest value accepted per style number, such as `{ wordsP90: 40 }` |
| `expect` | function | | Your own checks, run on the finished conversation |
| `expectRuns` | function | | Your own checks across all runs, called once after the last |

### `fake`

```ts
fake(tool: string | { name: string }, result): ScenarioFakeEntry
```

One entry of a list of `fakes`. `tool` is the tool's name or its value from
[`defineTool`](functions/define-tool.md). Given the value of a tool with a `schema`, TypeScript
checks `result` against what its `onSubmit` returns (any failure, `{ ok: false, ... }`, fits every
tool), and a function's input against the schema.

```ts
import { fake, scenario } from "curb/testing";
import { findOrder, issueRefund } from "./tools.js";

export default scenario({
  turns: ["Please refund order A-1042."],
  fakes: [
    fake(findOrder, { ok: true, data: { id: "A-1042", paid: 49 } }),
    fake(issueRefund, ({ order }) => ({ ok: true, data: { order, refunded: 49 } })),
  ],
  expect: ({ called }) => [called(issueRefund, { order: "A-1042" })],
});
```

A tool given two fakes in one list is an error. `startCall({ fakes })` takes the same list.

### `caller`

| Field | Type | What it does |
|---|---|---|
| `goal` | `string` | What the caller wants from the call |
| `knows` | `string` | Everything the caller can tell the agent. It says no fact that is not here |
| `language` | `string` | The language it speaks. Default: the agent's |
| `persona` | `string` | Who the caller is and how they talk, in plain words |
| `behaviours` | `CallerBehaviour[]` | `everything_at_once`, `changes_mind`, `off_topic`, `impatient`, `asks_to_repeat` |

A `Caller` as `caller` is called for every run with the turns so far and returns the next line,
or `null` to hang up (see [`simulatedCaller`](#simulatedcaller)). The scenario runs `runs` times,
`maxTurns` defaults to 12, and every run is judged without a goal; nothing is checked for invented
facts. A caller that throws makes the run an error.

An id of `findings` is lowercase words joined by underscores, such as `canned_closing`, and is not
a built-in finding, `goal`, `unresolved`, `caller_closed` or `expectation_<n>`. A finding is
counted and reported as a built-in one is, in every report and in the saved run, and `curb review`
asks the findings of every scenario of the project; one id with two sentences in two scenarios is
refused there.

`JudgeFinding` is one of `asked_again`, `claimed_without_tool`, `ignored_caller`, `incoherent`,
`wrong_tool_use` and `ended_early`. `StyleMetric`, the key of a `StyleLimits`, is one of `wordsP50`,
`wordsP90`, `questionShare`, `repeatedOpeningShare`, `repeatedClosingShare`, `sameGoodbyeShare`,
`stepsPerTurn`, `stepsPerTurnMax` and `refusedToolCallsPerRun`.

## `expect`

`expect` gets the conversation and helpers, and returns a list of checks.

| Helper | Passes when |
|---|---|
| `called(tool, input?)` | The agent ran the tool without a refusal. With `input`, only a call with those values counts, at any depth. `tool` is its name or its value from `defineTool` |
| `calledInOrder(...calls)` | The agent ran these tools in this order; other calls may come between. An entry is a tool (name or value) or `[tool, input]` |
| `notCalled(tool)` | The tool (name or value) never ran. A refused or held call still passes |
| `said(text)` | A reply contains the text, ignoring case, or matches the pattern |
| `endedCall()` | The agent ended the call itself |
| `stateMatches(store, expected)` | The store's data at the end of the call has `expected`: an object by the fields it names, a list entry by entry and with the same length |
| `check(name, pass, detail?)` | `pass` is true |
| `ask(question)` | The run's judge answers yes to the sentence. A no fails; an unknown is `notJudged`. Returns a promise |

| Helper | What it gives |
|---|---|
| `note(check)` | The check, marked `reportOnly`: shown as `info` with its result and counted across runs, failing nothing |
| `model(system, input)` | The run's judge model ([`testModel`](#testmodel)): its text. A request that fails makes the run an error |
| `transcriptText` | The call as the judge reads it: the agent's tools and the fenced transcript with every tool call, for `model` |

`state(store)` returns the data of a [`createAgentStore`](./functions/create-agent-store.md) store when
the call ended, by its key and without its actions; it throws when the agent has no such store.
`context` holds the agent's rendered context at the end, line by line. `transcript` holds every turn:
`caller`, `reply`, `toolCalls`, `errors`, `skillPath`, `endedCall`, `steps` and more.

A check that a judge answered carries `evidence`: its `answer` (`yes`, `no` or `unknown`), the `turn`
and a `quote` from it. `ask` and `model` run again on `curb test --rejudge`.

## `expectRuns`

```ts
expectRuns: (runs: ScenarioRunResult[], helpers: { check, note, model }) => ScenarioCheck[] | Promise<ScenarioCheck[]>
```

```ts
expectRuns: (runs, { check }) => {
  const booked = runs.filter((run) => run.record.turns.some((turn) => turn.turn <= 4 && turn.toolCalls.some((call) => call.name === "book_appointment" && call.ok)));
  return [check("books within four caller turns in two of three runs", booked.length >= 2, `${booked.length} of ${runs.length}`)];
},
```

Called once after the last run, and again on `--rejudge`, with every completed run in order (a run
that is an error is left out; with none, it is not called). A `ScenarioRunResult` is the run's
`run` number, `outcome` (`pass` or `fail`), `checks` and `record`, with every helper of
[`expect`](#expect) over its conversation. Its checks are named `across runs: <name>` in the
reports; a failed one fails the scenario, and one made with `note` fails nothing.

## `personas`

```ts
import { personas, scenario } from "curb/testing";

export default scenario({
  caller: { goal: "Book a haircut", knows: "Name Alex Example", ...personas.undecided },
});
```

A simulated caller is more cooperative than the people who call. Each persona is a `persona` text and
the `behaviours` that go with it, to spread into `caller`:

| Persona | The caller | Behaviours |
|---|---|---|
| `personas.rushed` | is short on time and answers in a few words | `impatient` |
| `personas.talkative` | tells the whole story at once and wanders off the subject | `everything_at_once`, `off_topic` |
| `personas.undecided` | thinks out loud and revises a detail | `changes_mind` |
| `personas.hardOfHearing` | is on a bad line and asks for things again | `asks_to_repeat` |

Write your own as `{ persona: "...", behaviours: [...] }` (`CallerPersona`).

## `runHook`

```ts
import { runHook } from "curb/testing";
import { agent } from "./agent.js";

const event = await runHook(agent, "afterCall", { status: "failed" });
```

Runs one of the agent's [hooks](./after-call-code.md) in this process, as a host would: `(call, event)`,
within 120 seconds. The third argument is the fields of the call you care about, or a whole event. It
resolves with the event the hook received and rejects with what the hook threw.

## `buildCallEvent`

```ts
import { buildCallEvent } from "curb/testing";

const event = buildCallEvent("call.evaluated", {
  goals: [{ name: "booked", status: "reached", detail: null }],
});
```

Builds a valid event from a type and the fields you care about. The rest is a plain completed call.
It throws on what no real call produces, such as `goals` on a `call.ended` event or a `transcript` on
a call whose `content` is `not_stored`.

## Coming next: skill tests and the reply store

These are declared in `curb/testing` so their types can be used, and throw until a later version
implements them.

- `scenario` and `startCall` take `hermetic: true` (a tool call without a fake is an error) and
  `now` (the date and time the agent sees). `start` and `spoken` work now: see
  [Starting inside a skill](./testing.md#starting-inside-a-skill).

### Reply store

```ts
import { localReplyStore, projectHost, remoteReplyStore, withReplyStore } from "curb/testing";

const host = withReplyStore(projectHost(), [localReplyStore(), remoteReplyStore()]);
```

`withReplyStore(host, stores)` answers each model request from the first store that holds its
reply and asks the model only on a miss. `localReplyStore({ dir? })` keeps replies as files outside
the checkout; `remoteReplyStore({ url?, token? })` uses a server that speaks the
[reply store protocol](./reply-store.md). A `ReplyStore` is `{ get(key), put(key, reply) }` of
`StoredReply` records.

## Version history

| Version | Changes |
|---|---|
| v1.30.0 | `fake` added; `fakes` takes a list of `fake(tool, result)`. `called`, `notCalled` and `calledInOrder` take a tool's value. A skill that opens without the info its `meta.info` requires fails the turn (`SKILL_INFO_MISSING`) |
| v1.30.0 | Declared: `start`, `spoken`, `hermetic` and `now` on `scenario` and `startCall`, `fake`, `opened`, `notOpened`, tool values in `called`, `notCalled` and `calledInOrder`, and `withReplyStore`, `localReplyStore`, `remoteReplyStore`, `ReplyStore` and `StoredReply` |
| v1.27.0 | `affectedScenarios` added. `judge` does not count `claimed_without_tool` when the tool it names ran and succeeded in the turn of the claim or before (`judge.promptVersion` 4). `simulatedCaller` ends the call once its goal is done, also when asked whether there is anything else (`simulatedCaller.promptVersion` 4) |
| v1.25.0 | `loadCalls` reads a Calls export's tool result given as `{ message, data }` beside the tool call's `ok`, and a line's length from `durationSeconds` |
| v1.25.0 | `callersFor` added, and `Call.systemPrompt`. `groupFindings` takes a played simulated call's caller as its draft's caller, with its `behaviours` |
| v1.25.0 | `callerFromCall`, `replayCall`, `judgeAgreement`, `compareRuns` and `compare` added. `groupFindings` takes `records`, writes each draft's caller from a call of its pattern, and merges near-duplicate patterns. A saved run's `agentVersion` holds a hash of the agent's sources |
| v1.25.0 | `scenario` takes `findings`, `expectRuns` and a `Caller` as `caller`, and `failOn` takes the scenario's own findings. `expect` gets `ask`, `model`, `note` and `transcriptText`; `checksOf` takes `{ model }` for them. `ScenarioRunResult` added |
| v1.25.0 | Layers 1 and 2 added: `startCall`, `loadCalls`, `loadRun`, `saveRun`, `testModel`, `inParallel`, `report`, `passRate`, `projectHost`, `simulatedCaller`, `scriptedCaller`, `converse`, `builtInChecks`, `checksOf`, `judge`, `ask`, `FINDINGS`, `styleNumbers` and `groupFindings`. A check may be `reportOnly` |
| v1.25.0 | `personas` added. `scenario` takes `runs`, `minPassRate`, `expectations`, `failOn`, `style`, and `caller.persona` and `caller.behaviours`. `expect` gets `state`, `stateMatches`, `context` and `calledInOrder`, and `called` matches nested input by the fields it names |
| v1.15.0 | `runHook` and `buildCallEvent` added |
| v1.4.33 | `curb/testing` introduced with `scenario` |

## Next steps

- [Testing guide](./testing.md): `curb check`, `curb say` and `curb test`.
- [Saved test runs](./test-runs.md): the file every `curb test` writes.
- [Build your own tests](./testing-foundation.md): the layers in worked examples.
