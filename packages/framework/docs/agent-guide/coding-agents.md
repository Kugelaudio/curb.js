# Working with a coding agent

Curb is built so a coding agent can do the work: it writes plain code, every diagnostic has a stable
code and a fix, and the agent can talk to what it built from the terminal. A new project comes with
`AGENTS.md`, `CLAUDE.md` and a `.mcp.json`, so a coding agent started in the project folder has what
it needs. This guide ships inside the `curb` package at `node_modules/curb/docs/agent-guide/`, matched
to the installed version.

## The working loop

1. Edit `src/agent/` (and `context/` markdown).
2. `npm run check`: authoring diagnostics, exit 1 on errors. Every
   diagnostic has a stable code, a location, and a suggested fix; they are
   written to be machine-actionable. Fix errors before moving on.
3. `npm run dev`: everything on one port (default http://127.0.0.1:4000):
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
[The preview](./preview.md#recorded-conversations) for the contract and what
happens when the store fails.

## Rules that matter most

- Every skill needs a routing `description`, on its `<Skill>` link or in its
  `meta`: it is the only thing
  the model sees when deciding where to go. Write it as a routing rule
  ("Use for…", "Use FIRST when…", "NOT for…"), not as marketing copy.
- Tool names are snake_case verbs, unique across the whole agent.
- Zod error messages are read by the model: write them as instructions
  ("Email address is invalid. Ask the user for a corrected email address.").
- Cross-skill invariants live in a shared store (`createAgentStore`), and
  enforcement is structural: render the tool only when the state allows it.
- Keep skills small. The compiled context of one skill should stay well
  under the size warning threshold; split big skills into sub-skills.

## What to avoid

- Don't import framework internals by deep path: only `"curb"` and its entry points
  (`curb/providers`, `curb/client`, `curb/testing`).
- Don't hand-register skills or routes; the filesystem is the registry.
- Don't encode invariants only in prompt text; render them structurally.
- Don't duplicate tool names, and don't leave a `<Skill>` link undescribed.
- Don't put UI concerns in skills: there is no DOM; everything is context.

## Keys

Never paste a key into a command or a tool call. A key in `.env` is read by every command. Send keys
to a hosted agent with `npx curb secrets push`, which prints names only.

## Connect KugelAudio to Claude Code

A project from the template comes with a `.mcp.json` that registers two MCP servers:
`kugelaudio`, your account, and `kugelaudio-docs`, the KugelAudio documentation. Start Claude Code in
the folder, approve the servers, then run `/mcp`, choose `kugelaudio` and sign in. In any other folder:

```bash
claude mcp add --transport http kugelaudio https://www.kugelaudio.com/mcp
```

Connecting other clients is in the [KugelAudio docs](https://docs.kugelaudio.com/hosted-agents/coding-agent).

## Next steps

- [Improve from real calls](./improve-from-calls.md): hand it a call that went wrong.
- [Diagnostics](./diagnostics.md): every code and its fix.
