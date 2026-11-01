# Step-by-step procedures

Some conversations must happen in order. `<Procedure>` shows the model the steps up to the current one, and what
you pass as `completed` exists only once every step is done.

An ordered flow, whose last tool exists only once every step is done:

```tsx
import { Procedure, Step, Tool, z } from "curb";

<Procedure
  title="Book a viewing"
  advanceTool={{ name: "finish_step", description: "Mark the current step complete." }}
  onComplete={markReady}
  completed={
    <Tool
      name="book_viewing"
      description="Book the viewing."
      schema={z.object({ name: z.string(), slot: z.string() })}
      confirm={({ name, slot }) => `${slot} for ${name}, is that right?`}
      onSubmit={(input) => ({ ok: true, data: input })}
    />
  }
>
  <Step title="Get the caller's name">Ask for the caller's name.</Step>
  <Step title="Agree a slot">Offer a weekday between 9 and 17 and agree one.</Step>
</Procedure>
```

A `<Procedure>` keeps its step in component state, so it starts over if its skill unloads. To keep
the step, hold it in a store and pass `currentStep` and `onStepChange`. For answers the agent must
remember, give each step its own tool that writes to a store, as in
[Unlock a tool only after a check](./state.md).

## A longer example

**Procedure**: ordered steps the model must complete in sequence:

```tsx
<Procedure
  title="Three-step claim reporting order"
  advanceTool={{ name: "complete_claim_procedure_stage", description: "Mark the current step complete." }}
  onComplete={completeProcedure}
  completed={<Tool name="submit_prepared_claim" … />}
>
  <Step title="Confirm safety and prevent further damage">…</Step>
  <Step title="Collect evidence before filing">…</Step>
  <Step title="Move to claim intake">…</Step>
</Procedure>
```

## Next steps

- [Confirmations](./confirmations.md): ask for a yes before the last tool runs.
- [Components](./components.md#procedure): every prop of `<Procedure>`.
