# Make the agent better

One short loop makes an agent better, for a brand-new agent and after it went live, and a coding
agent can run it on its own: find the problems that come back most, reproduce the top one as a
scenario, fix it, and see `curb test` say whether the fix helped. One call that went wrong is a
shortcut into the same loop: [Improve from one call](#improve-from-one-call).

## The loop

```bash
npx curb review                      # 1. the problems that come back most
# 2. take the top pattern
# 3. add its scenario as src/agent/<name>.scenario.ts
npx curb test <name> --runs 5        # 4. see it fail
# 5. fix the agent
npx curb test <name> --runs 5        # 6. better, or no clear change?
npx curb test                        #    and nothing else broke
git commit -am "Keep the task list open until the caller is done"   # 7. and again from 1
```

1. **`npx curb review`** finds the problems. What it reads depends on what there is:

   | The agent has | `curb review` reads |
   |---|---|
   | No recorded calls yet (a new agent) | 20 simulated calls it plays itself: callers written from the agent's prompt, skills and tools by [`callersFor`](./testing-api.md#callersfor), most wanting what the agent is for, a few hard to serve, and two or three wanting what it cannot do. They are saved as a run, and the report's first line says so |
   | Conversations in the `curb dev` preview | The last 20 (`--last <n>` for more) |
   | Calls of the hosted agent | `npx curb review calls.jsonl`: an export of the dashboard's **Calls** page |

   The report lists the patterns, the one on the most calls first, each with quotes and a scenario
   to add ([Many calls](#many-calls-find-what-to-fix-first)).
2. **Take the top pattern.** Open one of its quoted calls and read the turn before you believe the
   title.
3. **Add its scenario** as `src/agent/<name>.scenario.ts`, the drafted fields inside
   `scenario({ ... })` from `"curb/testing"`.
4. **`npx curb test <name> --runs 5`, and see it fail.** A scenario that passes does not reproduce
   the pattern: sharpen its caller until it fails. Five runs, because a model does not answer the
   same way twice, and because step 6 can only call a change `better` from enough runs.
5. **Fix the agent**, not the scenario: the table in [section 2](#2-have-the-coding-agent-improve-it)
   names the usual causes.
6. **`npx curb test <name> --runs 5` again**, and read the `Since` lines at the end: they compare
   the pass rate with the run before the fix and say `better` only when that is more than chance,
   or `no clear change` ([`curb test`](./cli/test.md#since-the-last-version)). Then `npx curb test`
   checks that nothing else broke.
7. **Commit**, and start again at 1. After the fix is live, review the newer calls: the pattern's
   share should drop.

**What a round costs.** A review of 20 simulated calls is one request for the callers, the calls
themselves (up to 8 caller turns each: one request of the simulated caller and one or more of the
agent per turn, some 300 to 400 requests in all), one judge request per call, and one request each
to sort the findings and what the callers called about ([`curb review`](./cli/review.md#what-a-round-costs)).
It takes a few minutes. `curb test <name> --runs 5` is five conversations and five judge requests.

A coding agent takes the whole loop as one request:

```text
Make the agent better: run `npx curb review`, take the top pattern, add its scenario, make it fail
with `npx curb test <name> --runs 5`, fix the agent, and run the test again until the Since lines
say better. Commit, then do the next pattern.
```

## Improve from one call

The fastest way to fix one call that went wrong is to hand a coding agent that call, let it fix the
cause, and let it prove the fix by talking to the agent itself. You need no test script to start:
the call is the test.

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
| Nowhere yet: a new agent | `npx curb review`: 20 simulated calls, played, saved as a run and reviewed |
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
patterns one at a time with [the loop](#the-loop), from step 2. A draft's caller was written from
the call the report names and wants what that caller wanted, with the same order numbers, dates and
products, so the agent's data finds them; on a simulated call it is the caller that played it.

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
- **Simulated calls are not real callers.** They are more patient and more cooperative than
  people, and a caller who wanted what the agent cannot do may show as `unresolved` although the
  agent said so plainly: read the quotes. A simulated call that the turn limit cut off is not asked
  `unresolved`. Once the preview has conversations or the hosted agent has calls, review those.

## Next steps

- [Testing an agent](./testing.md): every flag and check.
- [`curb review`](./cli/review.md): the files it reads, its report and its JSON.
- [The preview](./preview.md): rewind, per-message audio and what the model read.
- [Diagnostics](./diagnostics.md): every code `curb check` can report.
