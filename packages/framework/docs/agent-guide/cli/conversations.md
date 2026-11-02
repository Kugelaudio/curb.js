# `curb conversations`

Prints the recorded conversations of `curb dev`, with every tool call and result. `curb say` keeps its
conversation in `.curb/say-session.json` and `curb test` prints its transcripts, so neither is recorded.

```bash
npx curb conversations [--last <n>] [--id <id>] [--json]
```

## Options

| Option | What it does |
|---|---|
| `--last <n>` | The last n conversations. Default 3 |
| `--id <id>` | One conversation |
| `--json` | One JSON object, nothing clipped |

## Example

```bash
npx curb conversations --last 1
```

## Version history

| Version | Changes |
|---|---|
| v1.12.10 | `curb conversations` introduced |
