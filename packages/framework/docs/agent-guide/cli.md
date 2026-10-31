# CLI

Run `npx curb <command>` from the project root. `--help` prints the usage and runs nothing.

| Command | What it does |
|---|---|
| `curb dev` | Preview, chat and voice on one port |
| `curb check` | Type-checks the project and runs the authoring checks |
| `curb say` | One caller turn, headless |
| `curb test` | Runs the conversation scenarios |
| `curb conversations` | Prints recorded conversations |
| `curb start` | Runs the LiveKit voice worker |
| `curb server` | Only the agent WebSocket server |
| `curb build` | Bundles the project and proves the bundle starts |
| `curb upgrade` | Updates the project's `curb` dependency |
| `curb info` | Prints the facts a bug report needs |
| `curb login` | Signs in to KugelAudio in the browser |
| `curb logout` | Signs out |
| `curb deploy` | Uploads the project and makes it live |
| `curb secrets push` | Sets the variables of `.env` on the agent |
| `curb --version` | Prints the version |

## `curb dev`

Starts the preview, chat and voice on port 4000, and opens the browser. Saving a file under `src/`, a
`context/*.md` file or `.env` reloads the agent.

| Option | What it does |
|---|---|
| `--port <n>` | Serves on exactly that port |
| `--no-open` | Does not open the browser |

## `curb check`

Type-checks `src/` and runs the authoring checks. Exits 1 on errors ([Diagnostics](./diagnostics.md)).

## `curb say`

```bash
npx curb say "I want to report a claim"
```

Runs one caller turn and prints the reply, the tool calls and what changed in the context. Successive
calls continue one conversation ([Testing](./testing.md#2-curb-say-does-it-behave)).

| Option | What it does |
|---|---|
| `--new` | Starts a new conversation with this turn |
| `--client key=value` | Sets `client.<key>` before the turn. Repeatable |
| `--fake <tool>[=<json result>]` | Fakes a tool. Repeatable |
| `--json` | Prints one JSON object |

## `curb test`

```bash
npx curb test claims
```

Runs `src/**/*.scenario.ts`, or those matching a filter, and exits 1 when one fails
([Testing](./testing.md#3-curb-test-do-whole-conversations-work)). `--json` prints one JSON object.

## `curb hook`

```bash
npx curb hook afterCall --call fixtures/call.json
```

Runs the agent's `afterCall` or `afterEvaluation` once, in this process, with the project's `.env`.
`--call` is a JSON file holding a whole event, or a call with the fields the hook reads. Nothing else
fires a hook on your machine. Exits 1 when the hook failed
([After-call code](./after-call-code.md#try-it-locally)).

## `curb conversations`

Prints recorded conversations of `curb dev` and `curb say`, with every tool call and result.

| Option | What it does |
|---|---|
| `--last <n>` | The last n conversations. Default 3 |
| `--id <id>` | One conversation |
| `--json` | One JSON object, nothing clipped |

## `curb start`

Runs the LiveKit voice worker in production mode ([Self-hosting](./hosting.md)). With
`CURB_MANAGEMENT_ADDR` and `CURB_MANAGEMENT_TOKEN`, it also serves host protocol v1 for its calls.

## `curb server`

Starts only the agent WebSocket server. `--port <n>` as for `curb dev`.

## `curb build`

Bundles the project into `dist/`, starts the finished artifact on its own and renders every skill to
prove it runs ([Self-hosting](./hosting.md#built-artifact-curb-build)).

| Option | What it does |
|---|---|
| `--out <dir>` | Another output directory |
| `--no-verify` | Skips starting the artifact |

## `curb upgrade`

Updates the project's `curb` dependency to the latest version on npm ([Upgrading](./upgrading.md)).
`--check` only reports, and `--preview` takes the newest preview.

## `curb info`

Prints what a bug report needs: the versions of Curb, Node and npm, the OS and architecture, the
project's `curb` dependency, its LLM, STT and TTS providers, and whether each expected environment
variable is set. Paste the output into the issue.

It prints variable names only, never a value, and it starts nothing: the providers are read from the
source, so one set by anything but a direct call such as `tts={kugelaudio.tts()}` shows as `set in code`.
Outside a project it says so and prints the versions.

## `curb login`

Signs in to KugelAudio in the browser. The login is stored in `~/.config/curb/`, and a project then runs
on it with no key in `.env`. A `KUGELAUDIO_API_KEY` you set wins.

| Option | What it does |
|---|---|
| `--url <web>` | Another app URL |
| `--no-open` | Only prints the sign-in URL |

## `curb logout`

Revokes this machine's session and deletes the stored credentials and project keys.

## `curb deploy`

Uploads the project and makes it the agent's live production deployment. The first run picks or creates
the agent and saves it in `.curb/link.json` ([Deploying](./deploying.md)).

| Option | What it does |
|---|---|
| `--agent <id>` | Chooses the agent |
| `--no-activate` | Builds without going live |
| `--json` | Prints the result as one JSON line |

## `curb secrets push`

Sets every variable in `.env` on the agent's production environment. Prints names only, never values.

| Option | What it does |
|---|---|
| `--file <path>` | Another file |
| `--agent <id>` | As for `curb deploy` |

## Next steps

- [Configuration](./configuration.md): every environment variable.
- [Diagnostics](./diagnostics.md): every code.
