# Saved test runs

Every `curb test` saves the conversations it played to one JSON file,
`.curb/test-runs/<id>.json`, in the project; [`saveRun`](./testing-api.md#saverun-and-loadrun)
saves conversations of your own the same way. `curb test --rejudge <run>` reads one back and checks
its conversations again without running the agent ([Testing](./testing.md#saved-runs-and-re-judging)).
The newest 20 runs are kept, and `.curb/` is in a new project's `.gitignore`.

```bash
npx curb test --rejudge latest                         # the newest run
npx curb test --rejudge 20261027T101502118Z-k3f9       # a run by its id
npx curb test --rejudge reports/nightly.json           # a file, relative to the project
```

A run's id is the time it started and four random characters, so ids sort by time.

## The file

```json
{
  "format": "curb.test-run",
  "version": 1,
  "id": "20261027T101502118Z-k3f9",
  "createdAt": "2026-10-27T10:15:02.118Z",
  "curb": "1.25.0",
  "agentVersion": { "commit": "3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a", "dirty": false, "sources": "9b1e4c07a2d35f68" },
  "complete": true,
  "models": { "agent": "kugelaudio:qwen3.8-27b", "caller": "kugelaudio:qwen3.8-27b", "judge": "kugelaudio:qwen3.8-27b" },
  "callerPromptVersion": "2",
  "judgePromptVersion": "2",
  "maxErrorRate": 0.34,
  "scenarios": [
    {
      "name": "books a haircut",
      "file": "src/agent/booking.scenario.ts",
      "mode": "simulated",
      "runs": 5,
      "minPassRate": 1,
      "expectations": ["The agent tells the caller the booking number."],
      "failOn": [],
      "style": {}
    }
  ],
  "conversations": []
}
```

| Field | What it holds |
|---|---|
| `format`, `version` | `"curb.test-run"` and `1`. A file of another format or version is refused with what it is |
| `agentVersion` | The version of the agent the run played: the project's git `commit`, whether the project's files differed from it (`dirty`), and `sources`, a hash of every file under `src/` and `context/` but scenarios (`*.scenario.ts`) and tests (`*.test.*`, `*.spec.*`), which tells two runs on one commit with different edits apart. `curb test` compares a run with the last one of another `sources` ([`curb test`](./cli/test.md#since-the-last-version)). `null` outside a git repository; absent in runs saved before it was recorded, and `sources` in runs saved before it was |
| `complete` | `false` while scenarios are still running |
| `rejudgedFrom` | The id of the run whose conversations these are, on a re-judged run |
| `models` | The model that played each part, as `provider:model` |
| `callerPromptVersion`, `judgePromptVersion` | The versions of the simulated caller's and the judge's prompt. Answers from different versions are not the same measurement |
| `maxErrorRate` | The share of a scenario's runs that may be errors; `null` in a run `saveRun` wrote without one |
| `scenarios` | What each scenario asked of its runs when it ran. Conversations `saveRun` saved without a scenario are under one of their own, with `file` empty |
| `conversations` | One conversation record per run |

## A conversation record

```json
{
  "format": "curb.conversation",
  "version": 1,
  "source": "scenario",
  "scenario": { "name": "books a haircut", "file": "src/agent/booking.scenario.ts", "mode": "simulated", "run": 2 },
  "caller": { "goal": "Book a haircut", "knows": "Name Alex Example", "persona": "...", "behaviours": ["changes_mind"] },
  "experiments": { "greeting": "casual" },
  "startedAt": "2026-10-27T10:15:04.502Z",
  "durationMs": 13400,
  "turns": [
    {
      "turn": 1,
      "caller": "Hi, I'd like a haircut.",
      "reply": "Sure. Which day suits you?",
      "fallback": null,
      "confirmation": null,
      "toolCalls": [{ "name": "list_free_slots", "input": { "date": "2026-10-28" }, "ok": true, "result": { "ok": true, "message": "Free: 09:00, 10:00." } }],
      "errors": [],
      "contextDiff": [],
      "skillPath": "",
      "skipped": false,
      "endedCall": false,
      "steps": 2
    }
  ],
  "tools": [{ "name": "list_free_slots", "description": "List the free start times on a given day." }],
  "ending": { "by": "agent", "unsaid": [], "maxTurns": 12, "caller": { "done": true, "goalMet": true, "reason": "the booking was confirmed" } },
  "endState": { "stores": { "calendar": { "appointments": [] } }, "context": ["content: No bookings on this call."], "skillPath": "" },
  "unusedFakes": [],
  "usage": { "agent": { "inputTokens": 6820, "outputTokens": 96, "cacheReadTokens": 0, "cacheWriteTokens": 0 }, "caller": null, "judge": null, "totalTokens": 6916 },
  "assessment": { "outcome": "pass", "checks": [], "notes": [], "judge": { "promptVersion": "2", "model": "kugelaudio:qwen3.8-27b", "answers": [] } }
}
```

| Field | What it holds |
|---|---|
| `source` | Where the conversation comes from: `"scenario"` (`curb test`), `"call"` (`startCall`), or, for a call `loadCalls` read, `"dev"`, `"calls-export"` or `"transcript"` |
| `id` | How a report names the call, where its source names it. Optional |
| `scenario` | The scenario and which of its runs this is, from 1. Every conversation of a run file has one |
| `caller` | The simulated caller as it was defined; `null` for scripted lines and any other caller |
| `experiments` | The variant the call had in each of the agent's experiments |
| `turns` | Every turn: the caller's line (`null` for the agent's opening), what the caller heard, each tool call with its input and result, the turn's errors, and how many model steps it took |
| `tools` | Every tool the agent was offered at some point of the call, as `{ "name", "description" }`, without the framework's own. The judge reads it. Optional: a record without it is judged without it |
| `ending.by` | Who or what ended it: `agent`, `caller`, `script`, `max_turns`, `error` or `simulator`; `null` when its source does not say |
| `ending.caller` | What the simulated caller said about the end: whether it was `done`, whether its goal was met, and why. `null` when it did not say |
| `ending.providerError` | `true` when a failed request to the agent's LLM provider stopped it |
| `endState` | The data of the agent's stores, its rendered context and its active skill when the call ended |
| `usage` | Tokens per part, `null` where the provider reported none |
| `recordsToolCalls` | `false` when its source holds no tool calls (a Calls export, a transcript). Optional |
| `assessment` | What the checks and the judge made of it when the file was written; absent on a conversation `saveRun` saved without checks: the `outcome` (`pass`, `fail` or `error`), the `error` with its `kind`, every check, and every answer of the judge with its `turn` and `quote` |

Everything a check, the judge or a style number reads is in `turns`, `ending` and `endState`. A
re-judge reads only those, so it gives the same result as the run did when nothing was changed, apart
from what the judge answers differently.

## What a re-judge applies

A scenario that is still in the project, by its file and name, brings its `expect`, `expectRuns`,
`expectations`, `findings`, `failOn`, `style` and `minPassRate` as they are now. For one that is
gone, the settings saved in `scenarios` apply (`findings` among them, when it gave some), its
`expect` and `expectRuns` are left out, and the report notes it. The judge runs again on every
conversation it would be asked about, with `--judge-model` when given, as many at a time as
`--concurrency` allows. The agent and the simulated
caller are not run: their tokens in `usage` are the ones the first run used, and `--runs` and
`--caller-model` change nothing. `--judge-model`, `--report`, `--json` and a filter apply as on a
run.

## Version history

| Version | Changes |
|---|---|
| v1.25.0 | `agentVersion` holds `sources`, a hash of the agent's sources |
| v1.25.0 | A scenario's entry in `scenarios` holds its own `findings`, and `failOn` may name them |
| v1.25.0 | A run records `agentVersion`; `saveRun` and `loadRun` write and read runs; a conversation record may have another `source`, an `id`, `recordsToolCalls`, a `null` `ending.by` and `startedAt` |
| v1.25.0 | Saved test runs and `curb test --rejudge` introduced |

## Next steps

- [Testing guide](./testing.md): scenarios, checks and how to read a report.
- [`curb test`](./cli/test.md): every option.
