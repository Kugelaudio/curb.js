# Diagnostics — the check/fix loop

The framework's error surfaces are designed to be read by coding agents:
stable codes, exact locations, and a concrete fix on every finding. Trust
them — when a diagnostic and your intuition disagree, read the diagnostic
again.

## Where diagnostics appear

- `curb check`: run after every edit; exits 1 when errors exist. It
  type-checks every file under `src/` with the project's `tsconfig.json`
  (errors inside the framework's own source are not yours and are not
  shown), renders the whole agent with every skill loaded, and reads the
  source of every skill, including branches that are not rendered yet.
  Agent code runs through tsx, which does not check types, so a misspelled
  name in a tool's `onSubmit` otherwise fails only when the model calls
  the tool, in the middle of a call.
- `curb dev` / `curb server` — all diagnostics are logged at
  startup (`console.warn` / `console.error`). After a save, `curb dev`
  reloads the agent and prints one line, which counts any errors.
- The preview's **Diagnostics** panel — same content, with per-row and
  copy-all buttons that emit the exact agent-readable format below. An
  agent whose modules do not load, or that does not render, shows its
  diagnostic in place of the preview until a save fixes it.
- `AgentAuthoringError` — thrown (not leaked into model context) when an
  authoring mistake makes compilation impossible, e.g. navigating to a
  non-existent skill. Its message is a formatted diagnostic.

Format:

```text
[AGENT_MISSING_SKILL_DESCRIPTION] WARNING: Skill link to "/member-portal" has no routing description…
Location: src/agent/agent.tsx
Fix: Add meta.description to the target skill or a description prop to the link.
```

`Location` is a file, `file:line` or `file:line:column`, relative to the
project root:

```text
[AGENT_TYPE_ERROR] ERROR: Cannot find name 'finsh'. Did you mean 'finish'? (TS2552)
Location: src/agent/claims/skill.tsx:13:9
Fix: Declare or import this name, or correct its spelling. Agent code runs without a type check, so this would fail only when the line runs, mid-call: in a tool handler, or in a branch that renders later.
```

## Codes

