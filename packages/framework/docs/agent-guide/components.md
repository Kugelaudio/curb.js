# Components

Everything an agent renders, imported from `curb`.

| Component | What it does |
|---|---|
| [`Agent`](./components/agent.md) | The root of an agent, and where its providers are set |
| [`SystemPrompt`](./components/system-prompt.md) | The system prompt |
| [`Skills`](./components/skills.md) | The list of skills the model may open |
| [`Skill`](./components/skill.md) | One skill the model may open |
| [`GlobalTools`](./components/global-tools.md) | Tools every skill has |
| [`Instruction`](./components/instruction.md) | Behavioural guidance for the model |
| [`Text`](./components/text.md) | Factual context |
| [`Tool`](./components/tool.md) | What the model can call |
| [`Field`](./components/field.md) | One input field of a `Tool`, written as a child |
| [`ErrorMessage`](./components/error-message.md) | An error the model reads in its context |
| [`Procedure`](./components/procedure.md) | An ordered flow of steps |
| [`Step`](./components/step.md) | One step of a `Procedure` |
| [`Mcp`](./components/mcp.md) | Tools from an MCP server |
| [`TransferCallTool`](./components/transfer-call-tool.md) | A ready tool that puts the caller through to a number |

## Next steps

- [Hooks](./hooks.md): what a component can read and do.
- [Agents and skills](./agents-and-skills.md): how the components fit together.
