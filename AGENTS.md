# Agent Framework Development Guide

> **Note:** `CLAUDE.md` is a symlink to `AGENTS.md`. They are the same file.

Two audiences, two docs:

- Working **on the framework** (this repo): this file.
- Building **an agent with the framework** (inside a project): the project's
  own `AGENTS.md` plus `packages/framework/docs/agent-guide/` — read those
  when editing anything under `examples/*/src/agent/`.

## Repository overview

npm workspaces, structured like Next.js (one framework package, standalone
example projects):

```text
curb.js/
├── packages/framework/        # The framework package (published as "curb")
│   ├── bin/curb.js       # CLI shim: generates the spanning tsx tsconfig, registers tsx
│   ├── src/cli/main.ts        # CLI commands: dev / check / start / server / upgrade
│   ├── src/vite/              # Preview Vite config (the page never imports agent code)
│   ├── src/compiler.ts        # semantic tree -> compiled context + tools
│   ├── src/runtime.ts         # AgentSiteRuntime: headless React host, event log
│   ├── src/agent-session.ts   # conversation loop, LLM transport, transcript
│   ├── src/authoring*.ts      # diagnostics: codes, analyzer, formatter
│   ├── src/server/            # WS agent server, LiveKit voice host, conversation store
│   ├── src/preview/           # browser preview app (served by `curb dev`)
│   └── src/test-fixtures/project/  # hermetic fixture project used by the test suite
├── packages/create-curb-app/  # project scaffolder (npm create curb.js <dir>);
│                              # template lives in templates/default/
├── examples/insurance-agent/  # complete agent project (default demo; the template)
└── examples/ops-agent/        # MCP-heavy second example
```

Key seams:

- Every conversation starts at the agent level: `AgentSiteRuntime` loads no
  skill, so the context is what `agent.tsx` renders inside `<Agent>` until the
  model reads a skill (`CompiledContext.path` is `""` there). `<Agent>` renders
  the opened skills after its children, from the loaded paths every host passes
  through `agentAppElement` (`src/routing.tsx`), so an app takes no props. A
  leftover `<AgentRouter>` renders nothing and gets one `AGENT_ROUTER_REMOVED`
  warning (`src/agent-router-migration.ts`). Every skill lives in a folder of
  its own under `src/agent/`. A project from
  before that still has what the old start skill needed gets one
  `AGENT_HOME_SKILL_REMOVED` per leftover, naming what to move
  (`src/home-skill-migration.ts`).
- Agent code runs only under Node. Discovery is `src/agent.node.ts` +
  `AGENT_PROJECT_DIR` (see `src/project.node.ts`); the preview page gets each
  agent as data in the server's `agents` frame (`PreviewAgent`,
  `src/server/frames.ts`), so a skill may import `node:` modules. `curb build`
  bundles the same modules through `src/bundler/agent-modules.ts`.
- The bin shim generates `.curb/tsx.tsconfig.json` spanning framework
  and project sources: tsx applies its tsconfig only to include-matched
  files; a single-tree config silently classic-transforms the other tree's
  JSX ("React is not defined").
- `curb dev` reloads the agent on save. The CLI process (`src/cli/dev.ts`)
  owns the port, Vite and a watcher on the
  project's `src/`, `context/*.md` and `.env`; the agent server runs in a
  child process (`src/cli/dev-child.ts`) that it restarts after a save,
  once no reply is running (at most 30 s), no call is live and no MCP
  sign-in is open (at most 5 min), and forwards the agent's sockets and HTTP
  paths to (`src/cli/dev-proxy.ts`). The page reconnects with
  `?resume=<stored id>` and stays on its conversation, restored from its saved
  state (`src/server/conversation-restore.ts`, shared with `curb say`) without
  running any tool again. The framework's own sources are not watched:
  restart `npm run dev` after editing them.

## Commands

```bash
npm install        # once at the repo root (links workspaces + the framework bin)
npm run dev        # curb dev on examples/insurance-agent (everything on http://127.0.0.1:4000)
npm test           # framework package suite (vitest, hermetic via the fixture project)
npm run check:examples  # curb check + curb build on every example
npm run check:compat    # the same on projects frozen from older releases (compat/README.md)
npm run build      # tsc type-check build of the package
npm run check      # authoring diagnostics of the insurance example
npm run server     # headless agent WS server (insurance example)
```

Inside an example project the same things are `npm run dev`, `npm run check`,
`curb server`.

Releases come from merges: a merge to `main` that changes the framework reaches npm, the CDN
and a GitHub release. The commit subject is the changelog line, `!` makes a
major version, and `CHANGELOG.md` lives on the public repository. `curb upgrade` reads the
CDN's `curb/latest.json` inside a scaffolded project to repoint its `"curb"` dependency at
the newest tarball and reinstall (repo-linked `file:` projects update via git instead).

