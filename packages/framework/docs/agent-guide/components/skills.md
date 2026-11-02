# `<Skills>`

Holds the [`<Skill>`](./skill.md) links the model may open. It takes no props.

```tsx
import { Skills } from "curb";

function Skills(props: { children: ReactNode }): ReactNode;
```

## Example

```tsx
<Skills>
  <Skill path="/claims" description="Reporting a claim.">Claims</Skill>
  <Skill path="/policy" description="Questions about cover.">Policy questions</Skill>
</Skills>
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<Skills>` introduced |
