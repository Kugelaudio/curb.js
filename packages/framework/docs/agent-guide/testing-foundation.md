# Build your own tests

`curb test` and `curb review` are one way to test an agent, built from plain functions of
`curb/testing` that you can use yourself. Use all of it, some of it, or none.

| Layer | What is in it | Use it for |
|---|---|---|
| 1. The foundation | `startCall`, the conversation record (`loadCalls`, `loadRun`, `saveRun`), `testModel`, `inParallel`, `report`, `passRate`, `projectHost`, and `npx curb run` | A call of the agent from any code, a model to think with, many at once, results for CI |
| 2. Building blocks | `simulatedCaller`, `scriptedCaller`, `personas`, `converse`, `builtInChecks`, `checksOf`, `judge`, `ask`, `FINDINGS`, `styleNumbers`, `groupFindings` | Curb's own caller, checks and judge, one at a time |
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
`expect`, and `expectRuns` for checks across all runs. Keep the findings in one module, so every
scenario that imports it asks the same:

```ts
// src/agent/naturalness.ts
/** What sounds unnatural on a call, as findings the judge asks of every call. */
export const naturalness = {
  canned_closing: 'The agent ends a reply with a stock line such as "Is there anything else I can help you with?"',
  missed_mood: "The caller sounded annoyed or rushed, and the agent carried on as if they had not.",
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
  expect: async ({ ask, note }) => [note(await ask("The agent sounds like a person on the phone, not like a form being read out."))],
  // A number across all runs: the agent does not say goodbye the same way every time.
  expectRuns: (runs, { check }) => {
    const goodbyes = runs.flatMap((run) => run.transcript.filter((turn) => turn.endedCall).map((turn) => turn.reply.trim()));
    const different = new Set(goodbyes).size;
    return [check("the goodbye is not the same in every run", goodbyes.length < 2 || different > 1, `${different} different goodbye(s) in ${goodbyes.length} run(s) the agent ended`)];
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
too, so the same two questions run over the calls of `curb dev` or a Calls export. The style number
`sameGoodbyeShare` counts goodbyes too; `expectRuns` is how a number of your own is made, from
anything the runs hold.

## Replace any piece

- **Caller:** any function from the turns so far to the next line, or `null` to hang up: a scenario's `caller`, or `converse(call, caller)`.
- **Judge:** a `testModel` and your own prompt, as in the script above; or `judge(record, { findings, expectations, model })` with another model.
- **Findings:** `findings` in a scenario, or `judge(record, { findings: { ...FINDINGS, yours } })`; leave out the built-in ones you do not want.
- **Checks:** `check(name, pass, detail)` in `expect`, `checksOf(record)` outside a scenario, or any `{ name, pass, detail }`.
- **Report:** `report(groups)` prints for the terminal, Markdown, CI and JSON; or read the records and write your own.

Every signature is in the [Testing API](./testing-api.md).

## Next steps

- [Testing](./testing.md): `curb check`, `curb say` and `curb test`.
- [Improve from real calls](./improve-from-calls.md): `curb review` on many calls.
- [`curb run`](./cli/run.md): a script with the project loaded.
