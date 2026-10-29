# Agent guide — building agents with curb.js

This guide is written for coding agents (and humans) working inside a
curb.js project. It assumes you know React. Read this file first, then:

- [how-it-works.md](./how-it-works.md) — how curb works under the hood: a real React renderer that targets context.
- [authoring.md](./authoring.md) — every component, state, and pattern, with code.
- [preview.md](./preview.md) — the dev preview and everything it exposes (interactive tools, transcript, audio, rewind).
- [diagnostics.md](./diagnostics.md) — the check/fix loop and every diagnostic code.
- [testing.md](./testing.md): test an agent from the command line: `curb check`, `curb say` turn by turn, and `curb test` for whole conversations (scripted or with a simulated caller).
- [orchestration.md](./orchestration.md) — the voice session every route runs, how a call opens, what the caller's page already told the call (a logged-in user's email, `useClient()`), and production hosting.

## Starting a project

Create the project in an empty folder, into the folder itself:

```bash
npm create kugelaudio .
```

Scaffolding into `.` rather than a subfolder means a coding agent started in that folder
loads the project's `.mcp.json`, `CLAUDE.md` and `AGENTS.md`. The new agent runs on
KugelAudio: its EU-hosted LLM, Kugel Ear and Kugel TTS, so no other key is needed. Sign in
with `npx curb login` in the project; there is no key to copy, and every curb command there
then runs on that login. A `KUGELAUDIO_API_KEY` the user sets in `.env` or the environment
(an API key from the dashboard, for CI or a server) works too and wins. Never paste a key into a command or a tool call, and send
keys to a hosted agent with `npx curb secrets push` (a hosted agent gets `KUGELAUDIO_API_KEY`
from KugelAudio). While you run each step, tell the
user in plain words what it does and what, if anything, they have to do.

## What curb.js is

curb.js is a React framework for building **voice-first LLM agents**. You
author an agent the way you author a Next.js site: a tree of components,
file-system routing, hot reload — except the tree renders **model context
and tools** instead of HTML, and the "user" arrives by chat or by voice
(streaming STT → your agent → streaming TTS, all inside `curb dev`). One
framework owns the whole loop: authoring, compilation, the conversation
runtime, the browser preview, and the voice pipeline.

Why React? Because context management IS state management. What the model
may see and do at each moment is a function of application state — so it is
expressed as a render. When state changes, the context re-renders; when a
capability shouldn't exist, it is simply not rendered.

## Mental model

You are not building a web page. React renders an **agent-facing semantic
tree** that the framework compiles into **LLM context and tools**:

```text
React JSX -> semantic page tree -> agent context + tools -> tool call -> state update -> re-render
```

- A conversation starts at the **agent level**: what `agent.tsx` renders (its
  `<SystemPrompt>`, the `<Skills>` list, `<GlobalTools>` and MCP servers) is
  in context on every turn, and no skill is loaded yet.
- Plain JSX text becomes factual context the model reads.
- `<Instruction>` becomes behavioral guidance.
- `<Tool>` becomes a callable tool with a typed schema.
- `<Skill>` links become one `read_skill` tool: the model opens a skill, and
  pulls in its instructions and tools, only when the conversation needs it.
  At most `maxLoadedSkills` (default 3) stay loaded, least-recently-used
  evicted.
- Conditional rendering is the security/flow model: a tool that is not
  rendered **does not exist** for the model. Gate capabilities with state,
  not with prompt text.

There is no DOM, CSS, or layout. "Rendering" produces context.

## What happens at runtime — one message, end to end

1. A user message arrives (typed in the preview chat, or spoken: mic →
   streaming STT → final transcript).
2. The framework compiles the current tree: the system prompt, the agent
   level's own text and tools, the loaded skills' text and instructions, and
   every rendered tool, and calls the model.
3. The model streams its reply. Tool calls are dispatched to your `onSubmit`
   handlers; handlers update state (often a `createAgentStore` store).
4. State changes re-render the tree → the model's context and tool surface
   are already different for its next step. Skill loads (`read_skill`) work
   the same way: the target skill's content joins the context.
5. The final text is shown in chat — and on voice, streamed sentence-by-
   sentence into TTS while the model is still writing, so speech starts
   before the reply is finished. Speaking over the agent interrupts it
   (barge-in) and cancels the rest.

Every turn — tool inputs, results, and the context diff each one caused —
is recorded, by default in `.data/conversations.jsonl` (see
[preview.md](./preview.md#recorded-conversations)).

## Project anatomy

```text
my-agent/
  package.json        "dev": "curb dev", depends on "curb"
  tsconfig.json       jsx: react-jsx (required)
  context/            optional markdown, referenced via <Text src="…" />
  src/agent/
    agent.tsx         exports `agent` (defineAgent): the agent level, where every conversation
                      starts: prompts, config, skills index, tools every skill has
    <name>/skill.tsx  one folder per skill, opened when needed; nested folders are sub-skills
```

The voice session (speech, turn-taking, interruptions, the production worker) is the
framework's, the same on every route; a project holds no copy of it.

Routes come from folder names: `src/agent/claim-procedure/skill.tsx` is
`/claim-procedure`. Discovery is automatic — never register skills manually.
Every skill has a folder of its own: a `skill.tsx` next to `agent.tsx` is
not a skill, and `curb check` says where its content goes
(`AGENT_HOME_SKILL_REMOVED`).

Agent authoring is imported from the `"curb"` package:

```tsx
import { Agent, Skills, Skill, Tool, Instruction, defineAgent, z } from "curb";
```

Voice settings are `<Agent>` props and `defineAgent` options; see
[orchestration.md](./orchestration.md).

## Working loop

1. Edit `src/agent/` (and `context/` markdown).
2. `npm run check` — authoring diagnostics, exit 1 on errors. Every
   diagnostic has a stable code, a location, and a suggested fix; they are
   written to be machine-actionable. Fix errors before moving on.
3. `npm run dev` — everything on one port (default http://127.0.0.1:4000):
   browser preview, agent WebSocket server, and voice. The preview shows the
   compiled context, the live tool surface, the problems `curb check` finds,
   and a chat
   to talk to the agent. Server startup logs repeat all diagnostics.
4. Verify behavior by conversation, not only by compilation: does the model
   route to the right skill, call the right tool, stay blocked by gates?
5. `npm run upgrade` updates the framework itself (the `curb` package and
   this guide) to the latest published version.

Conversations are recorded to `.data/conversations.jsonl` in the project
(`curb conversations` prints them; each line is one JSON record), including each tool call, its input, the
result, and the context diff it caused. To record to your own store instead,
point `KUGEL_CONVERSATION_SINK` at a module that default-exports a
`ConversationSink`; the startup log names the store in force, and a store that
fails never drops the call. See
[preview.md](./preview.md#recorded-conversations) for the contract and what
happens when the store fails.

## Rules that matter most

- Every `<Skill>` link needs a routing `description` — it is the only thing
  the model sees when deciding where to go. Write it as a routing rule
  ("Use for…", "Use FIRST when…", "NOT for…"), not as marketing copy.
- Tool names are snake_case verbs, unique across the whole agent.
- Zod error messages are read by the model: write them as instructions
  ("Email address is invalid. Ask the user for a corrected email address.").
- Cross-skill invariants live in a shared store (`createAgentStore`), and
  enforcement is structural: render the tool only when the state allows it.
- Keep skills small. The compiled context of one skill should stay well
  under the size warning threshold; split big skills into sub-skills.
