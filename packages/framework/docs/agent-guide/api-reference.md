# API Reference

One page per kind of thing, each with its signature, its options and an example.

| Page | What is on it | Import from |
|---|---|---|
| [Components](./components.md) | `<Agent>`, `<Skill>`, `<Tool>`, `<Procedure>` and the rest | `curb` |
| [Hooks](./hooks.md) | `useSession`, `useRouter`, `useSend` and the rest | `curb` |
| [Functions](./functions.md) | `defineAgent`, `createAgentStore`, `defineTool`, the errors, what programs built on Curb use | `curb` |
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
