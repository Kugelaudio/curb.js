# `curb review`

Reads many calls and reports what goes wrong on them as patterns, most calls first, and what the
callers called about, with the scenarios that test it
([Make the agent better](../improve-from-calls.md#the-loop)). On recorded calls it does not run the
agent and changes no file; on a new agent with none it plays simulated calls first
([A new agent](#a-new-agent-simulated-calls)).

```bash
npx curb review [<file or folder>...] [options]
```

Without a path it reviews the last 20 conversations of `curb dev`, and simulates 20 calls when
`curb dev` has recorded none. A path is a file, or a folder
whose `.json`, `.jsonl`, `.md` and `.txt` files are read. A file is recognised by what it holds:

| A file with | Holds tool calls | Says who ended the call |
|---|---|---|
| A [saved test run](../test-runs.md), every conversation in it | yes | yes |
| A Calls export from the KugelAudio dashboard: JSON Lines, one call per line | no | when `endReason` is `agent_completed`, `caller_ended`, `caller_hangup` or `client_disconnect` |
| The output of [`curb conversations --json`](./conversations.md) | yes | only when the agent called `end_call` |
| Text or Markdown with one call, whose lines start with `Caller:`, `User:` or `Customer:` and `Agent:`, `Assistant:` or `Bot:` | no | no |

A file you name that holds none of these is refused with its name; in a folder, such a file (a
README beside the exports) is left out, and the report names it. A call without a transcript is
left out and counted.

The judge of [`curb test`](./test.md) answers its questions about each call, and one more request
sorts the findings into patterns. Each call is asked only what its record can answer:
`claimed_without_tool` and `wrong_tool_use` need recorded tool calls, and `ended_early` needs to
know who ended the call. A real call has no goal written down, so `ended_early` is asked as a fact:
when the agent ended the call, was the caller's last line a goodbye, or that they need nothing
else? When it was not, the finding quotes the agent's last words. A review adds two questions:
`unresolved`, the caller did not get what they called for by the end of the call, and
`called_for`, what the caller called for in a few words, for the coverage below.

A project's own findings are asked too: every `findings` that its scenarios give
([Testing](../testing.md#findings-of-your-own)), with the built-in questions in the same request,
and the patterns know their sentences. One id with two different sentences in two scenarios is
refused, naming both files. A scenario file that cannot be loaded is named in a note.

## A new agent: simulated calls

When no path is given and `curb dev` has recorded no conversation yet, `curb review` plays calls
instead of refusing:

1. [`callersFor`](../testing-api.md#callersfor) starts a call to read what the agent offers on its
   first turn (its system prompt, its opening, the skills it can open and its tools) and asks the
   judge's model once for 20 callers: most want what the agent is for, spread across its skills
   and tools; about four are hard to serve (in a hurry, unclear, changing their mind); two or three
   want what the agent cannot do. Names and data are invented, and order numbers, services and the
   like come from the agent's own demo data where its prompt or tools show it.
2. Each caller is played as `curb test` plays a simulated scenario (`startCall`, `simulatedCaller`,
   `converse`), at most 8 caller turns each, `--concurrency` calls at a time (default 4) on the one
   rate limit every request shares. Progress goes to stderr.
3. Each call goes to the judge the moment it ends, while the others still play. A call that broke
   off on the provider or on the simulated caller says nothing about the agent: it is listed as not
   judged.
4. The calls are saved as a run, `.curb/test-runs/<id>.json`, so `npx curb review <that file>`
   and `npx curb test --rejudge <that file>` read them again. It is saved under the scenario name
   `simulated`, so `curb test` never compares a run of the project's scenarios with it.
5. They are reviewed as recorded calls are: patterns, drafts and what callers called about. A
   draft's caller is the caller that played its call, with no request to write one. A call the turn
   limit cut off is not asked `unresolved`: its caller may still have got there.

The report's first line says so:

```text
These are 20 simulated call(s), because curb dev has recorded no conversation here yet. Saved to .curb/test-runs/20261122T101502118Z-k3f9.json (npx curb review .curb/test-runs/20261122T101502118Z-k3f9.json reads them again).
Reviewed 20 call(s): 16 with no finding, 3 with findings, 1 not judged.
```

With `--json` the object has `simulated: { calls, maxTurns, savedTo }`, and its `usage` counts the
agent's and the simulated callers' tokens too. With recorded conversations, or with a path, nothing
is simulated.

### What a round costs

For 20 simulated calls:

| Step | Requests |
|---|---|
| Callers | 1 (and the agent's greeting, when it speaks first) |
| The calls | Per call and caller turn, one request of the simulated caller and one of the agent, more when the agent calls tools; up to 8 turns, and one more of the caller when the agent hangs up on a line that did not end the call. Some 300 to 400 in all |
| The judge | 20, one per call, each sent as soon as its call ends |
| Patterns and what callers called about | 2, sent at once |

Nothing else runs after the calls: no draft's caller is written, because a simulated call has its
own. On recorded calls a round is the judge requests, the two after them, and one request per
pattern to write its draft's caller from a call. A round of 20 simulated calls takes a few minutes,
most of it the calls themselves; `--concurrency` plays more at a time when the provider allows.

## Options

| Option | What it does |
|---|---|
| `--last <n>` | Without a path: the last n conversations of `curb dev`. Default 20. It does not change how many calls are simulated when there are none |
| `--judge-model <id>` | The judge's model, as for `curb test`: a model of the agent's provider, or `<provider>:<model>` with `openai`, `anthropic` or `kugelaudio`. Default: a small model of the agent's provider |
| `--concurrency <k>` | Calls judged, or simulated calls played, at a time. Default 4, at most 16 |
| `--json` | Prints one JSON object |

## The report

```text
Reviewed 48 call(s): 29 with no finding, 17 with findings, 2 not judged.

1. Ends the call right after booking, before the caller says goodbye
   9 of 46 judged call(s), 20% · ended_early
   call 0f3a51c2, turn 5: "You're all set for Tuesday at ten. Goodbye!" (The caller had not said goodbye.)
   call 77b1e0aa, turn 4: "That is booked. Goodbye." (The caller had asked about parking.)
   Scenario to add (its caller from call 0f3a51c2):
     caller: { goal: "Book a haircut for Tuesday at ten, then ask what it costs", knows: "Name Sam Example" },
     failOn: ["ended_early"],

2. Promises a callback instead of moving the appointment
   4 of 46 judged call(s), 9% · ignored_caller, unresolved
   call c41d9e07, turn 3: "So is it moved?" (Moving an appointment: only a callback was promised.)
   Scenario to add (its caller from call c41d9e07):
     caller: { goal: "Move booking 4471 from Tuesday to Thursday", knows: "Booking 4471. Name Jo Example" },
     expectations: ["The agent moves the appointment during the call."],

What callers called about:
  Topic                Calls  Share  Covered by
  Book an appointment     21    46%  books a haircut
  Move an appointment     14    30%  no scenario
  Ask about prices         9    20%  no scenario
  2 call(s) did not show what the caller called for.

Not asked of 48 call(s) without recorded tool calls: claimed_without_tool, wrong_tool_use.
Not judged: call 9d2e77b0: HTTP 503: overloaded
Tokens: 95,200 tokens (judge 91,000 in / 4,200 out)
Next: add a pattern's scenario under src/agent/, run `npx curb test` to see it fail, fix the agent, run it again.
```

Code counts the calls of each pattern and picks its quotes, up to three, each from another call.
A quote is in the report only when the call holds those words. A finding the model put into no
pattern, or into two, is listed under its kind with no scenario. More than 300 findings are
sorted from an even sample of 300, and a note says so. Two patterns the model split from one
mistake are merged: when most calls of one are calls of the other and their titles name the same
thing ([`groupFindings`](../testing-api.md#groupfindings)).

A pattern whose findings are all one built-in kind gets `failOn` in its scenario, any other an
`expectations` sentence. Its caller is written from the pattern's first call
([`callerFromCall`](../testing-api.md#callerfromcall)), which the report names: it wants what that
caller wanted and keeps the order and booking numbers, product names, dates and times the agent's
data needs, while people's names, phone numbers, email addresses and street addresses are invented.
Read it before you commit it.

**What callers called about** sorts the `called_for` answers into topics with one more request,
and marks each topic with the scenarios whose caller wants it (by its goal, its lines or its name),
or `no scenario`. A call that wanted two things counts under both topics, so the shares can add up
to more than 100%. A topic with many calls and no scenario is the next scenario to write.

With `--json` the same is one object:

```json
{
  "calls": { "reviewed": 48, "withoutFindings": 29, "withFindings": 17, "notJudged": 2, "skipped": 0 },
  "patterns": [
    {
      "title": "Ends the call right after booking, before the caller says goodbye",
      "calls": 9,
      "share": 0.196,
      "findings": 9,
      "kinds": ["ended_early"],
      "examples": [
        { "call": "0f3a51c2", "kind": "ended_early", "turn": 5, "quote": "You're all set for Tuesday at ten. Goodbye!", "reason": "The caller had not said goodbye." }
      ],
      "scenario": { "caller": { "goal": "Book a haircut for Tuesday at ten, then ask what it costs", "knows": "Name Sam Example" }, "failOn": ["ended_early"], "from": "0f3a51c2" }
    }
  ],
  "coverage": {
    "topics": [{ "topic": "Book an appointment", "calls": 21, "share": 0.457, "scenarios": ["books a haircut"] }],
    "unclear": 2
  },
  "notAsked": [{ "questions": ["claimed_without_tool", "wrong_tool_use"], "calls": 48, "why": "without recorded tool calls" }],
  "notJudged": [{ "call": "9d2e77b0", "reason": "HTTP 503: overloaded" }],
  "notes": [],
  "judgeModel": "kugelaudio:qwen3.8-27b",
  "judgePromptVersion": "3",
  "usage": { "agent": null, "caller": null, "judge": { "inputTokens": 91000, "outputTokens": 4200, "cacheReadTokens": 0, "cacheWriteTokens": 0 }, "totalTokens": 95200 },
  "exitCode": 0
}
```

`share` is the pattern's calls divided by the judged calls. `scenario` is `null` for a pattern
listed by kind, and `from` names the call its caller was written from. In `coverage`, a topic's
`share` is of the judged calls too, `scenarios` is empty for `no scenario`, and `unclear` counts the
calls that did not show what the caller called for. `simulated` is there only when the calls
were simulated. `throttled` is added when the provider's rate limit slowed the review down.
Progress goes to stderr, so stdout holds only the report.

## Exit codes

| Code | When |
|---|---|
| 0 | Calls were reviewed, with or without findings |
| 1 | No call could be read, or none could be judged |

A path that holds no call is refused with `CURB_REVIEW_NO_CALLS`; a new agent whose callers could
not be written (the model's answer held none twice) with `CURB_REVIEW_NO_CALLERS`.

## Example

```bash
npx curb review
npx curb review calls-march.jsonl
npx curb review transcripts/ .curb/test-runs/20261027T101502118Z-k3f9.json --json
npx curb review --last 50 --judge-model openai:gpt-5.2
```

## Version history

| Version | Changes |
|---|---|
| v1.25.0 | With no path and no conversation recorded by `curb dev`, it simulates 20 calls, saves them as a run and reviews them (`simulated` in `--json`). Judging starts as each call ends, and patterns and coverage are asked at once |
| v1.25.0 | A draft's caller is written from a call of its pattern; near-duplicate patterns are merged; what callers called about (`coverage`) |
| v1.25.0 | `curb review` introduced. It asks the findings of the project's scenarios too |
