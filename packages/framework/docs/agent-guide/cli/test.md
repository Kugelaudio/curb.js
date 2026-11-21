# `curb test`

Runs `src/**/*.scenario.ts`, or those matching a filter, in text, and reports pass or fail per
scenario ([Testing](../testing.md#3-curb-test-do-whole-conversations-work)).

```bash
npx curb test [filter] [options]
```

## Options

| Option | What it does |
|---|---|
| `--runs <n>` | Runs every scenario with a simulated caller `n` times, 1 to 100, and reports rates. Scripted scenarios run once unless they set `runs` |
| `--concurrency <k>` | Conversations at a time, across all scenarios and their runs. Default 4, at most 16. The report keeps the scenarios' order |
| `--caller-model <id>` | The model that plays the caller: a model of the agent's provider, or `<provider>:<model>` with `openai`, `anthropic` or `kugelaudio`. Default: a small model of the agent's provider |
| `--judge-model <id>` | The same for the judge |
| `--report <file>` | Also writes the report as Markdown. `GITHUB_STEP_SUMMARY` gets it too |
| `--rejudge <run>` | Checks the conversations of a [saved run](../test-runs.md) again without running the agent: `latest`, a run's id, or a file |
| `--json` | Prints one JSON object |

## Exit codes

| Code | When |
|---|---|
| 0 | Every scenario passed |
| 1 | A scenario failed or could not be loaded, or no scenario was found or matched |
| 2 | None failed, but too many runs of a scenario were errors |

## Example

```bash
npx curb test claims
npx curb test --runs 5
npx curb test --rejudge latest --judge-model openai:gpt-5.2
```

## Version history

| Version | Changes |
|---|---|
| v1.25.0 | Repeated runs with rates, the judge's findings, style numbers, saved runs and `--rejudge`, a Markdown report, and exit code 2 |
| v1.4.33 | `curb test` introduced |
