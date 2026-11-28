# `curb check`

Type-checks `src/` and runs the authoring checks. Exits 1 on errors ([Diagnostics](../diagnostics.md)).

```bash
npx curb check
```

It checks, before anything runs and without calling a model:

- **Types**: every file under `src/`, scenarios included, with the project's `tsconfig.json`. A
  [`fake(tool, result)`](../testing-api.md#fake) whose result does not have the shape the tool's
  `onSubmit` returns is a type error here.
- **The agent**: it renders with every skill loaded, and the source of every skill is read,
  including branches that are not rendered yet. Text the model reads that asks for a tool the agent
  does not have is `INSTRUCTION_UNKNOWN_TOOL`.
- **Scenarios**: each `*.scenario.ts` against the agent. A skill in `start.skills`, `opened()` or
  `notOpened()` that does not exist is `SCENARIO_UNKNOWN_SKILL`; a faked or checked tool that does
  not exist is `SCENARIO_UNKNOWN_TOOL`; a `start.info` without a key a started skill's `meta.info`
  requires is `SCENARIO_INFO_MISSING`.
- **MCP tools**: with an `mcp.tools.json`, whether each reachable server still lists the same tools
  (`MCP_TOOLS_STALE`).

Run it before `curb test`: a scenario it passes cannot fail on a misspelled name.

## Version history

| Version | Changes |
|---|---|
| v1.30.0 | Checks every scenario against the agent (`SCENARIO_UNKNOWN_SKILL`, `SCENARIO_UNKNOWN_TOOL`, `SCENARIO_INFO_MISSING`), instruction text against its tools (`INSTRUCTION_UNKNOWN_TOOL`) and `mcp.tools.json` against its servers (`MCP_TOOLS_STALE`) |
| v1.19.0 | Fails `AGENT_VOICE_NOT_FOUND` when KugelAudio does not have a voice id the agent sets |
| v1.6.0 | Warns `AGENT_LITERAL_DATE` when text the model reads hard-codes a date |
| v1.4.33 | Type-checks the project and lists the variables an agent needs |
| v0.1.2 | `curb check` introduced |
