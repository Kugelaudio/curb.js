# `<Procedure>`

An ordered flow of [`<Step>`](./step.md)s. The model sees the steps up to the current one and gets
the `advanceTool` to move on ([Step-by-step procedures](../procedures.md)).

```tsx
import { Procedure } from "curb";

function Procedure(props: ProcedureProps): ReactNode;
```

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `title` | `string` | | The flow's name |
| `advanceTool` | `{ name, description?, onCall? }` | `complete_procedure_step` | The tool that finishes a step. It takes no input, and an `onCall` replaces the built-in advance |
| `completed` | `ReactNode` | | Rendered once every step is done |
| `onComplete` | `() => void` | | Runs when the last step is done |
| `initialStep` | `number` | `1` | Where it starts. Steps count from 1 |
| `currentStep` | `number` | | Holds the step yourself, with `onStepChange` |
| `onStepChange` | `(step) => void` | | Runs when the step changes |

## Example

```tsx
<Procedure title="Report a claim" completed={<Tool name="submit_claim" description="File the claim." onCall={submit} />}>
  <Step title="Ask what happened">Ask what happened and when.</Step>
  <Step title="Ask for the policy number">Ask for the policy number.</Step>
</Procedure>
```

## Version history

| Version | Changes |
|---|---|
| v0.1.2 | `<Procedure>` introduced |
