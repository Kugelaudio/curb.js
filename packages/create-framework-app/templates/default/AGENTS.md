# AGENTS.md

This is a **curb.js** voice agent. React renders the agent's context (its prompt, knowledge
and tools) instead of HTML, and the framework runs the call: speech, turn-taking,
interruptions. You edit `src/agent/` and `context/`; components come from `"curb"`, the
providers from `"curb/providers"`. The project starts as Juno, a demo assistant: replace
her prompt, skills and tools with the user's agent and delete what it does not need.

The agent runs on KugelAudio: its EU-hosted LLM (`kugelaudio.llm()`), Kugel Ear and Kugel TTS.
Sign in with `npx curb login` in this folder: it opens the browser once to sign in, and
every curb command here then runs on that login (`--no-open` only prints the link, for a
machine without a browser). There is no key to copy; never ask for a key in the chat. A `KUGELAUDIO_API_KEY` the user sets in `.env` or the environment (an
API key from the dashboard, for CI or a server) also works and wins over the login. Another
LLM (`anthropic()`, `openai()`, `openaiCompatible()`) is one `llm` prop away and brings its
own key. A turn answered 403 `LLM_NOT_ENABLED` means the user's organization does not have
KugelAudio's LLM yet (it comes with hosted agents, in closed alpha): they ask
hello@kugelaudio.com, or the agent uses another LLM meanwhile.

**In a KugelAudio workspace** (`CURB_PLATFORM_TOKEN_FILE` is set), model access is already
set up: the workspace supplies the key and renews it, and `npx curb check` says
`from this workspace`. Do not run `npx curb login`, never ask for a key or an `.env` entry,
and run `npx curb check`, `npx curb say` and `npx curb test` yourself. A key that is
`not issued yet` arrives within a minute of the workspace starting: wait and run again.
The `kugelaudio-docs` MCP server works there as it is; the `kugelaudio` one is not signed in
in a workspace, so never ask the user to connect or authenticate it: use `npx curb say` for
speech and `kugelaudio-docs` or `node_modules/curb/docs/` for facts.

**Say what you do.** Before each step (creating the project, installing, checking, signing
in, deploying), tell the user in one plain sentence what it does and what, if anything, they
have to do, such as open a sign-in link. They may never have used a terminal.

**In a KugelAudio workspace you may run any command** you need, without asking for
permission first: the workspace is the person's own sandbox. If they turned on **Ask before
acting**, the chat asks them for you.

A new project is created with `npm create curb.js my-agent`, and you then work in
`my-agent` (`npm create curb.js .` fills the current empty folder instead).

The full guide ships in `node_modules/curb/docs/agent-guide/`: read `README.md` first, then
`what-the-model-receives.md`, `agents-and-skills.md`, `tools.md`, `state.md` and `testing.md`.
There is one page per task, such as `human-handoff.md` and `confirmations.md`;
`api-reference.md` leads to every export, and `improve-from-calls.md` is the way to fix an
agent from a call that went wrong.
A fault in Curb itself is reported as `reporting-a-bug.md` says, with the person's yes first.

## Verify every change

1. `npx curb check`: type-checks `src/`, renders every skill and prints warnings. Fix every
   error and every warning; each one names a file, a line and the fix.
2. `npx curb say "<what the caller says>"`: one spoken turn, headless. It prints the reply,
   each tool call and the context it changed. The next `curb say` continues the
   conversation; `npx curb say --new "<first line>"` starts over (do that after a code change).
3. `npx curb test`: runs every `src/**/*.scenario.ts` conversation headlessly, with scripted
   caller lines or a simulated caller pursuing a goal, and fails on turn errors, repeated
   sentences or a goal not reached. Keep one scenario per flow that matters (`testing.md`).

4. `npm run dev`: the browser preview with chat and voice on http://127.0.0.1:4000. Open it in the person's own browser yourself (`open http://127.0.0.1:4000` on macOS, `xdg-open` on Linux, `start` on Windows): a browser built into an app, like the Claude app's Browser pane, blocks the microphone, so a call there fails.

**To improve the agent, read its recent conversations first.** `npx curb conversations`
prints the last ones the preview and `curb say` ran, with every tool call, its
input and its result (`--last <n>`, `--id <id>`, `--json`). Calls to the hosted agent are
read with the `kugelaudio` MCP server's `agent_list_calls`, `agent_get_call` and
`agent_get_call_timeline` where it is signed in. Find where the agent went wrong, fix that,
and turn the conversation into a scenario so it stays fixed.

## The preview

It shows what the agent sees: its prompt, the skills it has loaded and the tools it can
call. You change the agent by editing code, never in the preview; a tool's form there only
tries the tool, and `<Tool tryWith={{ ... }}>` fills it with values your demo data knows.
**Copy for coding agent** copies a conversation with the skill map, so you can work from
what really happened.

## Map

