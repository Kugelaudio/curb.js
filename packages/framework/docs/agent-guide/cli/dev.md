# `curb dev`

Starts the preview, chat and voice on port 4000, and opens the browser. Saving a file under `src/`, a
`context/*.md` file or `.env` reloads the agent.

```bash
npx curb dev [--port <n>] [--no-open]
```

## Options

| Option | What it does |
|---|---|
| `--port <n>` | Serves on exactly that port |
| `--no-open` | Does not open the browser |

## Example

```bash
npx curb dev --port 4100 --no-open
```

## Version history

| Version | Changes |
|---|---|
| v1.12.10 | Takes each call's room from `CURB_REALTIME_SESSION_URL` |
| v1.4.33 | `--port` added, and saved code runs on the same conversation without running its tools again |
| v0.1.2 | `curb dev` introduced |
