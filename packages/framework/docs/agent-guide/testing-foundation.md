# Build your own tests

`curb test` and `curb review` are one way to test an agent, built from plain functions of
`curb/testing` that you can use yourself. Use all of it, some of it, or none.

| Layer | What is in it | Use it for |
|---|---|---|
| 1. The foundation | `startCall`, the conversation record (`loadCalls`, `loadRun`, `saveRun`), `testModel`, `inParallel`, `report`, `passRate`, `projectHost`, and `npx curb run` | A call of the agent from any code, a model to think with, many at once, results for CI |
| 2. Building blocks | `simulatedCaller`, `scriptedCaller`, `personas`, `callerFromCall`, `replayCall`, `converse`, `builtInChecks`, `checksOf`, `judge`, `ask`, `FINDINGS`, `judgeAgreement`, `styleNumbers`, `groupFindings`, `compareRuns`, `compare` | Curb's own caller, checks and judge, one at a time |
| 3. The ready-made path | `scenario()` files that `npx curb test` runs, and `npx curb review` | Testing that works with no code beyond a scenario |

Each example below runs as written in a project from `npm create curb.js`, on its agent Juno and
the key of `npx curb login`.

## A test in vitest, with no scenario

Add vitest to the project:

```bash
npm i -D vitest
```

```ts
// test/tasks.test.ts
import { startCall } from "curb/testing";
import { expect, it } from "vitest";
import type { Task } from "../src/agent/agent.js";

it("puts the milk on the list", async () => {
  const call = await startCall();
  await call.say("Put buy milk on my list, please.");
  const { tasks } = call.state<{ tasks: Task[] }>("juno");
  expect(tasks.filter((task) => task.title.includes("milk"))).toHaveLength(1);
  call.close();
}, 60_000);
```

```bash
npx vitest run
```

`startCall` plays a real call of the agent in text and prepares the project itself (its `.env`,
the login key), so vitest needs no setup. `call.state` reads a store, `call.say` returns the turn
with its tool calls, and `checksOf(call.record())` gives the helpers of a scenario's `expect`.

## A script with a caller and a judge of your own

```ts
// scripts/harness.ts
import { inParallel, report, saveRun, startCall, testModel, type ConversationRecord, type ScenarioCheck } from "curb/testing";

const cases = [
  { name: "a busy morning", wants: "buy milk, call the dentist and send the invoice" },
  { name: "one errand", wants: "pick up the parcel" },
];
const model = await testModel();

// Our caller: our own prompt, one line per turn, at most four turns.
async function play(testCase: (typeof cases)[number]): Promise<ConversationRecord> {
  const call = await startCall();
  let line: string | null = `Hi, please put this on my list: ${testCase.wants}.`;
  for (let turns = 0; line !== null && !call.ended && turns < 4; turns += 1) {
    const { reply } = await call.say(line);
    const next = await model(
      `You are calling a planning assistant to have it put this on your list: ${testCase.wants}. Answer its last reply in one short spoken sentence. Once everything is on the list, say only: bye`,
      reply,
    );
    line = /^bye\b/i.test(next.trim()) ? null : next;
  }
  const record = call.record();
  call.close();
  return record;
}

// Our judge: our own rubric, one question per call.
async function rate(record: ConversationRecord): Promise<ScenarioCheck[]> {
  const transcript = record.turns.map((turn) => `Caller: ${turn.caller ?? "(none)"}\nAgent: ${turn.reply}`).join("\n");
  const verdict = await model("Did the agent confirm each task it put on the list? Answer yes or no, then say why in one sentence.", transcript);
  return [{ name: "confirms each task", pass: /^yes/i.test(verdict.trim()), detail: verdict }];
}

const records = await inParallel(cases, play, { concurrency: 2 });
const checks = await inParallel(records, rate, { concurrency: 2 });
saveRun(records, { name: "day planning", checks });
process.exitCode = report(cases.map((testCase, index) => ({ name: testCase.name, checks: checks[index] })));
```

```bash
npx curb run scripts/harness.ts
npx curb review .curb/test-runs
```

`curb run` runs the script with the project loaded and exits with its exit code. `saveRun` writes
the conversations to `.curb/test-runs/`, where `curb review` reads them and Curb's judge looks for
the problems it knows. In CI, add a step to the project's workflow
(`.github/workflows/curb-test.yml`):

```yaml
      - name: npx curb run scripts/harness.ts
        if: env.KUGELAUDIO_API_KEY != ''
        run: npx curb run scripts/harness.ts
```

On GitHub Actions `report` also writes its Markdown to the job summary.

## Naturalness on the ready-made path

A scenario uses the same building blocks: findings of your own, `ask`, `model` and `note` in
`expect`, and `expectRuns` for checks across all runs. Write each finding and `ask` question about
one concrete thing a line of the call shows, and say it positively: the judge must quote the call,
so "sounds like a person" is often answered unknown, and "never says X" is easy for a judge to get
backwards. Ask "says X" as a finding, "does Y" as a question. Keep the findings in one module, so
every scenario that imports it asks the same:

```ts
// src/agent/naturalness.ts
/** What sounds unnatural on a call, as findings the judge asks of every call. */
export const naturalness = {
  canned_closing: 'The agent ends a reply with a stock line such as "Is there anything else I can help you with?"',
  missed_mood: "The caller says they are in a hurry, and the agent's next reply is three or more sentences long.",
};
```

