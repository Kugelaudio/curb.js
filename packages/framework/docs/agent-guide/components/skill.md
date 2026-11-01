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
| `children` | `ReactNode` | The name the model reads. Without it, the name in the context is blank |

## Example

```tsx
<Skills>
  <Skill path="/claims" description="Reporting a claim or asking about an open one.">Claims</Skill>
</Skills>
```

## Version history

| Version | Changes |
|---|---|
| v1.2.6 | `llm`, `stt` and `tts` added |
| v0.1.2 | `<Skill>` introduced |
