# `curb say`

Runs one caller turn and prints the reply, the tool calls and what changed in the context. Successive
calls continue one conversation ([Testing](../testing.md#2-curb-say-does-it-behave)).

```bash
npx curb say "<text>" [--new] [--client key=value] [--fake <tool>[=<json result>]] [--json]
```

## Options

| Option | What it does |
|---|---|
| `--new` | Starts a new conversation with this turn |
| `--client key=value` | Sets `client.<key>` before the turn. Repeatable |
| `--fake <tool>[=<json result>]` | Fakes a tool. Repeatable |
| `--json` | Prints one JSON object |

## Example

```bash
npx curb say "I want to report a claim"
```

## Version history

| Version | Changes |
|---|---|
| v1.4.33 | `curb say` introduced |
