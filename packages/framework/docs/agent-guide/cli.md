# CLI

Run `npx curb <command>` from the project root. `--help` prints the usage and runs nothing.

| Command | What it does |
|---|---|
| [`curb dev`](./cli/dev.md) | Preview, chat and voice on one port |
| [`curb check`](./cli/check.md) | Type-checks the project and runs the authoring checks |
| [`curb say`](./cli/say.md) | One caller turn, headless |
| [`curb test`](./cli/test.md) | Runs the conversation scenarios |
| [`curb hook`](./cli/hook.md) | Runs an after-call hook once |
| [`curb conversations`](./cli/conversations.md) | Prints recorded conversations |
| [`curb start`](./cli/start.md) | Runs the LiveKit voice worker |
| [`curb server`](./cli/server.md) | Only the agent WebSocket server |
| [`curb build`](./cli/build.md) | Bundles the project and proves the bundle starts |
| [`curb upgrade`](./cli/upgrade.md) | Updates the project's `curb` dependency |
| [`curb info`](./cli/info.md) | Prints the facts a bug report needs |
| [`curb voices`](./cli/voices.md) | Lists the KugelAudio voices and their ids |
| [`curb login`](./cli/login.md) | Signs in to KugelAudio in the browser |
| [`curb logout`](./cli/logout.md) | Signs out |
| [`curb deploy`](./cli/deploy.md) | Uploads the project and makes it live |
| [`curb secrets push`](./cli/secrets-push.md) | Sets the variables of `.env` on the agent |
| `curb --version` | Prints the version |

## Next steps

- [Configuration](./configuration.md): every environment variable.
- [Diagnostics](./diagnostics.md): every code.
