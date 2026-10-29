# curb.js Changelog

All notable changes to the curb framework (packages `curb` + `create-curb-app`) will be documented in this file.

## Unreleased

### ⚠ BREAKING CHANGES

* **framework:** an agent without an `llm` prop runs on `kugelaudio.llm()` (KugelAudio's
  EU-hosted LLM, `qwen3.8-27b`) instead of `anthropic("claude-haiku-4-5")`, so it needs
  `KUGELAUDIO_API_KEY` where it needed `ANTHROPIC_API_KEY`. To stay on Claude, set
  `<Agent llm={anthropic("claude-haiku-4-5")}>`. `DEFAULT_ANTHROPIC_MODEL` is removed from
  `curb/providers`; `DEFAULT_KUGELAUDIO_LLM_MODEL` names the new default.
* **framework:** app messages replace the host channel. `useHost`, `useHostMessage` and
  `HostApi` are removed; use `useSend()` (`toClient`, `toHost`, `askHost`) and
  `useMessage(key, { from: "client" | "host", schema?, onMessage })`. `host.notify(name, payload)`
  becomes `send.toHost(name, payload)`, and `host.request(...)` becomes `send.askHost(...)`,
  which resolves with the reply's payload instead of the whole message. A reply to an ask
  no longer reaches handlers for its name.
* **framework:** `curb dev` is no longer a host: the preview WebSocket's `host_message`
  frames are removed.
* **framework:** host protocol v1: `POST /v1/sessions/{id}/messages` answers once the
  agent's handlers ran, and refuses with `422` `no_handler`, `invalid_payload` (with
  `issues`) or `handler_failed`. Message names are any string of 1 to 256 characters;
  every dotted name stays valid.
* **framework:** providers are props. `<Agent llm stt tts>` (and `<Skill>`, which overrides
  them while it is the active skill) take descriptors from the new `curb/providers` entry:
  `anthropic(model)`, `openai(model)`, `openaiCompatible({ baseURL, model })`,
  `azure.stt()`, `deepgram.stt()`, `elevenlabs.stt()/tts()`, `openai.stt()/tts()`,
  `kugelaudio.tts({ voice, model, language, dictionaryIds, projectId })`, `cartesia.tts()`.
  Removed: `defineAgent({ model, voice })` and `AgentVoiceConfig`, and the selection env vars
  `VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER`, `VOICE_STT_MODEL`, `VOICE_TTS_MODEL`,
  `VOICE_STT_SEGMENTATION_MS`, `KUGELAUDIO_VOICE_ID`, `KUGELAUDIO_MODEL_ID`,
  `KUGELAUDIO_LANGUAGE`, `KUGELAUDIO_PROJECT_ID`, `KUGELAUDIO_DICTIONARY_IDS`,
  `ELEVEN_VOICE_ID`, `OPENAI_TTS_VOICE`, `AGENT_LLM_PROVIDER`, `AGENT_LLM_BASE_URL` and
  `AGENT_MODEL`. The environment holds keys only; a missing key for a chosen provider fails
  naming the variable. The speech defaults are unchanged (`azure.stt()`, `kugelaudio.tts()`
  with voice 1072); the LLM default is `kugelaudio.llm()` (below).
