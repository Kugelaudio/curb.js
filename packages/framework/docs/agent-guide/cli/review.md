# `curb review`

Reads many calls and reports what goes wrong on them as patterns, most calls first
([Improve an agent from real calls](../improve-from-calls.md#many-calls-find-what-to-fix-first)).
It does not run the agent and changes no file.

```bash
npx curb review [<file or folder>...] [options]
```

Without a path it reviews the last 20 conversations of `curb dev`. A path is a file, or a folder
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
else? When it was not, the finding quotes the agent's last words. A review adds one question,
`unresolved`: the caller did not get what they called for by the end of the call.

A project's own findings are asked too: every `findings` that its scenarios give
([Testing](../testing.md#findings-of-your-own)), with the built-in questions in the same request,
and the patterns know their sentences. One id with two different sentences in two scenarios is
refused, naming both files. A scenario file that cannot be loaded is named in a note.

## Options

| Option | What it does |
|---|---|
| `--last <n>` | Without a path: the last n conversations of `curb dev`. Default 20 |
| `--judge-model <id>` | The judge's model, as for `curb test`: a model of the agent's provider, or `<provider>:<model>` with `openai`, `anthropic` or `kugelaudio`. Default: a small model of the agent's provider |
| `--concurrency <k>` | Calls judged at a time. Default 4, at most 16 |
| `--json` | Prints one JSON object |

## The report

```text
Reviewed 48 call(s): 29 with no finding, 17 with findings, 2 not judged.

1. Ends the call right after booking, before the caller says goodbye
   9 of 46 judged call(s), 20% · ended_early
   call 0f3a51c2, turn 5: "You're all set for Tuesday at ten. Goodbye!" (The caller had not said goodbye.)
   call 77b1e0aa, turn 4: "That is booked. Goodbye." (The caller had asked about parking.)
   Scenario to add:
     caller: { goal: "Book a haircut, then ask what it costs", knows: "Name Alex Example" },
     failOn: ["ended_early"],

2. Promises a callback instead of moving the appointment
   4 of 46 judged call(s), 9% · ignored_caller, unresolved
   call c41d9e07, turn 3: "So is it moved?" (Moving an appointment: only a callback was promised.)
   Scenario to add:
     caller: { goal: "Move an appointment to another day" },
     expectations: ["The agent moves the appointment during the call."],

Not asked of 48 call(s) without recorded tool calls: claimed_without_tool, wrong_tool_use.
Not judged: call 9d2e77b0: HTTP 503: overloaded
Tokens: 95,200 tokens (judge 91,000 in / 4,200 out)
Next: add a pattern's scenario under src/agent/, run `npx curb test` to see it fail, fix the agent, run it again.
```

Code counts the calls of each pattern and picks its quotes, up to three, each from another call.
A quote is in the report only when the call holds those words. A finding the model put into no
pattern, or into two, is listed under its kind with no scenario. More than 300 findings are
sorted from an even sample of 300, and a note says so.

A pattern whose findings are all one built-in kind gets `failOn` in its scenario, any other an
`expectations` sentence. The scenario's names and numbers are invented.

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
      "scenario": { "caller": { "goal": "Book a haircut, then ask what it costs", "knows": "Name Alex Example" }, "failOn": ["ended_early"] }
    }
  ],
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
listed by kind. `throttled` is added when the provider's rate limit slowed the review down.
Progress goes to stderr, so stdout holds only the report.

## Exit codes

| Code | When |
|---|---|
| 0 | Calls were reviewed, with or without findings |
| 1 | No call could be read, or none could be judged |

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
| v1.25.0 | `curb review` introduced. It asks the findings of the project's scenarios too |
