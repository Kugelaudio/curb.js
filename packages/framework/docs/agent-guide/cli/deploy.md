# `curb deploy`

Uploads the project and makes it the agent's live production deployment. The first run picks or creates
the agent and saves it in `.curb/link.json` ([Deploying](../deploying.md)).

```bash
npx curb deploy [--agent <id>] [--no-activate] [--json]
```

## Options

| Option | What it does |
|---|---|
| `--agent <id>` | Chooses the agent |
| `--no-activate` | Builds without going live |
| `--json` | Prints the result as one JSON line |

## Example

```bash
npx curb deploy --agent <id> --json
```

## Version history

| Version | Changes |
|---|---|
| v1.12.10 | `--json` added, and takes a host-issued token through `CURB_PLATFORM_TOKEN_FILE` |
| v1.3.4 | `curb deploy` introduced |
