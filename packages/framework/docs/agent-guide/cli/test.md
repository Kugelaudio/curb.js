# `curb test`

Runs `src/**/*.scenario.ts`, or those matching a filter, in text, and reports pass or fail per
scenario ([Testing](../testing.md#3-curb-test-do-whole-conversations-work)).

```bash
npx curb test [filter] [options]
```

## Options

| Option | What it does |
|---|---|
| `--runs <n>` | Runs every scenario `n` times, 1 to 100, in place of its own `runs`, and reports rates. A scripted scenario must pass every run unless it sets `minPassRate` |
| `--concurrency <k>` | Conversations at a time, across all scenarios and their runs. Default 4, at most 16. The report keeps the scenarios' order |
| `--caller-model <id>` | The model that plays the caller: a model of the agent's provider, or `<provider>:<model>` with `openai`, `anthropic` or `kugelaudio`. Default: a small model of the agent's provider |
| `--judge-model <id>` | The same for the judge |
| `--report <file>` | Also writes the report as Markdown. `GITHUB_STEP_SUMMARY` gets it too |
| `--rejudge <run>` | Checks the conversations of a [saved run](../test-runs.md) again without running the agent: `latest`, a run's id, or a file |
| `--json` | Prints one JSON object |

## Since the last version

After a run, `curb test` looks for the newest saved run of another version of the agent that played
every scenario this one played (by file and name), and prints one block after `Saved:`:

```text
Since 20261027T101502118Z-k3f9 (uncommitted changes, 2 hours ago):
  asks for the order once  1/5 (20%) -> 5/5 (100%)  better
  reads the hours          1/1 (100%) -> 1/1 (100%)  too few runs to tell
```

Another version is another hash of the agent's sources: the files under `src/` and `context/`,
without scenarios and tests ([`agentVersion`](../test-runs.md#the-file)), so editing a scenario is
no new version. The heading names the earlier run, its commit or `uncommitted changes`, and its
age. Each line is a scenario's passed runs of its completed ones then and now, and a verdict:
`better` or `worse` when Fisher's exact test puts the difference below p = 0.1, `too few runs to
tell` when even every run failing then and passing now would not be that clear (as with three
runs a side), and `no clear change` otherwise. `--json` holds it as `since`, the Markdown report as
a table. Nothing is printed on the first run, outside a git repository, and on `--rejudge`.
[`compareRuns`](../testing-api.md#compareruns) makes the same comparison of any two runs.

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
| v1.25.0 | `--runs` runs scripted scenarios that many times too |
| v1.25.0 | A provider that keeps timing out ends the run within about two deadlines, and a scenario with too many errors to be assessed starts no more runs |
| v1.25.0 | The report compares a run with the last run of another version of the agent (`since`) |
| v1.25.0 | A scenario's own findings, notes, checks across runs (`across runs:`) and a caller function are reported |
| v1.25.0 | Repeated runs with rates, the judge's findings, style numbers, saved runs and `--rejudge`, a Markdown report, and exit code 2 |
| v1.4.33 | `curb test` introduced |
