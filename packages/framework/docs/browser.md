# Curb in the browser

`src/browser/` runs `curb dev` in an ordinary web page with nothing installed and no
server doing the work: the project lives in the browser (IndexedDB), the page compiles it
with esbuild-wasm, installs npm packages from the registry, runs the agent server in a Web
Worker and serves the same preview, by text and by voice. It is a development environment
only; a deployed agent is built and run exactly as before (`curb build`, `agent-guide/hosting.md`).

Local Curb is unchanged by it: `npm install`, `curb dev`, `curb check`, `curb build` and
`curb deploy` run the same code as without it. The page reuses `curb dev`'s own supervisor
(`cli/dev-supervisor.ts`), reload rule (`cli/dev-watch.ts`), forwarder logic and agent
server (`server/main.ts`); what differs is only where files, processes and sockets come
from.

## Build and serve

```bash
# a project to start from (a `curb` file: dependency vendors its tarball as vendor/curb.tgz)
npx tsx src/browser/static-build.ts <template project> <out dir> [--sessions /agents/session/ --sign-in 'https://www.example.com{session}']
KUGELAUDIO_API_KEY=... npx tsx src/browser/serve-static.ts <out dir> 4630
```

The output is static files (the preview app, the browser runtime, the worker, esbuild's
wasm, ONNX Runtime Web and the Silero model, and the template project as
`curb-browser/template.json`). Any static host serves them. The KugelAudio API answers no
CORS and a browser WebSocket sends no `Authorization`, so model and speech calls need a
relay that adds the key: `serve-static.ts` relays `/kugel/*` locally, and a page opened from
a hosting platform's link uses the relay that platform names (below).

## The page's API

`window.curb.project` is the project for an editor or a coding agent in the page:
`list()`, `read(path)`, `write(path, text)`, `remove(path)`, `install(...specs)`, `reset()`;
`write`, `remove` and `install` resolve once the change is applied (and saved, below). A
write that changes the agent (`src/`, `context/*.md`, `.env`, `package.json`) reloads it
as a save does under `curb dev`.

`install` is `npm install <spec>`: versions from the registry, every tarball checked against
its published sha512, `package.json` and `package-lock.json` updated where npm puts each
package (`lockfile.ts`), so the project deploys through an ordinary `npm ci` exactly as it
ran in the page. Only code files (`.js`, `.mjs`, `.cjs`, `.json`) are unpacked.

## A coding agent's tools over a socket

Opened from a link of the form `…/#project=<id>&token=<token>&api=<origin>`, the page
connects a WebSocket to `<api>/v1/agents/browser/socket` (`relay.ts`) and answers the tool
calls that arrive on it (`tools.ts`, `agent-turns.ts`). The link is kept for the page's
path, so a reload reconnects, and taken out of the address bar.

### Session pages

Built with `--sessions <prefix>`, every `<prefix><id>` (`/agents/session/<id>`) is one
project's session page (`session.ts`): a stable address a person can bookmark and open on any
computer, which the host serves `index.html` at. The preview's routes live under that path
(`/agents/session/<id>/skill/<path>`). The page has no login of its own: with no kept link,
or once the platform refuses it (4401), it forgets the link and goes to `--sign-in` with
`{session}` replaced by its path. That page signs the person in to the host and sends them
back to the session with a fresh `#project=&token=&api=`. A refusal within a minute of
going there stops instead, so a sign-in that cannot help never loops. The token's lifetime is
the session's: the host decides how long a page works without signing in again.

The project is then the host's, not the browser's (`project-sync.ts`): every `ready` carries
the host's copy, which the page makes its working copy before the agent starts (or reloads
it when it was running), installing `node_modules/` from the lockfile; every change is saved
to the host first and applied only once the host confirms it. A refused save, or none while
the socket is down, changes nothing. An empty copy is seeded with the page's template. Two
kinds of path never leave the browser: `node_modules/` and `.env` files. IndexedDB holds only
the working copy, those two, and the conversations.

| Direction | Frame |
|---|---|
| page | `{ "type": "hello", "project", "token" }`, first |
| host | `{ "type": "ready", "model"?: { "base" }, "project": { "files": [{ "path", "text" } \| { "path", "size" }] } \| null }`; `model.base` becomes the agent's `KUGELAUDIO_API_BASE`; a binary file comes by its size; `null` is an empty copy |
| page | `{ "type": "save", "id", "writes": [{ "path", "text" } \| { "path", "base64" }], "deletes": [path], "replace"? }`; `replace` makes `writes` the whole copy |
| host | `{ "type": "saved", "id" }` or `{ "type": "save_failed", "id", "error": { "code", "message" } }` |
| host | `{ "type": "call", "id", "tool", "input" }` |
| page | `{ "type": "reply", "id", "ok": true, "result" }` or `{ …, "ok": false, "error": { "code", "message" } }` |
| page | `{ "type": "status", "agent": { "state": "serving" \| "reloading" \| "down", "message"? } }`, on a change |

Close code 4401 means the link is refused (the page stops and says so, or a session page signs in again), 4409 that a newer
tab took the project over; any other close reconnects with backoff.

Tools: `list_files`, `read_file`, `search`, `write_file`, `edit_file`, `delete_file`,
`add_dependency`, `remove_dependency`, `check`, `say`, `get_log`, `restart`,
`list_conversations`, `get_conversation` and `request_secret`. A deploy or a push packs the
host's copy, so it needs no tool and no open tab. A change answers `reload`:
`reloaded`, `failed` (with the authoring diagnostics), `unchanged`, or `pending` when a
running reply or call holds the reload past 20 s. Paths are project-relative; `.env` files
are never read or written by a tool (`request_secret` asks the person in the page, and the
value stays in the browser), and `node_modules/`, `vendor/`, `.curb/` and
`package-lock.json` belong to the page.

## Limitations

What works under local Curb and not in the browser. The page names each one when it is hit.

- **Node built-ins.** No shell, `child_process`, worker threads or native addons. `events`,
  `buffer`, `path`, `util`, `stream`, `string_decoder`, `url`, `crypto`, `timers`, `os` and
  `perf_hooks` are browser stand-ins; `fs` (the conversation journal only) and `http` (the
  agent server's own) are the page's. Anything else imports, and throws
  `CURB_BROWSER_UNAVAILABLE` naming itself when called. A package that needs one of these at
  import time fails to load, with that error.
- **Packages.** Only what a browser can run: code files are unpacked, install scripts never
  run, optional dependencies are recorded in the lockfile but not unpacked (an import of one
  fails as a missing optional module does under Node), and `curb`, `react` and `zod` are the
  runtime's own copies whatever version the project names.
- **`check`** reports the authoring diagnostics of the loaded agent. There is no TypeScript
  type check (esbuild strips types without checking them), no configuration block, and no
  `curb test` scenarios.
- **Voice.** Calls run over the page's own socket (the local transport); LiveKit, phone
  numbers and transfers are not available.
- **MCP sign-in.** Remote MCP servers connect from the page, so a server must answer the
  browser (CORS); one that does not fails to connect.
- **Storage.** A project opened from a link is the host's and opens the same in any
  browser. A page opened directly keeps its project in one browser profile: another browser
  or cleared site data starts again from the template. Either way, `.env` values and the
  preview's conversations stay in the browser they were made in.
- **The vendored Curb** (`vendor/curb.tgz`) is the one the page shipped when the project
  started; the host keeps that copy, so a later page with a newer Curb still deploys the
  project as it was locked.
- **Tools need the tab open.** A coding agent's calls reach the project only while its page
  is open and connected.
