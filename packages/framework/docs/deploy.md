# Deploying to KugelAudio

Curb runs anywhere Node runs ([hosting.md](hosting.md)). If you want KugelAudio to host
the agent instead, with no servers of your own, four commands take a local project to a
live agent:

```bash
npm create kugelaudio my-agent
cd my-agent && npx curb login
npx curb secrets push
npx curb deploy
```

`deploy` ends by printing the agent's playground URL, where you can call it from the browser.

## `curb login`

Opens the KugelAudio sign-in page in your browser and waits up to five minutes for you to
confirm. The terminal prints the URL too, so on a machine without a browser you can open it
anywhere that can reach `127.0.0.1` on this machine.

| Flag | Meaning |
|---|---|
| `--url <web>` | Sign in to another KugelAudio app URL (default `https://www.kugelaudio.com`). Remembered for later logins. |
| `--no-open` | Print the sign-in URL without opening a browser (also `CURB_NO_OPEN=1`). |

The session is stored in `~/.config/curb/credentials.json` (or `$XDG_CONFIG_HOME/curb/`),
readable only by you (mode 0600), and refreshed automatically when it expires.
`npx curb logout` revokes it and deletes the file.

Run in a Curb project, the sign-in page also asks which organization and project to create
an API key in ("Curb CLI on <computer>", revocable on the API keys page). The CLI keeps it
beside the session in `~/.config/curb/project-keys.json` (mode 0600), never in the project
and never printed, and saves that project in `.curb/link.json` when there is no link yet, so
the first `curb deploy` deploys there. Every curb command in the project then runs on your
login: there is no key to copy. `npx curb logout` deletes the stored keys too.

Prefer an API key (CI, a server)? Set `KUGELAUDIO_API_KEY` in `.env` or the environment; it
wins over the login, and `curb login` then creates no key.

## `curb secrets push`

Sets every variable in the project's `.env` on the agent's production environment: your
provider keys such as `ANTHROPIC_API_KEY` or `AZURE_SPEECH_KEY` when the agent uses `anthropic()` or `azure.stt()`.
KugelAudio provides `KUGELAUDIO_API_KEY` itself, so an agent on `kugelaudio.llm()`, `.stt()` and `.tts()` has
nothing to push. Values
are write-only: the command prints names, never values, and nothing can read them back.
New calls use the new values; no redeploy is needed.

| Flag | Meaning |
|---|---|
| `--file <path>` | Read another file instead of `.env`. |
| `--agent <id>` | Push to this agent instead of the linked one. |

Skipped on purpose: `KUGELAUDIO_API_KEY` and `KUGELAUDIO_API_BASE` (the platform provides
them), `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (hosted calls get their own
media grant; keep them in `.env` for local `curb dev`), and empty values.

## `curb deploy`

Packs the project, uploads it, and makes it the agent's live production deployment:

```text
Packed 42 files (180.3 KiB unpacked, 51.2 KiB compressed).
Uploaded.
Revision rev_...
  build running
  build succeeded
  deployment candidate
  deployment active
Live. Try it in the playground: https://www.kugelaudio.com/dashboard/.../playground
```

| Flag | Meaning |
|---|---|
| `--agent <id>` | Deploy to this agent (and link the project to it). |
| `--no-activate` | Build and prove the deployment starts, but leave the live one serving. |
| `--json` | For a program running the deploy: the progress goes to stderr, and stdout carries one line, the result as a JSON object. A failed deploy prints nothing on stdout and exits non-zero. |

With `--json`, stdout reads:

```json
{"revisionId":"<the revision deployed>","deploymentId":"<its deployment>","state":"active","playgroundUrl":"<the playground, when known>"}
```

`state` is `ready` with `--no-activate`.

**Which agent.** The first `deploy` or `secrets push` in a project asks which of your agents
to use, or creates a new one, and saves the choice in `.curb/link.json`; later runs reuse it.
Without a terminal (CI, a coding agent), a first run with exactly one project and no agent
creates the agent, named after the directory; any other first run needs `--agent <id>` and
lists the ids. Delete `.curb/link.json` to choose again.

**What is uploaded.** The project directory, minus `node_modules/`, `.git/`, `.curb/`,
`.data/`, `.mcp-auth/`, a top-level `dist/`, and every `.env` / `.env.*` file. The lockfile
is uploaded with the source, so keep it in the project. Limits, checked before anything is
uploaded:

| Limit | Value |
|---|---|
| Compressed archive | 50 MiB |
| Unpacked | 200 MiB |
| Files | 10,000 |
| Single file | 50 MiB |
| Directory depth | 8 |

Symlinks are kept when they point inside the project and refused when they point outside it.

**In an environment a host runs for you.** A host that runs your project for you (a
hosted workspace) does not sign you in there. It sets `CURB_PLATFORM_TOKEN_FILE` to a file
it keeps current with a short-lived token for one agent and one environment:

```json
{
  "token": "<a token for that agent and environment>",
  "expiresAt": "2026-10-27T19:00:00Z",
  "platformApiUrl": "https://agents.example.com",
  "tenantId": "<organisation id>",
  "projectId": "<the agent's platform project id>",
  "environmentId": "<the environment it deploys to>",
  "kugelaudioApiKey": "<a model key that expires with the token>",
  "kugelaudioApiBase": "https://api.example.com"
}
```

`curb deploy` then deploys there with that token, reads the file on every run, and never
asks which agent: `.curb/link.json` and `--agent` play no part. `curb login` and
`curb secrets push` are refused with the reason; set the agent's secrets in the dashboard.

When the file carries `kugelaudioApiKey` (and, optionally, `kugelaudioApiBase`), every curb
command runs the project on that key unless `.env` or the environment sets
`KUGELAUDIO_API_KEY`: `curb dev`, `curb test`, `curb say` and the preview reach KugelAudio's
models with nothing to set. A running `curb dev` re-reads the file every 30 seconds, so it
moves onto each renewed key, and `curb check` lists the key as coming from the workspace.

## Errors you can fix

| Message starts with | What to do |
|---|---|
| `You are not signed in` / `Your KugelAudio session expired` | `npx curb login` |
| `Your plan does not include ...` | Upgrade the organisation's plan in the dashboard, then run the command again. |
| `Uploading source is not enabled for this organisation` | Push the project to GitHub and connect the repository in the dashboard. |
| `Build ... failed` | Open the agent in the dashboard and read the build log. |
| `The platform refused this environment's token` / `The platform token ... expired` | Wait a minute: the host renews the token on its own. |

Any other refusal is printed with its HTTP status, error code and correlation id; quote the
correlation id when you contact support. Set `DEBUG=1` for a stack trace.