```text
src/agent/agent.tsx         the agent, where every conversation starts: <Agent llm stt tts>,
                            system prompt, skills index, tools every skill has, store
src/agent/<name>/skill.tsx  one folder per skill, opened when needed; nested folders are sub-skills
context/*.md                knowledge a skill reads with <Text src="file.md" />
.env                        other providers' keys, an optional KUGELAUDIO_API_KEY; never commit it
.data/conversations.jsonl   every local conversation: tool calls, inputs, results
```

## Rules

- **Prose is one template literal**: ``<Instruction>{`...`}</Instruction>``, the same in
  `<SystemPrompt>` and `<Text>`. Paragraphs and `- ` lists reach the model; multi-line JSX
  text is joined into one line.
- **A skill's description is written once**, as `meta.description` in its `skill.tsx`,
  phrased as a routing rule ("Use for ...", "NOT for ..."). Its `<Skill>` link repeats none
  (a `description` on the link works too, but keep one).
- **No per-call state at module scope**: one runner serves several calls. Keep a call's
  state in a `createAgentStore` store, never in a module-level variable.
- **Secrets** come from `.env` locally and `npx curb secrets push` when hosted. Read them
  in tool handlers (`process.env.NAME`); never render them into a prompt.
- **A key never goes into a tool call.** Never paste one into a command line, a chat message
  or an MCP tool's arguments (`set_agent_secrets` included). The user puts it in `.env`
  themselves, and `npx curb secrets push` sends it to the hosted agent. A hosted agent gets
  `KUGELAUDIO_API_KEY` from KugelAudio, so the default agent has nothing to push.
- **No hard-coded names or dates.** The framework tells the model today's date on every
  turn; set `defineAgent({ timeZone })` to the callers' zone (default UTC). Examples use
  placeholders such as "Max Mustermann" or "the caller's name".
- **The opening says it is an AI**: the agent's first line tells the caller they are talking
  to an AI assistant. For exact words, use `defineAgent({ firstTurn: { say } })`.
- **A tool's `schema` is what the model sees**: lists (`z.array`), nested objects,
  `.nullable()`, enums, ranges and `.regex()` all reach it, so pass a list as a list, never
  as one string to split. Give every field a `.describe()`.
- **No prompt asks for "one moment" lines around tools**: Curb holds back the newest sentence
  before a tool call, so a lone "One moment." is never spoken, but of two sentences the first is.
- **Only an action with consequences** (it books, sends, pays or cancels) uses
  `<Tool confirm={(input) => "<read-back question>"}>`: the framework runs it only after the
  caller's next turn says yes. To repeat a detail back (a name, a number), say it in the
  reply; a confirm tool turns the caller's next words into the answer to its question.
- **Gate with state, not prompt text**: a tool that is not rendered does not exist for the
  model. Render it from store state, and give a locked branch text that says how to unlock it.
- **What counts as a successful call is code too**: `defineAgent({ goals, experiments })`
  names each goal (a tool that must succeed, or a sentence a judge checks) and each A/B test
  with its weighted variants, and `useVariant("<test>")` reads the call's variant. The
  dashboard only shows the results; `authoring.md` ("Goals and A/B experiments") has the rules.
- Tool names are unique snake_case verbs. Zod `.describe()` texts and error messages are
  read by the model, so phrase them as the next step.

## Deploy to KugelAudio

`.mcp.json` registers two MCP servers for Claude Code started in this folder (it asks once
to use them): `kugelaudio`, your KugelAudio account (sign in from `/mcp`), and
`kugelaudio-docs`, the docs (no sign-in). Another client adds
`https://www.kugelaudio.com/mcp` as a remote MCP server. Look KugelAudio facts up with
`search_docs` and `read_docs_page`; for hosted agents use the `kugelaudio` server's,
since `kugelaudio-docs` serves public pages only. Deploy and read build and call logs
with the `kugelaudio` tools: `create_agent` (once), `create_agent_upload`, `deploy_agent`,
`get_agent_logs`; keys reach it only through `npx curb secrets push`. Without them:

```bash
npx curb login --no-open  # once; prints a sign-in link and waits up to 5 minutes
npx curb secrets push     # the .env keys onto the hosted agent; prints names, never values
npx curb deploy           # build and go live; prints the playground URL
```

Not signed in? Do not stop there: run `npx curb login --no-open` in the background, give
the user the link it prints to open in their browser on this machine, and go on once it
prints `Signed in as`. Hosted agents are in a
closed alpha, switched on per organization: on `CURB_HOSTED_AGENTS_NOT_ENABLED` the user
asks hello@kugelaudio.com, and `curb dev` and `curb say` keep working meanwhile. A dry run
is `npx curb deploy --no-activate` (or `npx curb build`, which uploads nothing).

Run `npx curb check` before deploying. `.env*`, `node_modules/`, `.git/`, `.curb/` and
`.data/` are never uploaded. Details: `node_modules/curb/docs/agent-guide/deploying.md`.