```ts
// src/agent/natural-planning.scenario.ts
import { personas, scenario } from "curb/testing";
import { naturalness } from "./naturalness.js";

export default scenario({
  name: "plans the day naturally",
  caller: {
    goal: "Get two tasks onto your list: buy milk and call the dentist.",
    knows: "Your tasks for today: buy milk, call the dentist.",
    ...personas.rushed,
  },
  runs: 3,
  minPassRate: 0.66,
  // Asked of every run beside the built-in findings; canned_closing fails a run, missed_mood is only reported.
  findings: naturalness,
  failOn: ["canned_closing"],
  // One question of our own, reported and counted, failing nothing.
  expect: async ({ ask, note }) => [note(await ask("The agent says back each task it put on the list."))],
  // A number across all runs that no built-in one counts: how soon the first task is on the list,
  // read from each run's record. Within four caller turns, in at least two of three runs.
  expectRuns: (runs, { check }) => {
    const quick = runs.filter((run) => {
      const added = run.record.turns.find((turn) => turn.toolCalls.some((call) => call.name === "add_task" && call.ok));
      return added !== undefined && added.turn <= 4;
    }).length;
    return [check("a task is on the list within four caller turns", quick >= 2, `${quick} of ${runs.length} run(s)`)];
  },
});
```

```bash
npx curb test natural
npx curb review
```

`curb test` reports `canned_closing` and `missed_mood` on `find` lines with their rate, as it
reports its own findings, the noted question as `info` with how many runs said yes, and the check
of `expectRuns` under `across runs:`. `curb review` asks the project's own findings of real calls
too, so the same two questions run over the calls of `curb dev` or a Calls export. The style
numbers already count replies, questions, repeats and goodbyes; `expectRuns` is how a number of
your own is made, from anything the runs hold.

## Did my change help?

`curb test` answers on its own. After a run it looks for the newest saved run of another version of
the agent (another hash of the files under `src/` and `context/`, scenarios and tests left out) that
played the same scenarios, and prints the pass rates then and now:

```text
Since 20261027T101502118Z-k3f9 (uncommitted changes, 2 hours ago):
  asks for the order once  1/5 (20%) -> 5/5 (100%)  better
  reads the hours          1/1 (100%) -> 1/1 (100%)  too few runs to tell
```

So run `npx curb test` before the fix and after it; nothing needs stashing. `better` and `worse` are
said only when chance makes such a difference less than one time in ten (Fisher's exact test); give
a scenario `runs: 5` or more, or run `npx curb test --runs 5`, for a verdict. The same comparison is
`compareRuns(before, after)` on any two saved runs ([Testing API](./testing-api.md#compareruns)).

For a question no check answers, such as which version sounds more natural, put the calls of two
runs side by side. `compare` shows each pair to a model in a random order, so it cannot learn which
is which:

```ts
// scripts/side-by-side.ts
import { compare, loadRun } from "curb/testing";

const of = (run: string) => loadRun(run).conversations.filter((call) => call.scenario.name === "plans the day naturally");
const { a, b, ties } = await compare(of(process.argv[2]!), of("latest"), "Which agent sounds more like a person on the phone?");
console.log(`before ${a}, after ${b}, the same ${ties}`);
```

```bash
npx curb run scripts/side-by-side.ts 20261027T101502118Z-k3f9
```

## How far to trust the judge

Before a finding of your own fails runs, or before you pick a cheaper judge model, measure the judge
against a person. Label a few saved calls, with `true` where the call has the finding:

```json
{
  "plans the day naturally run 1": { "canned_closing": true, "missed_mood": false },
  "plans the day naturally run 2": { "canned_closing": false },
  "plans the day naturally run 3": { "canned_closing": true, "missed_mood": true }
}
```

```ts
// scripts/agreement.ts
import { readFileSync } from "node:fs";
import { FINDINGS, judgeAgreement, loadRun, testModel } from "curb/testing";
import { naturalness } from "../src/agent/naturalness.js";

const labels = JSON.parse(readFileSync("labels.json", "utf8"));
const model = await testModel({ model: process.argv[2] });
const { findings, notJudged } = await judgeAgreement({ records: loadRun().conversations, labels, findings: { ...FINDINGS, ...naturalness }, model });
console.table(findings.map(({ id, withIt, withoutIt, disagreements }) => ({ id, caught: `${withIt.caught}/${withIt.calls}`, "flagged wrongly": `${withoutIt.flagged}/${withoutIt.calls}`, disagreements: disagreements.join(", ") })));
if (notJudged.length > 0) console.log("not judged:", notJudged);
```

```bash
npx curb run scripts/agreement.ts                    # the default judge model
npx curb run scripts/agreement.ts openai:gpt-5.2     # another one
```

Pick the cheapest model that catches the calls with the finding and flags few without it. Where it
disagrees, read those calls: a finding the judge reads differently than you do usually needs a
sharper sentence, such as what counts and what does not.

## Replace any piece

- **Caller:** any function from the turns so far to the next line, or `null` to hang up: a scenario's `caller`, or `converse(call, caller)`.
- **Judge:** a `testModel` and your own prompt, as in the script above; or `judge(record, { findings, expectations, model })` with another model.
- **Findings:** `findings` in a scenario, or `judge(record, { findings: { ...FINDINGS, yours } })`; leave out the built-in ones you do not want.
- **Checks:** `check(name, pass, detail)` in `expect`, `checksOf(record)` outside a scenario, or any `{ name, pass, detail }`.
- **Report:** `report(groups)` prints for the terminal, Markdown, CI and JSON; or read the records and write your own.

Every signature is in the [Testing API](./testing-api.md).

## Next steps

- [Testing](./testing.md): `curb check`, `curb say` and `curb test`.
- [Make the agent better](./improve-from-calls.md): `curb review` on many calls, or on simulated ones.
- [`curb run`](./cli/run.md): a script with the project loaded.
