# API Reference

One page per component, hook, function, provider and command, each with its signature, its
options, an example and its version history.

| Page | What is on it | Import from |
|---|---|---|
| [Components](./components.md) | [`<Agent>`](./components/agent.md), [`<Skill>`](./components/skill.md), [`<Tool>`](./components/tool.md), [`<Procedure>`](./components/procedure.md) and the rest | `curb` |
| [Hooks](./hooks.md) | [`useSession`](./hooks/use-session.md), [`useRouter`](./hooks/use-router.md), [`useSend`](./hooks/use-send.md) and the rest | `curb` |
| [Functions](./functions.md) | [`defineAgent`](./functions/define-agent.md), [`createAgentStore`](./functions/create-agent-store.md), [`defineTool`](./functions/define-tool.md), the [errors](./functions/errors.md), what programs built on Curb use | `curb` |
| [Providers](./providers.md) | The LLM, speech-to-text and text-to-speech providers | `curb/providers` |
| [Client](./client.md) | The browser side of a call | `curb/client` |
| [Testing](./testing-api.md) | `scenario` | `curb/testing` |
| [Orchestration](./orchestration-api.md) | Server-only exports for scripts | `curb/orchestration` |
| [Configuration](./configuration.md) | Every environment variable, and `package.json` | |
| [CLI](./cli.md) | Every command | |
| [Diagnostics](./diagnostics.md) | Every code | |
| [Host protocol](./host-protocol.md) | How a host talks to a runner | |

Types are exported too, such as `ToolProps`, `SkillMeta` and `ConversationSink` from `curb`, and
`EffectiveSettings` and `SessionUpdate` from `curb/client`.