## Tests by area

`npm test` runs every area; `npx vitest run --project <area>` in `packages/framework` runs one.

| Area | Covers |
| --- | --- |
| `api` | the public API: every export and CLI command, in `src/public-api.txt` |
| `cli` | the `curb` commands |
| `build` | `curb build` and the bundler |
| `server` | conversations, voice and the WebSocket server |
| `protocol` | host protocol v1 and `curb/client` |
| `preview` | the browser preview |
| `core` | everything else: authoring, runtime, providers |

A changed `public-api.txt` is a change to what projects depend on: removing or renaming a line
needs `feat(framework)!:`. A failing `check:compat` means real projects break the same way; never
edit a frozen project to make it pass.

## Tests by area

`npm test` runs every area; `npx vitest run --project <area>` in `packages/framework` runs one.

| Area | Covers |
| --- | --- |
| `api` | the public API: every export and CLI command, in `src/public-api.txt` |
| `cli` | the `curb` commands |
| `build` | `curb build` and the bundler |
| `server` | conversations, voice and the WebSocket server |
| `protocol` | host protocol v1 and `curb/client` |
| `preview` | the browser preview |
| `core` | everything else: authoring, runtime, providers |

A changed `public-api.txt` is a change to what projects depend on: removing or renaming a line
needs `feat(framework)!:`. A failing `check:compat` means real projects break the same way; never
edit a frozen project to make it pass.

## Working rules

- **Pull requests follow `pr-rules`.** The title is the commit on `main`, so it must be
  `type(scope)!: subject`, and the body must say what changes and why. Commit messages are not
  checked. See "Branches, commits and pull requests" in `CONTRIBUTING.md`.
- **Tests are hermetic.** The suite runs against
  `src/test-fixtures/project/` (a copy of the insurance example) through the
  same `AGENT_PROJECT_DIR` discovery as a real project. If you
  change the insurance example's agent shape, update the fixture copy when a
  test depends on the changed behavior — tests must never reach into
  `examples/`.
- **Errors are for agents.** Anything a framework user can get wrong must
  surface as an agent-readable message: stable code, location, concrete fix
  (see `src/authoring.ts`). Never leak raw internals like "No skill found"
  into model context; throw `AgentAuthoringError` instead.
- **The browser/authoring public API is `src/index.ts`.** Agent code imports
  from `"curb"`. Server-only scripts use the sanctioned `"curb/orchestration"`
  export from `src/orchestration.ts`; don't document or encourage any other
  deep imports. Document a new component in `docs/agent-guide/components.md`, a new hook in
  `docs/agent-guide/hooks.md`, a new environment variable in `docs/agent-guide/configuration.md`
  and a voice session addition in `docs/agent-guide/voice-sessions.md`, with a guide page when
  it is a new task.
- **New diagnostics** get a code in `AUTHORING_DIAGNOSTIC_CODES`, a row in
  `docs/agent-guide/diagnostics.md`, and a test.
