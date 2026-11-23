# Improve an agent from real calls

The fastest way to improve an agent is to hand a coding agent a call that went wrong, let it
fix the cause, and let it prove the fix by talking to the agent itself. You need no test
script to start: the call is the test. With many calls, first find out which fault comes back
most often: [Many calls](#many-calls-find-what-to-fix-first).

## 1. Copy the transcript

| Where the call happened | How to copy it |
|---|---|
| `curb dev` preview | **Copy for coding agent** in the conversation header: the transcript with the skill map, the tools and the system prompt ([The preview](./preview.md#copy-for-coding-agent)) |
| Hosted agent, dashboard | Open the call on the **Calls** page, open the **Copy or download** menu, choose **Copy transcript**: every turn and tool call as Markdown |
| Hosted agent, coding agent connected | Name the call; the agent reads it with `agent_get_call` and `agent_get_call_timeline` |
| `curb dev`, with no copy button at hand | `npx curb conversations --last 5` |

## 2. Have the coding agent improve it

Paste the transcript into your coding agent in the project folder, with one sentence about
what should have happened:

```text
Here is a call. The agent promised a callback but never recorded one. Find out why, fix the
agent, and keep this call as a scenario so it stays fixed.

<paste the transcript>
```

A project from `npm create curb.js` tells a coding agent how to work: its `AGENTS.md` names
the checks below, and the full guide is in `node_modules/curb/docs/agent-guide/`.

Before it changes a prompt, the coding agent should ask where the behaviour comes from. Most
wrong calls are one of these:

| What happened | Usually the cause | Fix |
|---|---|---|
| Used a tool it should not have had yet | The tool is always rendered | Render it only when state allows it |
| Promised something it cannot do | No tool for it in that state | Render the tool, or stop offering it |
| Opened the wrong skill | The skill's `description` | Rewrite it as a routing rule, with "NOT for" |
| Forgot something from earlier, or asked for it twice | `useState` in a skill that unloaded, or the transcript window | Move it to a store ([Skill lifecycle](./skill-lifecycle.md)) |
| `Unknown tool` after the caller changed topic | The tool is not rendered now: its skill unloaded, or its gate reset | Move the gate's state to a store, or read the skill again |
| Misheard a name | Speech recognition | `boostedPhrases` on `kugelaudio.stt()` |
| Said a name wrong | Text to speech | A [pronunciation dictionary](./pronunciation.md) |

## 3. Let the agent test itself

The coding agent runs the same loop you would, with no browser or microphone:

```bash
npx curb check                                  # does it build?
npx curb say --new "<the caller's first line>"  # replay the call, one line per turn
npx curb say "<the caller's next line>"
npx curb test                                   # do whole conversations still pass?
```

It reads the tool calls and context lines of each turn, not just the reply. `--fake <tool>`
keeps a booking or an email from happening for real. Each `curb say` and `curb test` turn calls
the agent's LLM, so it costs tokens like a real call.

Then it keeps the call, in a scenario file under `src/agent/`, usually in the skill's folder. When
the fix changes the call, keep the caller's lines that still make sense and rewrite the others:

```ts
// src/agent/callback.scenario.ts
import { scenario } from "curb/testing";

export default scenario({
  name: "records the callback it promises",
  turns: ["Nobody is answering at your office", "Yes, call me on 030 555 0100"],
  fakes: { request_callback: { ok: true, message: "The callback is recorded." } },
  expect: ({ called }) => [called("request_callback")],
});
```

`curb test` now fails if this ever breaks again ([Testing](./testing.md)).

## 4. Listen, then ship

Text checks cannot hear timing, interruptions or pronunciation. Run `npm run dev` and call the
agent once. Then put it live with `npx curb deploy` ([Deploying](./deploying.md)), on
[your own servers](./hosting.md), or from a browser project with `agent_publish`.

## Many calls: find what to fix first

One call shows one fault. To see which faults come back, hand Curb all the calls:

| Where the calls are | What to run |
|---|---|
| Hosted agent, dashboard | On the **Calls** page, export a date range as JSONL, then `npx curb review calls.jsonl` |
| `curb dev` preview | `npx curb review`: the last 20 conversations, with no file (`--last <n>` for more) |
| Transcripts as text or Markdown | `npx curb review transcripts/`: one call per file, lines starting with `Caller:` and `Agent:` |
| A [saved test run](./test-runs.md) | `npx curb review .curb/test-runs/<id>.json` |

The judge of `curb test` reads every call, and the report sorts what it found into patterns, the
one on the most calls first ([`curb review`](./cli/review.md)):

```text
Reviewed 48 call(s): 29 with no finding, 17 with findings, 2 not judged.

1. Ends the call right after booking, before the caller says goodbye
   9 of 46 judged call(s), 20% · ended_early
   call 0f3a51c2, turn 5: "You're all set for Tuesday at ten. Goodbye!" (The caller had not said goodbye.)
   Scenario to add (its caller from call 0f3a51c2):
     caller: { goal: "Book a haircut for Tuesday at ten, then ask what it costs", knows: "Name Sam Example" },
     failOn: ["ended_early"],

What callers called about:
  Topic                Calls  Share  Covered by
  Book an appointment     21    46%  books a haircut
  Move an appointment     14    30%  no scenario
```

Read a pattern from top to bottom: what the agent does wrong, on how many of the judged calls, and
the words of up to three calls that show it. Open one of those calls and read the turn before you
believe the title. The table after the patterns says what callers called about and which scenario
tests each topic: a topic with many calls and `no scenario` is untested. Then work through the
patterns one at a time:

1. Put the pattern's scenario into a file under `src/agent/`, inside `scenario({ ... })`. Its
   caller was written from the call the report names and wants what that caller wanted, with the
   same order numbers, dates and products, so the agent's data finds them.
2. Run `npx curb test` with `--runs 5` and see it fail. A scenario that passes does not reproduce
   the pattern: change its caller until it does.
3. Fix the agent (the table in section 2 names the usual causes) and run `npx curb test --runs 5`
   again. The report ends with the pass rates since the run before the fix, and says `better` only
   when that is more than chance ([`curb test`](./cli/test.md#since-the-last-version)).
4. After the fix is live, export the newer calls and review them: the pattern's share should drop.

When the exact words of a call matter, replay them: `replayCall(record)` from
[`curb/testing`](./testing-api.md#replaycall) is a scripted caller of that call's caller lines, and
`callerFromCall(record)` the simulated caller the report drafts.

What a review does and does not do:

- **The calls are sent to the judge's model.** By default that is a model of the project's own
  LLM provider; `--judge-model` picks another.
- **The report quotes the calls.** A quote can hold a name or a number a caller said, so read a
  report before you share it.
- **A scenario draft keeps the call's order numbers and the like, and invents its personal
  data.** People's names, phone numbers, email addresses and street addresses are replaced; a
  model wrote it, so check it for real data before you commit it. A replayed call holds the
  caller's real words: treat it like the export.
- **An export without tool calls cannot show `claimed_without_tool` or `wrong_tool_use`.** The
  report says of how many calls they were not asked.
- **A judge can be wrong.** That is why every pattern carries quotes to read, and why a number
  in the report is counted by code, not by the model.
- **Your own findings are asked too.** The `findings` your scenarios give, such as a stock
  closing line, are asked of every real call beside the built-in ones
  ([Build your own tests](./testing-foundation.md#naturalness-on-the-ready-made-path)).

With a coding agent, the whole loop is one request:

```text
Run `npx curb review calls.jsonl --json`. Take the pattern on the most calls, add its scenario,
make it fail with `npx curb test --runs 5`, fix the agent and run the test again until the report
says it is better since the run before the fix.
```

## Next steps

- [Testing an agent](./testing.md): every flag and check.
- [`curb review`](./cli/review.md): the files it reads, its report and its JSON.
- [The preview](./preview.md): rewind, per-message audio and what the model read.
- [Diagnostics](./diagnostics.md): every code `curb check` can report.
