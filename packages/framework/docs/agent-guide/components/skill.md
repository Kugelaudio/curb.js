# `<Skill>`

One link to a skill folder under `src/agent/`. The model opens it with `read_skill`.

```tsx
import { Skill } from "curb";

function Skill(props: SkillProps): ReactNode;
```

## Props

| Prop | Type | What it does |
|---|---|---|
| `path` | `string` | The skill's path: `/claims` for `src/agent/claims/` |
| `description` | `string` | When the model should open it. Defaults to the description in the skill's own meta |
| `llm`, `stt`, `tts` | providers | Replace the `<Agent>`'s while this skill is the active one |
| `children` | `ReactNode` | The name the model reads. Without it, the skill's `meta.title`, else a title made from its path |

## Example

```tsx
<Skills>
  <Skill path="/claims" description="Reporting a claim or asking about an open one.">Claims</Skill>
</Skills>
```

## A skill's folder

`path="/billing"` links `src/agent/billing/skill.tsx`. Beside it the folder can hold the skill's
tools (`tools.ts`, values of [`defineTool`](../functions/define-tool.md)), its markdown and its own
test (`billing.scenario.ts`), which starts inside the skill with `start: { skills: [Billing] }`
([Starting inside a skill](../testing.md#starting-inside-a-skill)). `curb check` fails a scenario
that names a skill no `<Skill>` reaches (`SCENARIO_UNKNOWN_SKILL`).

## Version history

| Version | Changes |
|---|---|
| v1.16.0 | A link without children takes its name from the skill, and is never blank |
| v1.2.6 | `llm`, `stt` and `tts` added |
| v0.1.2 | `<Skill>` introduced |
