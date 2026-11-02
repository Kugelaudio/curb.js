# `curb secrets push`

Sets every variable in `.env` on the agent's production environment. Prints names only, never values.

```bash
npx curb secrets push [--file <path>] [--agent <id>]
```

## Options

| Option | What it does |
|---|---|
| `--file <path>` | Another file |
| `--agent <id>` | Chooses the agent |

## Example

```bash
npx curb secrets push --file .env.production
```

## Version history

| Version | Changes |
|---|---|
| v1.3.4 | `curb secrets push` introduced |
