# Glossary

| Term | What it means |
|---|---|
| Active skill | The skill the model read last. Its `llm`, `stt` and `tts` apply ([Agents and skills](./agents-and-skills.md)) |
| Agent | The React tree in `src/agent/agent.tsx`, and everything it renders |
| Agent level | What the agent renders before the model has read a skill. It is in every request |
| App message | A message between the agent and the page or the host, with no model involved ([App messages](./app-messages.md)) |
| After-call hook | Your code that runs once a call is over ([After-call code](./after-call-code.md)) |
| Artifact | What `curb build` produces: a project that starts with no install ([Self-hosting](./hosting.md)) |
| Client | The caller's page. What it says arrives as `client.*`, and it is never proof of identity |
| Context | What the model reads in a request ([What the model receives](./what-the-model-receives.md)) |
| Diagnostic | A problem `curb check` reports, with a stable code and a fix ([Diagnostics](./diagnostics.md)) |
| Experiment | Variants of an agent, assigned per call ([Goals and experiments](./goals-and-experiments.md)) |
| Fake | The result a tool gives in a test instead of running ([Testing](./testing.md)) |
| Goal | What counts as a successful call ([Goals and experiments](./goals-and-experiments.md)) |
| Host | What runs an agent and gives it calls ([Host protocol](./host-protocol.md)) |
| Preview | The page `curb dev` serves: chat, voice and the context the model reads ([The preview](./preview.md)) |
| Procedure | An ordered flow of steps ([Step-by-step procedures](./procedures.md)) |
| Provider | The LLM, speech-to-text or text-to-speech an agent runs on ([Providers](./providers.md)) |
| Runner | One process that serves calls for a host |
| Read-back | The question a `confirm` tool has the agent say before it runs ([Confirmations](./confirmations.md)) |
| Scenario | A whole conversation kept as a test ([Testing](./testing.md)) |
| Skill | A whole area of work the model opens when it needs it ([Agents and skills](./agents-and-skills.md)) |
| Store | State that lasts the whole call ([State and conditional tools](./state.md)) |
| Tool | A single action the model can call ([Tools](./tools.md)) |
| Transcript | Every message of a conversation. No skill has a private one |
| Turn | One thing the caller says and everything the agent does in answer |
| Variant | One arm of an experiment, assigned per call ([`useVariant`](./hooks/use-variant.md)) |
| Worker | The process that takes LiveKit calls with `curb start` ([Self-hosting](./hosting.md)) |
