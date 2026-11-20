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

## Embedding the preview

A host can serve the installed package's `dist/preview` assets and embed its
`index.html` in a same-origin iframe. Prefix the asset URLs with the host's
preview path and set `data-curb-transport="parent"` on the HTML element.

In this mode the host owns the input controls and the session. The preview posts
`{ type: "curb_preview_ready" }` when ready and
`{ type: "curb_preview_action", frame }` for its controls. Send normal preview
protocol frames back as `{ type: "curb_preview_frame", frame }`. Check the
iframe's window and the origin when receiving messages, and authorize any
server-side host action independently.
