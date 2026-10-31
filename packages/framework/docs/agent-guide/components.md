# Components

Everything an agent renders, imported from `curb`.

| Component | What it does |
|---|---|
| `Agent` | The root of an agent, and where its providers are set |
| `SystemPrompt` | The system prompt |
| `Skills` | The list of skills the model may open |
| `Skill` | One skill the model may open |
| `GlobalTools` | Tools every skill has |
| `Instruction` | Behavioural guidance for the model |
| `Text` | Factual context |
| `Tool` | What the model can call |
| `Field` | One input field of a `Tool`, written as a child |
| `ErrorMessage` | What the model reads when a field's input is invalid |
| `Procedure` | An ordered flow of steps |
| `Step` | One step of a `Procedure` |
| `Mcp` | Tools from an MCP server |
| `TransferCallTool` | A ready tool that puts the caller through to a number |

## `<Agent>`

The root of the tree. Everything the agent says and can do renders inside it.

| Prop | Type | Default | What it does |
|---|---|---|---|
| `llm` | [LLM provider](./providers.md) | `kugelaudio.llm()` | The model |
| `stt` | [Speech-to-text provider](./providers.md) | `azure.stt()` | Speech recognition |
| `tts` | [Text-to-speech provider](./providers.md) | `kugelaudio.tts()` | The voice |
| `adjustable` | `{ client?: paths, host?: paths }` | nothing | What the caller's page and the host may change during a call. Paths: `"tts.voice"`, `"tts.model"`, `"stt.language"`, `"llm"` ([Mid-call changes](./mid-call-changes.md)) |

A changed prop swaps that provider from the next render, also during a call.

```tsx
import { Agent, SystemPrompt } from "curb";
import { kugelaudio } from "curb/providers";

<Agent llm={kugelaudio.llm()} stt={kugelaudio.stt({ language: "de" })} tts={kugelaudio.tts({ language: "de" })}>
  <SystemPrompt>You answer calls for an insurance company.</SystemPrompt>
</Agent>
```

## `<SystemPrompt>`

The system prompt. Its children are the prompt: nothing is added when it compiles. A voice call adds
Curb's spoken-reply rules at runtime.

```tsx
<SystemPrompt>You answer calls for an insurance company. Keep every reply short.</SystemPrompt>
```

## `<Skills>`

Holds the `<Skill>` links the model may open. It takes no props.

## `<Skill>`

One link to a skill folder under `src/agent/`. The model opens it with `read_skill`.

| Prop | Type | What it does |
|---|---|---|
| `path` | `string` | The skill's path: `/claims` for `src/agent/claims/` |
| `description` | `string` | When the model should open it |
| `llm`, `stt`, `tts` | providers | Replace the `<Agent>`'s while this skill is the active one |

```tsx
<Skills>
  <Skill path="/claims" description="Reporting a claim or asking about an open one." />
</Skills>
```

## `<GlobalTools>`

Tools inside it are available in every skill. It takes no props.

```tsx
<GlobalTools>
  <TransferCallTool to="+493012345678" description="The caller asks for a person." />
</GlobalTools>
```

## `<Instruction>`

Behavioural guidance for the model. It takes no props.

```tsx
<Instruction>Never promise that a claim will be paid.</Instruction>
```

## `<Text>`

Factual context. A plain string in JSX is factual context too; use `<Text>` for a clear boundary or
to load a file.

| Prop | Type | What it does |
|---|---|---|
| `src` | `string` | A markdown file under `context/` |

Give `src` or children, never both.

```tsx
<Text src="deductibles.md" />
```

## `<Tool>`

What the model can call. A tool that is not rendered is not in the request
([State and conditional tools](./state.md)).

Every tool takes these:

