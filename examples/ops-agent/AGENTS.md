# AGENTS.md — working on this agent project

This is an **agent framework project**: React renders an agent-facing
semantic tree that compiles into LLM context and tools — no DOM, no HTML.
Everything you edit lives in `src/agent/`; everything you import comes from
the `"curb"` package. This example is the MCP-heavy ops agent (Linear
triage, standup, issue creation).

**Read the full guide before authoring:**
`node_modules/curb/docs/agent-guide/README.md` (mental model + workflow),
then `authoring.md` (components, state, patterns) and `diagnostics.md`
(the check/fix loop and every diagnostic code).

## Commands

```bash
npm run dev        # everything on one port (4000): preview + agent server + voice (/voice)
npm run check      # authoring diagnostics — run after every change; exit 1 on errors
curb server        # headless agent server only
```

## Map

```text
src/agent/agent.tsx    the agent level, where every conversation starts: defineAgent(...), <SystemPrompt>,
                       skills index, global tools
src/agent/*/skill.tsx  one folder per skill, opened when needed; nested folders are sub-skills (routes = folder paths)
.env                   API keys (KUGELAUDIO_API_KEY, …) — auto-loaded by every curb command
.data/conversations.jsonl recorded conversations (one JSON record per line): tool calls, inputs, results, context diffs
```

## Core rules

- Plain JSX text **is** model context; `<Text>` is only required for
  file-backed content. `<Instruction>` is behavior, text is facts.
- Prose that runs over several lines is ONE template literal:
  ``<Instruction>{`…`}</Instruction>``. curb removes the shared indentation
  and keeps paragraphs, `## ` headings and `- ` lists; multi-line JSX text
  is joined onto one line (`curb check` warns `AGENT_PROSE_JSX_TEXT`).
- Every `<Skill>` link needs a routing `description` written as a rule
  ("Use FIRST when…", "NOT for…") — it is all the model sees when routing.
- Tool names: unique snake_case verbs. Zod `.describe()` and validation
  messages are read by the model — phrase them as next-step instructions.
- Enforce invariants structurally: gate tools behind shared-store state
  (`createAgentStore`), never behind prompt text alone. An unrendered tool
  does not exist for the model.
- MCP servers are declared inline: `<Mcp id="linear" url="https://…" />` in
  `<GlobalTools>` or a skill. Credentials are implicit — `MCP_<ID>_TOKEN` in
  `.env`, else OAuth via **Sign in** on the server in the preview's Context
  tab. No secret in code.
- Skills are discovered from the filesystem — never register anything.
- Import only from `"curb"`, never deep package paths.

## Verify loop

1. `npm run check` — fix errors, then warnings (they flag real routing /
   reachability problems). Diagnostics carry stable codes, locations, and a
   concrete fix; the same output appears in server startup logs and the
   preview, behind the problem count in its top bar.
2. `npm run dev`, then converse in the preview: correct skill routing,
   correct tool behavior, locked tools invisible until unlocked.
3. For misbehaving tool calls, run `npx curb conversations` (it reads `.data/conversations.jsonl`).
