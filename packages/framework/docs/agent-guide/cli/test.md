# `curb test`

Runs `src/**/*.scenario.ts`, or those matching a filter, and exits 1 when one fails
([Testing](../testing.md#3-curb-test-do-whole-conversations-work)).

```bash
npx curb test [filter] [--json]
```

## Options

| Option | What it does |
|---|---|
| `--json` | Prints one JSON object |

## Example

```bash
npx curb test claims
```

## Version history

| Version | Changes |
|---|---|
| v1.4.33 | `curb test` introduced |
