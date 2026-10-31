import { Instruction, Text, Tool, z } from "curb";
import { useCase } from "../store.js";

export const meta = { title: "Cancellation", description: "Cancelling a plan." };

export default function Cancellation() {
  const customer = useCase((state) => state.customer);
  return (
    <>
      <Instruction>Ask why they want to cancel, once. Then cancel if they still want to.</Instruction>
      <Text>{`Plan to cancel: ${customer?.plan}.`}</Text>
      <Tool
        name="cancel_plan"
        description="Cancel the caller's plan at the end of its term."
        schema={z.object({ reason: z.string().min(1).describe("Why the caller cancels.") })}
        confirm={() => `I'll cancel ${customer?.plan} at the end of its term, is that right?`}
        success="The plan is cancelled."
        onSubmit={(input) => ({ ok: true, data: input })}
      />
    </>
  );
}