| Code | Severity | Meaning → fix |
|---|---|---|
| `AGENT_INVALID_ROUTE` | error | A `<Skill>` link points to a path with no `skill.tsx`. Create the skill folder or fix the path. |
| `AGENT_UNREACHABLE_SKILL` | warning | A `skill.tsx` exists but no link reaches it from the agent's `<Skills>` list, directly or through the skills that list reaches. Add it to the list or link it from a reachable skill, or delete it. |
| `AGENT_DUPLICATE_TOOL_NAME` | error | Two tools share a name; the model cannot address them. Rename one. |
| `AGENT_MISSING_SKILL_DESCRIPTION` | warning | A skill link has no routing description, so the model routes blind. Add `meta.description` on the target or `description` on the link. |
| `AGENT_POSSIBLY_LOCKED_BRANCH` | error / warning | Error: a branch is locked by a constant condition and can never render. Warning: a conditional branch has no apparent unlock mechanism. Add the unlock path, or unconditional fallback text telling the model how to unlock it. |
| `AGENT_CONTEXT_TOO_LARGE` | warning | One skill compiles to an oversized context. Split it into sub-skills or move prose into `context/` markdown loaded where needed. |
| `AGENT_AUTHORING_RENDER_FAILED` | error | The agent threw while loading or during the diagnostic render (which loads every skill). The message is the component's own error and the location is the line that threw, or the component that was rendering. Fix it first; other findings may be masked until the agent renders. "Maximum update depth exceeded" means something changes state every time it renders: call store actions from a tool's `onSubmit`, never while rendering. |
| `AGENT_TYPE_ERROR` | error | TypeScript rejects a line of the project's own code under `src/`, checked with its `tsconfig.json` plus Node's types (curb depends on `@types/node`, so `process.env` in a tool is fine). Fix the line. `src/orchestration/` is not checked (see `AGENT_ORCHESTRATION_IGNORED`). At most 50 are listed per run. |
| `AGENT_TYPECHECK_UNAVAILABLE` | warning | TypeScript is not installed, so `src/` was not type-checked. Run `npm install --save-dev typescript`. |
| `AGENT_NODE_TYPES_MISSING` | warning | No `@types/node` could be found, so the check cannot type Node names such as `process` or `Buffer`; every use is in this one warning, never an error. The code runs. Run `npm install --save-dev @types/node` (for your editor, also add `"types": ["node"]` to `tsconfig.json`). |
| `AGENT_ENV_NOT_DECLARED` | warning | Your code under `src/` reads an environment variable (`process.env.NAME`, `process.env["NAME"]` or `const { NAME } = process.env`) that `.env.example` does not list, so whoever deploys the agent does not know to set it. The location is its first read. Add `NAME=` to `.env.example` with no value; a commented `# NAME=` line counts too. Whether it has a value is never a finding: the Configuration block of `curb check` shows that. |
| `AGENT_PROSE_JSX_TEXT` | warning | Prose in `<SystemPrompt>`, `<Instruction>` or `<Text>` spans several lines as JSX text. JSX joins those lines with spaces, so the paragraphs, lists and headings never reach the model. Write the prose as one template-literal child, ``<Instruction>{`…`}</Instruction>``; the fix shows the rewrite, and curb removes the common indentation and keeps the line breaks. |
| `AGENT_LITERAL_DATE` | warning | A calendar date ("3. Oktober", "October 28", "2026-10-28") is written into text the model reads: the system prompt, an instruction, a text, a `<Text src>` document, a skill link's description, a tool's description or a field's `.describe()`, or a fixed `firstTurn: { say }` line. Curb tells the model today's date on every message, so a written date goes stale or misleads. Leave the date out, compute it in code or get it from a tool; keep it only when it never changes, such as a public holiday. Only a date written in `agent.tsx`, in the `skill.tsx` of the skill that shows it, or in the document is reported; a date your code computes while rendering never is. A format example (`e.g. 1990-02-28`, `Format: YYYY-MM-DD (1990-02-28)`) and a version such as `1.3.10` are not dates, and code comments and `defineAgent({ preview })` never reach the model. |
| `AGENT_ORCHESTRATION_IGNORED` | warning | `src/orchestration/` exists, but the framework runs the voice session on every route and does not use these files. Delete `src/orchestration/`; voice settings go on `<Agent>`. |
| `AGENT_VOICE_LANGUAGE_MISMATCH` | warning | The agent, or a skill whose `<Skill>` link sets `stt` or `tts`, listens in one language (an `stt` with a single `language` code) but its voice reads text with another's rules: the `tts` `language`, `"en"` when unset. The dates, numbers and amounts in its replies are read the other language's way, and a `kugelaudio.tts()` without `voice` picks its voice by that language too. Give the voice the language it listens in, e.g. `kugelaudio.tts({ language: "de" })`; the fix keeps your other options. An `stt` that lists several languages to detect among (`"de,en"`) is not checked. |
| `AGENT_INVALID_AUTHORING_PROP` | error | A framework component received an invalid prop (wrong shape/type), or `defineAgent` an option it cannot use (a time zone that does not exist, `goals` or `experiments` outside their limits). Follow the message, which names every problem; the props are validated exactly. |
| `AGENT_GOAL_TOOL_NOT_DECLARED` | warning | A goal in `defineAgent({ goals })` is reached when the agent runs a tool (`{ tool: "book_slot" }`), but no `<Tool>` in the agent or its skills has that name, so no call can reach it. The fix lists the agent's tools: name one of them, or rename the tool the goal means. A tool an MCP server provides is not checked; keep such a goal. |
| `AGENT_SCAFFOLD_PLACEHOLDER` | error | A value the scaffolder was supposed to substitute is still a placeholder, like `anthropic("{{AGENT_MODEL}}")` in `<Agent llm>`. `npm create kugelaudio` fills these in; a project copied out of `templates/default` keeps them. Replace it with a real value: nothing downstream can, and the model id is passed to the provider verbatim. |
| `AGENT_HOME_SKILL_REMOVED` | error | A project from before the agent level. A conversation now starts at `src/agent/agent.tsx` with no skill loaded, so these leftovers do nothing; there is one error per leftover, naming its file. A `skill.tsx` next to `agent.tsx`: move its instructions into the `<SystemPrompt>` of `agent.tsx`, its tools into `<GlobalTools>` and its `<Skill>` links into the agent's `<Skills>` list (the fix names them), then delete the file. `defineAgent({ initialPath })`: delete the line. `<Skill path="/">`: delete the link. A `curb build` fails its render check on them too. |
| `AGENT_ROUTER_REMOVED` | warning | The app still renders `<AgentRouter>`, which renders nothing now: `<Agent>` renders every skill the conversation opens, so the skills keep working. Delete `<AgentRouter ... />` and its import, and the `path`, `loadedPaths` and `routes` props of the app component: `export function App() { ... }`. |

## Practical loop for a coding agent

1. After any change to `src/agent/`, run `curb check`.
2. Fix all errors, then warnings — warnings are almost always real routing or
   reachability problems, not style nits.
3. Converse: `curb say "<what a caller says>"` runs one turn headlessly and
   prints the reply, every tool call and the context it changed (see
   [testing.md](./testing.md)). Confirm the model loads the intended skill
   for each topic and that locked tools stay invisible until unlocked. Keep the
   conversations that matter as `src/**/*.scenario.ts` and run them with
   `curb test`; boot `curb dev` to hear it.
4. When a tool call misbehaves, run `curb conversations` (it reads `.data/conversations.jsonl`), or
   your own store when `KUGEL_CONVERSATION_SINK` names one: every call is
   recorded with its exact input, result, and the context diff it caused. The
   server's startup log names the store in force.
