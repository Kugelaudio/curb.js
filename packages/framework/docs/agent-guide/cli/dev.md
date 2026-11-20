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

Set `data-curb-base="/your/preview"` when mounting under a path. Serve
`context.index.json` at that base as a JSON array of relative markdown paths,
and serve those files at the same base. The index should include documents
from inactive skill branches. An empty array or a 404 means no documents.
The preview loads the index at startup and refreshes it when the host sends
another agent snapshot.

In this mode the host owns the input controls and the session. The preview posts
`{ type: "curb_preview_ready" }` when ready and
`{ type: "curb_preview_action", frame }` for skill inspection, inspector tool
calls and undo, agent selection, rewind, reset and conversation selection.
Check the iframe's window and origin before accepting actions. Authorize every
server-side action independently.

Send `{ type: "curb_preview_frame", frame }` with the normal preview protocol's
agent descriptions, compiled and inspected context, chat messages, text deltas,
model traces, conversation lists, running state, notices and text-preview
errors. Keep voice session frames, MCP connection and sign-in data, socket
reload frames and credentials on the host. Check app-controlled text, tool
arguments and results, and traces for secrets before forwarding them.
