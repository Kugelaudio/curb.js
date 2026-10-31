# Changelog

All notable changes to Curb. Curb uses semantic versioning. Version numbers can skip: only released versions are listed.

Some 1.x releases made breaking changes without a major version. Each one is listed under Breaking.

## 1.14.1 (2026-10-29)

### Fixed

- An agent no longer reads a stage direction aloud.

## 1.13.2 (2026-10-29)

### Added

- A framed preview asks the page that framed it to offer an MCP sign-in.

### Fixed

- A cold preview in `curb dev` loads 136 files instead of 511.

## 1.12.10 (2026-10-28)

### Added

- `curb conversations` prints a project's recorded conversations with every tool call.
- `curb deploy --json` prints the result as one JSON line.
- `curb deploy` accepts a host-issued token through `CURB_PLATFORM_TOKEN_FILE`.
- `curb dev` can take each call's room from `CURB_REALTIME_SESSION_URL`.
- Curb runs on the model key a hosted workspace supplies.
- The preview picks the microphone before a call and explains a blocked one.
- The preview's context column folds away.

### Fixed

- The live transcript stays steady while someone speaks.
- A new project carries no `.npmrc`, which hosted builds refuse.
- A new project installs quietly, and its agent introduces itself once.

## 1.11.9 (2026-10-26)

### Breaking

- An agent without an `llm` prop runs on `kugelaudio.llm()` and needs `KUGELAUDIO_API_KEY`.
- `DEFAULT_ANTHROPIC_MODEL` is removed. `DEFAULT_KUGELAUDIO_LLM_MODEL` names the new default.

### Added

- `kugelaudio.llm()` runs an agent on KugelAudio's EU-hosted LLM.
- `npm create kugelaudio` creates a Curb project.
- `create-curb-app` asks nothing and starts on KugelAudio.
- `npx curb login` replaces the key in `.env` for a KugelAudio project.

### Fixed

- `end_call` hangs up on a voicemail menu, and the model learns when a hang-up was cancelled.
- A hosted runner warms up without the LLM key and checks it when a call takes the agent.
- A first run without keys or hosted access gets its next step from Curb.

## 1.10.1 (2026-10-26)

### Added

- A transferred caller hears the agent's announcement, then a ringback tone, instead of silence.

## 1.9.0 (2026-10-25)

### Added

- `useTransferCall()` and `<TransferCallTool>` transfer a hosted phone call.

## 1.8.0 (2026-10-25)

### Added

- `defineAgent({ goals, experiments })` declares goals and A/B experiments, and `useVariant()` reads a call's variant.

## 1.7.3 (2026-10-25)

### Added

- An agent reads who placed the call from `call.direction`.

## 1.7.2 (2026-10-25)

### Added

- `openaiCompatible()` takes `reasoningEffort`, `temperature`, `topP` and `body`.
- New projects register the KugelAudio MCP servers in `.mcp.json`.

### Fixed

- A skill in the preview's Context column looks like something you can open.

## 1.6.1 (2026-10-25)

### Fixed

- The quickstart installs `curb/create-curb-app.tgz`, which no machine has kept from an older release.

## 1.6.0 (2026-10-25)

### Added

- `curb check` warns `AGENT_LITERAL_DATE` when text the model reads hard-codes a date.

### Fixed

- A `create-curb-app` that npx kept from an earlier run hands over to the newest release.

## 1.5.0 (2026-10-25)

### Added

- `<Tool tryWith>` fills the preview's Try form with demo input the model never sees.

### Fixed

- The preview's graph opens large from a Graph button.
- The preview's dialogs keep their content while they close.

## 1.4.33 (2026-10-24)

### Breaking

- Conversations start at your agent and skills open only when needed. `curb check` names what an older project moves.
- `<Agent>` renders the skills a conversation opens. A leftover `<AgentRouter>` renders nothing and warns `AGENT_ROUTER_REMOVED`.
- `DEFAULT_KUGEL_VOICE_ID` is removed. `kugelaudio.tts()` speaks with the default voice of its language.

### Added

- `curb test` runs conversation scenarios headlessly, scripted or with a simulated caller.
- `curb say` runs caller turns headlessly.
- `curb test` and `curb say` fake a tool's `onSubmit`.
- `curb check` type-checks the project and lists the variables an agent needs, without their values.
- `<Tool confirm>` runs an action only after the caller says yes.
- `firstTurn: { say }` opens every conversation with exact words.
- `useClient()` reads what the caller's page sent.
- `kugelaudio.stt()` hears callers with Kugel Ear 1, and new projects use it.
- A tool's schema reaches the model whole: lists, nested objects and nullables work.
- A German agent speaks with a German voice by default.
- One voice session runs every route, with caller info, call identity and an uninterruptible greeting.
- Agents call tools silently, know today's date and fall back in their own language.
- The preview shows your conversation beside your agent's context, with a skills tree and a live graph.

### Fixed

- `curb dev` runs saved code within seconds, on the same conversation, without running its tools again.
- `curb dev` reloads only for a file that really changed.
- A voice agent ending a call always says its goodbye.
- On a voice call, a confirm action runs only after its read-back played in full.
- The model sees a tool field's description after `.optional()` and an enum's allowed values.
- `curb test` runs every scenario a file exports.
- `curb build` and `create-curb-app` work again with `@livekit/agents` 1.9.4.
- The preview opens for an agent whose skills import `node:crypto` or read `process.env`.

## 1.3.10 (2026-10-21)

### Breaking

- Curb requires Node 22.12 or newer.

### Fixed

- Kugel TTS retries a turn refused by the concurrent generation limit instead of going silent.
- Dependency advisories are cleared.

## 1.3.6 (2026-10-20)

### Fixed

- A project made by `create-curb-app` deploys, because it ships no symlink.

## 1.3.4 (2026-10-20)

### Added

- `curb login`, `curb logout`, `curb deploy` and `curb secrets push` ship a local agent to KugelAudio hosting.
- Calls sharing one managed runner get their own id, scratch directory and slot.

### Fixed

- `curb build` verification bundles with esbuild 0.28.2.

## 1.2.6 (2026-10-14)

### Breaking

- Providers are props. `<Agent llm stt tts>` and `<Skill>` take descriptors from `curb/providers`, and the environment holds keys only.
- App messages replace the host channel. `useHost` and `useHostMessage` are removed; use `useSend()` and `useMessage()`.
- `curb dev` is no longer a host.

### Added

- `<Agent adjustable>` lets the caller's app and the host change settings during a call.
- `curb/client` connects a browser app to an agent.
- Provider props are live: a change swaps the speech provider or LLM mid-call.
- `kugel-3.5` is the default TTS model on hosted agents.

### Fixed

- `curb build` ships `undici`.

### Performance

- Voice runners take caller audio at 16 kHz and merge frames in linear time.

## 1.1.0 (2026-10-01)

### Added

- Host protocol v1, and a self-hostable Curb.

### Fixed

- A turn stays alive through tool and LLM failures.
- A restored runner never blocks on a checkpoint.
- The Azure Speech region has a default.

### Performance

- Faster hosted builds and warm calls.
- Shorter reply delays.

## 1.0.0 (2026-07-26)

### Breaking

- One branching model, with an agent graph in the preview and author-settable icons.

## 0.3.0 (2026-07-20)

### Added

- Editable voice orchestration and context controls.

## 0.2.0 (2026-07-17)

### Added

- Conversation history and call replay are restored.

## 0.1.2 (2026-07-14)

### Added

- First release: a React agent framework with one conversation for chat and voice, a CDN scaffold and `curb upgrade`.
