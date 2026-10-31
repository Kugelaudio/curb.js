# AGENTS.md: working on this agent project

A German insurance agent built with Curb. Read `node_modules/curb/docs/agent-guide/README.md`
before authoring, then `authoring.md` and `testing.md`.

Everything the model or the caller sees is German: prompts, tool names, route paths and
`context/`. Everything only a developer reads is English.

## Commands

```bash
npm run check      # types and diagnostics, after every change
npx curb say "..." # one caller turn; --new starts over
npm test           # every conversation in src/scenarios/
npm run dev        # preview, chat and voice on one port
```

## Map

```text
src/kunden.ts                    the seam to your systems, invented data
src/agent/agent.tsx              prompt, skill index, global tools, shared store
src/agent/claim-intake.tsx       the one lock all four insurance lines share
src/agent/ablauf/skill.tsx       the three immediate measures
src/agent/schaden/*/skill.tsx    one insurance line each: schema, read-back, instructions
src/agent/kundenkonto/skill.tsx  verification, unlocks data and a skill
src/scenarios/*.scenario.ts      conversations that must keep working
context/*.md                     text the business team owns
```

## Rules

- A lock is an `if` over the store that renders the tool or not, never a sentence in a prompt.
- A tool that files or changes something has `confirm`, built from its input alone.
- Customer data comes through `src/kunden.ts`, never from a file every caller's context can see.
- Every new path gets a scenario; run `npm test` before you finish.
