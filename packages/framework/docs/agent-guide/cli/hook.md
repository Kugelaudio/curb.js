# `curb hook`

Runs the agent's `afterCall` or `afterEvaluation` once, in this process, with the project's `.env`.
Nothing else fires a hook on your machine. Exits 1 when the hook failed
([After-call code](../after-call-code.md#try-it-locally)).

```bash
npx curb hook <afterCall|afterEvaluation> --call <file>
```

## Options

| Option | What it does |
|---|---|
| `--call <file>` | A JSON file holding a whole event, or a call with the fields the hook reads |

## Example

```bash
npx curb hook afterCall --call fixtures/call.json
```

## Version history

| Version | Changes |
|---|---|
| v1.15.0 | `curb hook` introduced |