* **framework:** `curb/orchestration`: `resolveVoiceProviders` is removed;
  `buildVoiceStt({ descriptor })`, `buildVoiceTts({ descriptor })` and
  `buildVoiceProviders({ settings })` take descriptors, and `VoiceSessionStartOptions.voice`
  is gone (the bundle's `runtime.settings` carries the providers). A project-owned
  `src/orchestration/session.ts` must build its providers with `buildVoiceProviders` and
  follow changes with `createProviderSwitch`; see `docs/agent-guide/orchestration.md`.

* **framework:** `curb/orchestration`: whatever connects the room attaches the caller's app right
  after connecting (`const client = attachClientMessages(room, { roomName })`) and hands it
  to the session as the new required `VoiceSessionStartOptions.client`; a project-owned
  `src/orchestration/session.ts` binds it first thing (`options.client.bind(bundle.runtime)`,
  again in `setBundle`, `detach()` on close). `worker.ts` starts the session through
  `serveCall({ sessionId: roomName, bundle }, (call) => startVoiceSession({ ..., client, ...call }))`.
  See `docs/agent-guide/orchestration.md`.
* **framework:** `AppMessages.undelivered` becomes `undeliveredCounts()` (per key, `toClient`
  and `toHost`), a `ClientTransport` returns `"sent" | "no_client_yet" | "phone_call"`, and
  `SessionRegistry.queuedRefusals` is removed: both now land in the call record.
* **framework:** `SessionSettings.setOverrides` is removed; outside changes go through
  `settings.update(origin, body)`, gated by `<Agent adjustable>`.
* **framework:** host protocol v1: `CallHandle` (the registry's view of a call) gains
  `update(body)`, and `SessionRegistry` takes `startCall` and `identity` only for a runner
  that places calls.
* **framework:** `DEFAULT_KUGEL_VOICE_ID` is removed from `curb/providers`. `kugelaudio.tts()`
  without a `voice` speaks with the default voice of its `language` (1072 English, 1887
  German); `defaultKugelVoice(language)` returns it.

### Features

* **create-curb-app:** setup asks no questions. It creates the project on KugelAudio (Kugel
  Ear, `kugelaudio.llm()`, Kugel TTS) straight away, in a terminal or not, and then shows
  only the next steps: `npx curb login` and `npm run dev`. `--stt`, `--llm`, `--tts` and
  the model flags still pick other providers, with their keys read from the environment.
  `--yes` is accepted and changes nothing.
* **framework:** `kugelaudio.llm({ model? })` in `curb/providers` runs the agent on
  KugelAudio's EU-hosted LLM (`qwen3.8-27b`, the default, or `mistral-medium-3.5-128b`) on
  the same `KUGELAUDIO_API_KEY` as Kugel Ear and Kugel TTS, at `KUGELAUDIO_API_BASE` (default
  `https://api.eu.kugelaudio.com`) plus `/v1`. Thinking is off on KugelAudio's side. A hosted
  agent gets the key from KugelAudio, and `curb check` says so. A host or client may switch
  `llm` to `{ provider: "kugelaudio", model }` where `<Agent adjustable>` allows it.
* **create-curb-app:** a new project runs on `kugelaudio.llm()`, Kugel Ear and Kugel TTS, so
  it needs exactly one key, `KUGELAUDIO_API_KEY`, and a hosted one none of its own.
  `ANTHROPIC_API_KEY` leaves `.env.example`, `requiredRuntimeSecrets` and the setup's key
  questions; `--llm anthropic | openai | openai-compatible` still picks another
  LLM. `npx create-curb-app .` scaffolds into the empty current folder, and the
  project's `AGENTS.md` tells a coding agent to do that, never to paste a key into a tool
  call, and to explain each step to the user.
* **framework:** `curb whoami`, which curb does not have, now names `npx curb login`.
* **framework:** an agent can transfer a hosted phone call: `useTransferCall()` returns
  `transfer({ to, ringTimeoutSeconds? })`, which resolves `answered`, `no_answer`, `busy`,
  `failed` or `refused` (with a code), and `<TransferCallTool to>` is a ready tool that
  tells the model the outcome. Once the target answers the agent is handed off and stops
  listening and speaking; it resumes when the target leaves while the caller stays. Outside
  a phone call the transfer is refused `transfer_unsupported_session`.
* **framework:** a transferred caller no longer waits in silence. `transfer_call` takes a
  required `announce`, the one sentence the agent says before connecting ("One moment, I am
  connecting you to our sales team."); the caller hears it in full, it cannot be interrupted,
  and the dial starts once it has played. A call without it is refused so the model calls
  again with one. `transfer({ announce })` does the same from your own code; without
  `announce` nothing is said. From then until the outcome the caller hears a ringback tone
  (425 Hz, 1 s on, 4 s off), which stops on every outcome and when the call ends.
* **framework:** `openaiCompatible()` takes `reasoningEffort` (sent as `reasoning_effort`;
  `"none"` switches thinking off), `temperature`, `topP` and `body`, extra request fields
  sent as written (vLLM's `top_k`, `chat_template_kwargs: { enable_thinking: false }`), so a
  reasoning model on an OpenAI-compatible endpoint no longer speaks its reasoning. An unknown
  `reasoningEffort`, an out-of-range sampling value or a `body` field Curb sets itself
  (`model`, `messages`, `tools`, `stream`, ...) is refused when the agent renders.
* **framework:** goals and A/B experiments in code. `defineAgent({ goals, experiments })`
  declares what counts as a successful call (`{ tool }`: the agent ran that tool, `{ judge }`:
  a criterion a judge checks) and experiments with 2 to 6 weighted variants. `curb build`
  writes both into `curb.bundle.json` (`goals[]`, `experiments[]`, sorted by name, `[]` when
  none); `defineAgent` refuses what a host could not use. `useVariant(name)` reads the call's
  variant (`experiment.<name>`). The host protocol's `StartCallRequest` takes `experiments`
  (experiment name to variant name), which the runner applies before the session starts.
  `curb dev` draws each preview conversation's variants by the hosting platform's rule, and a
  page's `client.<fromClient>` picks one; a scenario's `experiments` pins them in `curb test`,
  and an experiment it leaves out gets the same variant on every run of that scenario.
  `curb check` warns `AGENT_GOAL_TOOL_NOT_DECLARED` when a tool goal names a tool no `<Tool>`
  declares.
* **framework:** `curb check` warns `AGENT_LITERAL_DATE` when a calendar date ("3. Oktober",
  "October 28", "2026-10-28") is written into text the model reads: the system prompt, an
  instruction, a text or `<Text src>` document, a skill link's or tool's description, a field's
  `.describe()`, or a fixed `firstTurn: { say }` line. Curb tells the model today's date on
  every message, so a written date goes stale. A date your code computes and a format example
  such as `e.g. 1990-02-28` are not reported.
* **framework:** a tool's `schema` reaches the model whole: lists, nested objects,
  `.nullable()`, enums, ranges, formats, `.regex()` and every `.describe()`. zod checks what
  comes back and names the path of a nested refusal; the preview's Try form takes JSON for a
  list or an object.
* **framework:** `<Tool tryWith={{ ... }}>` is the input the preview's Try form opens with,
  typed from the tool's schema, e.g. a customer your demo data knows. The model never sees it.
* **framework:** the preview's graph opens large from **Graph** above the agent's context
  (`/graph` opens it too); the column's Graph tab, too narrow for a graph, is gone.
* **framework:** `<Agent>` renders the skills a conversation opens, so an app takes no
  routing props and needs no `<AgentRouter>`. A leftover `<AgentRouter>` renders nothing, and
  `curb check` warns `AGENT_ROUTER_REMOVED`.
* **framework:** a scenario's `fakes` replace a tool's `onSubmit` after its input is
  validated, and `curb say --fake <tool>[=<json result>]` does the same for one turn, so a
  test never books, sends or pays for real. `curb test` runs every scenario a file exports.
* **framework:** `curb check` lists the variables the agent's providers need, set or missing,
  never their values, and warns `AGENT_VOICE_LANGUAGE_MISMATCH` when an agent listens in one
  language and speaks another.

* **framework:** `curb login`, `curb logout`, `curb deploy` and `curb secrets push` ship a
  project to KugelAudio hosting. `login` signs in through the browser (loopback + PKCE,
  `--url` for another app URL) and keeps the session in `~/.config/curb/credentials.json`
  (mode 0600). `deploy` packs the project (no `node_modules`, `.git`, `.curb`, `.data` or
  `.env*`; 50 MiB compressed, 200 MiB unpacked, 10,000 files), uploads it, builds and
  activates it, and prints the playground URL (`--agent <id>`, `--no-activate`).
  `secrets push` sets every `.env` variable on the agent's production environment and
  prints names only (`--file`). The chosen agent is saved in `.curb/link.json`. See
  `docs/deploy.md`.
* **create-curb-app:** the CDN publish also uploads `curb/create-curb-app-latest.tgz` and
  `curb/curb-latest.tgz`, so `npx --yes https://cdn.kugelaudio.com/curb/create-curb-app-latest.tgz my-agent`
  always scaffolds the newest release.
* **create-curb-app:** a new project has a `.mcp.json` that registers the KugelAudio MCP
  server (`kugelaudio`, sign-in) and the docs MCP (`kugelaudio-docs`, no sign-in) for Claude
  Code started in the project; `AGENTS.md` points at it instead of a `claude mcp add` command.

* **framework:** a hosted call knows itself: `useSession().call` carries its `sessionId`
  (the start request's, never the runner's environment) and its own `scratchDir`, created
  when the call starts and removed when it ends. A managed runner serving several calls
  keeps each call's identity and files apart; see `docs/hosting.md` ("Several calls in one
  runner").
* **framework:** live session settings. `<Agent adjustable={{ client: [...], host: [...] }}>`
  lets the caller's app and the host change `tts.voice`, `tts.model`, `stt.language` and
  `llm` during a call; nothing is adjustable by default, and an update with any path not
  allowed for its sender (or any value that does not fit) is refused as a whole. Over
  LiveKit it is the `curb.update` RPC method (RpcError 2005 `not_adjustable`, 2006
  `invalid_settings`); over host protocol v1 it is the new `PATCH /v1/sessions/{id}`
  (200 `{sessionId, settings}`, 403 `not_adjustable` with `path`, 422 `invalid_settings`
  with `issues`, 404 `session_not_found`). New protocol types `AdjustablePath`,
  `SessionUpdate`, `EffectiveSettings`, `SessionUpdateResponse`; `ErrorBody` gains `path`.
* **framework:** the call record (`GET /v1/runner/events`) holds every message the agent sent
  to the caller's app (`curb.message_to_client` `{key, id, payload}`) and every reply to an
  app's ask (`curb.reply_to_client` `{key, id, reply}`), values over 4 KiB of JSON cut with
  `truncated: true`, and once per call `curb.messages` `{undeliveredToClient, refusedQueuedHostMessages}`
  when something was not delivered. A call that keeps no record writes none of them.
* **framework:** the caller's app can call the agent as soon as it joins the room: `curb.message`
  and `curb.update` are registered at connect and wait up to 10 s for the runtime. A
  `toClient` before any app joined is warned about as such, not as a phone call.
* **framework:** a live `llm` switch to a provider whose key this process lacks is refused
  `invalid_settings` naming the variable; a `tts.voice` / `tts.model` override belongs to the
  TTS provider it was set for and is dropped when the props move to another.
* **framework:** `useSession().settings`: the effective providers (props plus outside
  changes), read-only, re-rendering when they change.
* **framework:** `curb/client`, a browser-only export depending only on `livekit-client`:
  `connectAgent(room)` returns `{ send, ask, on, update, close }` over the documented wire
  format, waits for the agent to join, and refuses payloads over 15 KiB before sending.
* **framework:** `curb dev` and `curb start` serve host protocol v1 for the calls they run when
  `CURB_MANAGEMENT_ADDR` and `CURB_MANAGEMENT_TOKEN` are set: each call is registered under
  its room name while it runs (worker jobs register over a local socket to the worker
  process), so a self-hosted host can list them, follow the events stream, send messages,
  change settings and end them. Placing, counting and draining calls answer
  `501 runner_takes_no_calls` there.

* **framework:** provider props are live: a re-render with another value, or a switch to a
  skill with its own, swaps the speech provider mid-call (LiveKit `AgentSession.updateAgent`,
  chat context carried over, from the next reply) and the LLM from the next turn. Equal
  values compare structurally and rebuild nothing.

* **framework:** messages to and from the caller's app over LiveKit: a text stream on
  topic `curb.message` (agent to client) and the `curb.message` RPC method (client to
  agent, with a reply or a coded RPC error).

### Bug Fixes

* **framework:** an agent no longer reads a stage direction aloud ("[assistant turned their
  head away]"). A reply's opening narration in brackets or parentheses is never said nor kept
  in the transcript; a reply that is only that is asked for again once, and a second one
  leaves the turn silent. The cause is fixed too: a reply the caller talked over now holds only
  the words they heard, and the model learns of the unheard rest from a context event instead
  of a bracketed note inside its own reply, which it copied. A reply heard to its last word is
  no longer marked as cut off.
* **framework:** Kugel TTS waits and retries (100 ms doubling, 5 s cap) when the API key is at its
  concurrent-generation limit, instead of silencing the turn.
* **framework:** build verification bundles with esbuild 0.28.2 (was 0.25.12). The Go toolchain inside esbuild 0.25 carried 15 published vulnerabilities. No API change; the framework test suite passes unchanged.
* **framework:** a managed runner frees a stopped call's slot only once the call has ended
  (its recording finished, its scratch directory removed), not as soon as the room closed.
* **framework:** the undocumented `VOICE_DEBUG_DUMP` is removed. It appended every call's
  Azure STT input to one fixed `/tmp/azure-in.pcm`, mixing concurrent calls; the per-call
  debug clips already hold that audio.
* **framework:** `curb build` ships `undici`, which `@ai-sdk/provider-utils` loads by name at
  runtime through `module.createRequire`. The artifact was missing it, and from
  `@ai-sdk/provider-utils` 4.0.57 `curb build --emit-layers` refused when its temp directory
  sat inside the project, as it does in the hosted builder.
* **framework:** `curb dev` reloads only for a file that changed since it started, not for
  macOS's replay of the files written just before its watch began.
* **framework:** the preview's Try and model-input dialogs keep their content while they
  close, instead of emptying before the close animation ends.
* **framework:** a skill's page in the preview marks only the values your code fills in
  (`${customerNumber}`), with a tooltip naming where each came from. Prose written as a
  template literal (``{`...`}``) no longer shows as one filled-in value.
* **framework:** a skill in the preview's Context column reads like Instructions: its description
  on a second line, a chevron at the end of the row that opens it, and what it holds
  (`2 skills · 1 tool`) when it is not in use, read or locked; the chevron in front still expands it.
* **create-curb-app:** a copy from the CDN hands the run to the newest release that
  `latest.json` names when a newer one is out. npx keeps a tarball URL it ran once and
  never downloads it again, so on a machine that had run the quickstart,
  `create-curb-app-latest.tgz` still created Curb 1.3.10 projects after 1.5.0 shipped. Set
  `CREATE_CURB_APP_HANDOFF` to any value to keep the exact release. The CDN also serves the
  scaffolder as `curb/create-curb-app.tgz`, a name no machine has kept yet.
* **create-curb-app:** the quickstart is
  `npx --yes --allow-remote=all https://cdn.kugelaudio.com/curb/create-curb-app.tgz my-agent`,
  so a machine that ran it under `create-curb-app-latest.tgz` gets the newest release again.
  `docs/deploy.md` gave that command without `--allow-remote=all`, which npm 12 refuses.
  `create-curb-app-latest.tgz` keeps working for existing links.

## 1.0.0 (2026-07-26)

## 0.3.0 (2026-07-20)

## 0.2.0 (2026-07-17)

### Features

* **framework:** restore conversation history and call replay