| Prop | Type | What it does |
|---|---|---|
| `name` | `string` | The name the model calls |
| `description` | `string` | When to call it, for the model |
| `icon` | `string` | A [lucide](https://lucide.dev/icons) icon name for the preview. Never reaches the model |

Then one of three ways to take input:

| Form | Props | Use it for |
|---|---|---|
| Schema | `schema`, `onSubmit`, `tryWith` | Most tools: a Zod object, and typed input in `onSubmit` |
| Fields | `<Field>` children, `onSubmit`, `tryWith` | A few flat fields |
| No input | `onCall` | A tool that takes nothing |

`onSubmit` and `onCall` return a `ToolResult`, `{ ok, message?, data? }`, or a promise of one. With
`schema` or fields, two more props apply, and `confirm` holds the tool until the caller agrees:

| Prop | Type | What it does |
|---|---|---|
| `success` | `string` | The line after a successful run. Without it, the result's `message` |
| `error` | `string` | The line when a failed result has no `message` |
| `tryWith` | object | What the preview's Try form opens with. Never reaches the model |
| `confirm` | `(input) => string` | The question that holds the tool until the caller says yes. Only with `onSubmit` ([Confirmations](./confirmations.md)) |

```tsx
import { Tool, z } from "curb";

<Tool
  name="open_claim"
  description="Open a claim once the caller has described what happened."
  schema={z.object({ policy: z.string(), what: z.string() })}
  onSubmit={async ({ policy, what }) => {
    const id = await claims.open(policy, what);
    return { ok: true, message: `Claim ${id} is open.` };
  }}
/>
```

A handler can refuse its input with [`ToolInputError`](./functions.md#toolinputerror).

## `<Field>`

One input field of a `<Tool>`, written as a child. It adds nothing a Zod schema does not; it is shorter
for a few flat fields.

| Prop | Type | What it does |
|---|---|---|
| `name` | `string` | The input's name |
| `type` | `"string"`, `"number"`, `"integer"`, `"boolean"`, `"email"` | Its type |
| `description` | `string` | What it is, for the model |
| `required` | `boolean` | Whether the model must fill it |

```tsx
<Tool name="find_policy" description="Find a policy by its number." onSubmit={findPolicy}>
  <Field name="number" type="string" description="The policy number" required />
</Tool>
```

## `<ErrorMessage>`

What the model reads when the input of a field is invalid.

| Prop | Type | What it does |
|---|---|---|
| `source` | `string` | The field it belongs to |

## `<Procedure>`

An ordered flow of `<Step>`s. The model gets one step at a time and the `advanceTool` to move on
([Step-by-step procedures](./procedures.md)).

| Prop | Type | Default | What it does |
|---|---|---|---|
| `title` | `string` | | The flow's name |
| `advanceTool` | `{ name, description?, onCall? }` | `complete_procedure_step` | The tool that finishes a step. It takes no input |
| `completed` | `ReactNode` | | Rendered once every step is done |
| `onComplete` | `() => void` | | Runs when the last step is done |
| `initialStep` | `number` | `1` | Where it starts. Steps count from 1 |
| `currentStep` | `number` | | Holds the step yourself, with `onStepChange` |
| `onStepChange` | `(step) => void` | | Runs when the step changes |

## `<Step>`

One step of a `<Procedure>`. Its children render only during that step.

| Prop | Type | What it does |
|---|---|---|
| `title` | `string` | The step's name |

```tsx
<Procedure title="Report a claim" completed={<Tool name="submit_claim" description="File the claim." onCall={submit} />}>
  <Step title="Ask what happened">Ask what happened and when.</Step>
  <Step title="Ask for the policy number">Ask for the policy number.</Step>
</Procedure>
```

## `<Mcp>`

Tools from an MCP server ([MCP servers](./mcp.md)).

| Prop | Type | What it does |
|---|---|---|
| `id` | `string` | A server configured in `defineAgent({ mcpServers })`, also the prefix of its tools (`<id>__<tool>`) |
| `url` | `string` | Declares the server here: no `mcpServers` entry is needed |
| `auth` | `{ kind: "none" }`, `{ kind: "bearer", token }`, `{ kind: "oauth" }` | Default: a bearer token from `MCP_<ID>_TOKEN` when it is set, else OAuth, signed in once in the preview |
| `headers` | object | Headers for each request |
| `only` | `string[]` | Keep only these tools |

With neither `id` nor `url`, it brings in every registered server. In `<GlobalTools>` the tools reach every
skill; in a skill, only that skill.

## `<TransferCallTool>`

A ready tool that puts the caller through to a number and tells the model what happened
([Human handoff](./human-handoff.md)).

| Prop | Type | Default | What it does |
|---|---|---|---|
| `to` | `string` | | The number in international format, like `+493012345678` |
| `name` | `string` | `transfer_call` | The tool's name |
| `description` | `string` | says what it does | When the model should call it |
| `ringTimeoutSeconds` | `number` | `30` | How long it rings, 10 to 60 seconds |

## Next steps

- [Hooks](./hooks.md): what a component can read and do.
- [Agents and skills](./agents-and-skills.md): how the components fit together.