- **Node floor is `engines.node`.** Both published `package.json` files declare
  `>=22.12.0` (Vite's floor on the 22 line), and `bin/node-version.js` in each
  package reads that field and exits with `UnsupportedNodeVersion` before
  anything else loads. Change the floor there only, keep it a single `>=X.Y.Z`,
  and keep the CI rows covering it: pull requests run the floor (Node 22.12), and `main` runs the
  floor and Node 24, every major the README promises.
- **Dependency advisories.** The root `overrides` lifts the `onnxruntime-node`
  that `@livekit/agents-plugin-silero` pins exactly (1.24.3) to the framework's
  own `^1.30.0`, which drops its vulnerable `adm-zip` 0.5 and `global-agent` 3
  (`roarr`, `sprintf-js`). Overrides do not reach a scaffolded project, where the
  pinned copy stays; both packages are used only by `onnxruntime-node`'s
  postinstall (`script/install.js`, the Linux CUDA download from NuGet), never at
  runtime. `braces` (GHSA-vfj7-8cjw-p6xm, no patched release) arrives only through
  `shadcn`'s CLI (`fast-glob` -> `micromatch`); Curb imports nothing from
  `shadcn` but `shadcn/tailwind.css`, so no glob is ever expanded. Drop the
  override once silero's pin reaches a fixed `onnxruntime-node`.
- **Workflows** follow [`.github/AGENTS.md`](.github/AGENTS.md).
- Validate CLI/host changes by actually booting: `curb check` +
  `curb dev` from `examples/insurance-agent`, not just the unit suite.
- **`curb build`** bundles a project for hosting: static agent registry ->
  esbuild -> `@vercel/nft` trace -> dependency-version mirror -> start the
  artifact -> `dist/`. It was deliberately absent for a
  long time because node-only modules behind runtime guards could not be
  tree-shaken out of a **browser** production bundle. That reason does not
  apply to it: `curb build` emits a **Node** bundle for a server runtime,
  where those modules are wanted rather than stripped. The browser preview is
  unchanged and still built by Vite, and there is still no `dist/` in the
  published package.
  Two ordering constraints are load-bearing and easy to get wrong:
  the registry must be generated **before** bundling (discovery is
  `readdirSync` + computed `import()`, which a bundler cannot follow), and the
  trace must run **after** bundling (nft parses JavaScript, not TypeScript —
  pointed at source it returns two files and a warning, which looks like a
  small dependency graph rather than a broken trace).
  The mirror pass exists because neither tracing nor copying a package whole
  preserves the versions npm installed for it: a require the tracer cannot see
  leaves the artifact resolving upward to whatever another consumer hoisted
  (`commander@7` for `@livekit/agents`, `otlp-exporter-base@0.208` for
  `exporter-trace-otlp-proto@0.54`). It restores the installed version and
  fails the build if any edge still disagrees.
  The project's `context/` markdown is INLINED into the bundle
  (`src/bundler/context-registry.ts`), whole directory at a time. It cannot ship
  as files: the runtime resolves `context/` against `AGENT_PROJECT_DIR`/cwd, and
  a hosted artifact runs from an arbitrary directory that is not a project.
  The last step starts the finished artifact (copied outside the repo, at the
  entrypoint `curb.bundle.json` declares) and fails the build unless the worker
  logs `"msg":"starting worker"`, then runs that SAME entrypoint again with
  `curb-render-check`, which renders every skill and reports the markdown it
  carries — a worker that starts and renders nothing is the third packaging bug
  that reached a human. `--no-verify` skips both. Builds that reported success
  are where every one of those bugs came from, so "it compiled" is not a result.
  The generated runnable entry (`src/bundler/generated-entries.ts`) picks ONE
  mode from the environment, checked in this order: `CURB_READINESS_PROBE=1`
  loads the bundle, constructs the agent and exits without touching media;
  `CURB_MANAGEMENT_ADDR` (+ `CURB_MANAGEMENT_TOKEN`) starts a MANAGED runner
  (`src/bundler/managed-runner.ts`) that warms up once, prints the stable
  `curb-hosted {"event":"ready",...}` line, and takes calls over host protocol v1
  (`src/hosted/`), or with `CURB_RUNNER_ROLE=hooks` skips the warmup and runs the agent's
  `afterCall` and `afterEvaluation` over that port instead (`src/hosted/hook-runs.ts`);
  `CURB_REALTIME_URL` + `CURB_REALTIME_TOKEN` joins that ONE room
  directly and serves one call (`src/bundler/direct-join.ts`, the same seam
  `curb dev` uses); otherwise it registers a LiveKit worker pool. The managed and
  direct paths get room-scoped tokens from their host, never
  `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, and direct join deletes those from the
  environment rather than merely not reading them. A half-configured direct join
  exits 78 instead of falling back to the worker path.
  See `docs/build-verification.md`, and `docs/agent-guide/hosting.md` for self-hosting and
  `docs/agent-guide/host-protocol.md` for the protocol. `npm run smoke:self-host` builds the insurance example and drives a
  managed runner with no LiveKit credentials against `protocol.schema.json`;
  `npm run check:independence` fails if Curb cites a private KugelAudio platform
  document.

## Voice pointers

Voice runs on the **LiveKit agents-js backbone**, as a second I/O modality of
the SAME conversation the chat WS serves: the client sends `voice_start` on
its WebSocket, the server runs the call on that connection's own
`AgentSession` (one transcript, one authored prompt), and answers with a
`voice_session` frame carrying the browser's ticket and its `transport`
(`"livekit"` or `"local"`), which picks the preview's browser client.
Typed messages during a live call are fed through the voice pipeline
(`handle.sendText` → `generateReply`) so replies are spoken. Spoken turns run
`runTurnStream(text, { spoken: true })`, which appends the framework's
spoken-reply rules per turn (`spokenStyleSuffix`) — typed turns never see
them. The session is transport-neutral: `startVoiceAgent`
(`livekit-host/host.ts`) runs over a `VoiceCallRoom` (`src/server/voice/call-room.ts`).
With no LiveKit configured, a `curb dev` call is local and runs over the page's own
connection to the dev server: a WebSocket at `/voice/local`
(`AGENT_HTTP_PATHS.localVoice`), authorized by a per-call token in its query string,
carrying 16-bit mono PCM as binary frames (microphone at 16 kHz in, agent voice at
24 kHz out) and JSON control frames (`src/local-voice-wire.ts`). The server side is
`voice/local-host/` (`local-call-room.ts`, with LiveKit's own transcription
synchronizer in `synchronizer.ts`); the browser side is
`preview/voice/local-voice-client.ts`, which plays agent audio through a WebRTC
loopback so Chrome's echo cancellation still applies. A local call has no phone line,
so a transfer is refused. With `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`
(all three, or `curb dev` refuses to boot and names the missing ones) for LiveKit
Cloud or self-hosted, or with `CURB_REALTIME_SESSION_URL`, which asks that URL for each
call's room and two room-scoped tokens and refuses the LiveKit variables, the call is a
LiveKit room (`livekit-host/rooms.ts`: `openLivekitRoom(env)`, null when nothing is
configured; the dev child opens rooms from its own environment). On either transport
the LiveKit `AgentSession` owns audio, VAD, endpointing and
interruption (an interrupted reply's chat entry is truncated to the words
that actually PLAYED, aligned by Kugel word timestamps; a local page reports how much
of each reply it played); curb owns the LLM
loop via `CurbVoiceAgent.llmNode` (React-compiled context, skills, tools,
MCP). Call-audio clips are mapped onto transcript messages
(`AgentSession.annotateAudio`) and served by `GET /voice/clip`.

Providers are props from `curb/providers` (`src/providers.ts`, browser-safe
descriptors): `<Agent llm stt tts>`, overridden per slot by the ACTIVE skill's
`<Skill>` link. Defaults: Azure STT + Kugel TTS, whose default voice follows the TTS
language (1072 English, 1887 German); Kugel Ear STT
(`kugelaudio.stt()`, `livekit-host/kugel-stt-plugin.ts`) is native too. All are the framework's own
LiveKit plugins under `src/server/voice/livekit-host/`; Deepgram/ElevenLabs/
Cartesia/OpenAI via first-party LiveKit plugin packages; LLM `kugelaudio.llm()` (the
default: `qwen3.8-27b`, OpenAI-compatible at `KUGELAUDIO_API_BASE` or the EU ingress, plus
`/v1`), anthropic, openai, or any OpenAI-compatible endpoint. The env holds
keys only. The effective values live on `runtime.settings` (`src/session-settings.ts`);
the voice host swaps STT/TTS mid-call through `AgentSession.updateAgent`
(`livekit-host/provider-swap.ts`) and the LLM is read per turn. Outside changes
(`<Agent adjustable>`, deny by default) come in through `settings.update(origin, body)`
(`src/settings-update.ts`): the `curb.update` RPC (`livekit-host/messages.ts`) and
`PATCH /v1/sessions/{id}`. `curb/client` (`src/client/`) is the browser side of the
LiveKit wire format and may import only `livekit-client` and `src/wire.ts` at runtime
(`client/browser-safe.test.ts`). `curb dev` / `curb start` serve the management port
for the calls they run via `hosted/serve-call.ts` (worker jobs register over
`hosted/call-link.ts`). Server side: `packages/framework/src/server/voice/` (providers,
synthesize, kugel-tts session, `livekit-host/` + `local-host/`); browser client
`packages/framework/src/preview/voice/` (livekit-client room, mic publish,
transcription streams, and the local client). Needs the speech keys of the agent's providers: `KUGELAUDIO_API_KEY` for Kugel Ear and Kugel
TTS (the scaffold's providers; from `npx curb login`, or set in `.env`), and
`AZURE_SPEECH_KEY` only with `azure.stt()` (`AZURE_SPEECH_REGION` defaults to `eastus`). The
preview port walks 4000→4001→… when taken (an explicit `PORT` is honored strictly).
Turn-taking knobs: `VOICE_ENDPOINTING_MIN_MS` /
`VOICE_ENDPOINTING_MAX_MS` / `VOICE_SILENCE_FOLLOWUP_MS`; Azure's
segmentation silence is `azure.stt({ segmentationMs })`.

Every route runs the framework's one voice session, `startVoiceAgent`
(`livekit-host/host.ts`): browser voice in `curb dev` on either transport, and,
through its LiveKit adapter `startLivekitVoiceAgent` (same file, room in
`livekit-host/livekit-call-room.ts`), `curb start`'s LiveKit worker
(`livekit-host/worker.ts`, also the built artifact's worker mode) and the
artifact's direct-join and managed modes. Projects carry no session code, and a
leftover `src/orchestration/` is never loaded (`curb check` warns). How a call
opens (`caller.*` info, the uninterruptible agent-first greeting) is
`livekit-host/call-opening.ts`. `curb/orchestration` stays a server-only export
for scripts; keep native LiveKit exports out of the main browser-facing entrypoint.
