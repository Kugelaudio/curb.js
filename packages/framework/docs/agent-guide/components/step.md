# `<Step>`

One step of a [`<Procedure>`](./procedure.md). Its children render from that step on: finished
steps stay in the context, and later ones stay hidden.

```tsx
import { Step } from "curb";

function Step(props: StepProps): ReactNode;
```

## Props

| Prop | Type | What it does |
|---|---|---|
| `title` | `string` | The step's name |

## Example

```tsx
<Procedure title="Verify the caller">
  <Step title="Ask for the policy number">
    <Instruction>Ask for the policy number.</Instruction>
    <Tool name="find_policy" description="Find a policy by its number." onCall={findPolicy} />
  </Step>
  <Step title="Confirm the name">Ask the caller to confirm the name on the policy.</Step>
</Procedure>
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<Step>` introduced |
