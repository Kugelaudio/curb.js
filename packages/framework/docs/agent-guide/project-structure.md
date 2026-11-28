# Project structure

A Curb project is a folder of React components. The folder names are the routes.

```text
my-agent/
  package.json        "dev": "curb dev", depends on "curb"
  tsconfig.json       jsx: react-jsx (required)
  context/            optional markdown, referenced via <Text src="…" />
  src/agent/
    agent.tsx         exports `agent` (defineAgent): the agent level, where every conversation
                      starts: prompts, config, skills index, tools every skill has
    <name>/skill.tsx  one folder per skill, opened when needed; nested folders are sub-skills
    <name>/tools.ts   optional: the skill's tools as defineTool values, imported by the skill
                      and by its tests
    <name>/<name>.scenario.ts
                      optional: a test of that skill, which can start inside it
    *.scenario.ts     optional conversations `curb test` plays, anywhere under src/
```

A skill with tools of its own keeps them in a `tools.ts` beside its `skill.tsx`:

```text
src/agent/billing/
  skill.tsx               renders <Tool {...issueRefund} />
  tools.ts                export const issueRefund = defineTool({ ... })
  billing.scenario.ts     start: { skills: [Billing] }, fakes: [fake(issueRefund, ...)]
```

The skill, its instructions (`{issueRefund.name}`) and its test then name the same value, so a
renamed tool is a type error instead of a test that fakes nothing
([Starting inside a skill](./testing.md#starting-inside-a-skill)). Only `skill.tsx` is discovered;
`tools.ts` and scenarios are ordinary modules.

The voice session (speech, turn-taking, interruptions, the production worker) is the
framework's, the same on every route; a project holds no copy of it.

Routes come from folder names: `src/agent/claim-procedure/skill.tsx` is
`/claim-procedure`. Discovery is automatic: never register skills manually.
Every skill has a folder of its own: a `skill.tsx` next to `agent.tsx` is
not a skill, and `curb check` says where its content goes
(`AGENT_HOME_SKILL_REMOVED`).

Agent authoring is imported from the `"curb"` package:

```tsx
import { Agent, Skills, Skill, Tool, Instruction, defineAgent, z } from "curb";
```

Voice settings are `<Agent>` props and `defineAgent` options; see
[Voice sessions](./voice-sessions.md).

## Files Curb writes

These stay out of git. The project's `.gitignore` already lists them.

| Path | What it holds |
|---|---|
| `.env` | Your keys and settings. See [Configuration](./configuration.md) |
| `.data/` | Recorded conversations, by default `.data/conversations.jsonl` |
| `~/.cache/curb/replies/` | Outside the project: the model replies `curb test` stored, so an unchanged scenario calls no model ([Reply store](./reply-store.md)) |
| `.curb/` | Generated files, `link.json` (the hosted agent this project deploys to), and `test-runs/`, the conversations of the last `curb test` runs ([Saved test runs](./test-runs.md)) |
| `.mcp-auth/` | Tokens of MCP servers you signed in to |

`mcp.servers.json` holds the MCP servers you added in the preview. It never holds tokens.
`mcp.tools.json` holds the tools each MCP server lists, written by
[`curb mcp snapshot`](./cli/mcp-snapshot.md) for [hermetic tests](./testing.md#hermetic-runs).
Commit both.

## Next steps

- [Agents and skills](./agents-and-skills.md): write the agent itself.
